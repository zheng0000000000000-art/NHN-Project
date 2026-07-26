import path from 'node:path';
import { atomicWriteJson, HttpError, nowIso, readJson, sha256 } from './utils.js';
import { inferSkillManifest, normalizeSkillManifest } from './contracts.js';

const EMPTY_DB = { schemaVersion: 1, skills: [] };
const STATUSES = new Set(['DRAFT', 'ACTIVE', 'DISABLED', 'ARCHIVED']);

export class SkillRegistry {
  // workspaceId는 실패에서 승격된 스킬에 소속을 찍는 데 쓴다. 안 찍으면 한 프로젝트의 지식이
  // 전역 규칙이 되어 다른 프로젝트 에이전트에게도 실린다(2026-07-27 관측: 심사 스킬 4개).
  constructor({ dataDirectory, seedSkillPath = null, workspaceId = null }) {
    this.path = path.join(dataDirectory, 'skills.json');
    this.seedSkillPath = seedSkillPath;
    this.workspaceId = workspaceId;
    this.lock = Promise.resolve();
  }

  async initialize() {
    await this.#withLock(async () => {
      const db = await readJson(this.path, EMPTY_DB);
      if (!Array.isArray(db.skills)) throw new Error('Invalid skill registry.');
      for (const skill of db.skills) skill.manifest = inferSkillManifest(skill);
      if (this.seedSkillPath) {
        const seeds = await readJson(this.seedSkillPath, { schemaVersion: 1, skills: {} });
        for (const [id, seed] of Object.entries(seeds.skills ?? {})) {
          upsertBuiltinSkill(db, id, seed);
        }
        db.skills.sort((a, b) => a.id.localeCompare(b.id));
      }
      await atomicWriteJson(this.path, db);
    });
  }

  // 소속(scope)이 없거나 global인 스킬은 모든 workspace에서 보이고,
  // 특정 workspace id를 가진 스킬은 그 workspace에서만 보인다.
  // scope가 없으면 global로 읽는다 — 기존 기록을 한꺼번에 감추지 않기 위해서다.
  static visibleIn(skill, workspaceId) {
    const scope = skill?.scope;
    if (!scope || scope === 'global') return true;
    return workspaceId != null && scope === workspaceId;
  }

  async list({ includeDisabled = true, workspaceId = null } = {}) {
    const db = await readJson(this.path, EMPTY_DB);
    return db.skills
      .filter((item) => includeDisabled || item.status === 'ACTIVE')
      .filter((item) => workspaceId == null || SkillRegistry.visibleIn(item, workspaceId))
      .map((item) => structuredClone(item))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async activeIds() {
    return (await this.list({ includeDisabled: false })).map((item) => item.id);
  }

  async get(id) {
    const db = await readJson(this.path, EMPTY_DB);
    const skill = db.skills.find((item) => item.id === id);
    return skill ? structuredClone(skill) : null;
  }

  async resolveActiveMany(ids = []) {
    const uniqueIds = [...new Set(ids.map((item) => String(item).trim()).filter(Boolean))];
    const db = await readJson(this.path, EMPTY_DB);
    return uniqueIds.map((id) => {
      const skill = db.skills.find((item) => item.id === id);
      if (!skill) throw new HttpError(400, `Skill not found: ${id}`);
      if (skill.status !== 'ACTIVE') throw new HttpError(409, `Skill is not active: ${id}`);
      return structuredClone(skill);
    });
  }

  async createFromFailures(actor, input, failureCases) {
    const skill = normalizeSkill(input, actor.id, failureCases);
    // 실패에서 나온 규칙은 그 실패가 난 곳의 것이다. 전역으로 올리려면 사람이 scope를 바꾼다.
    if (this.workspaceId) skill.scope = this.workspaceId;
    return this.#withLock(async () => {
      const db = await readJson(this.path, EMPTY_DB);
      if (db.skills.some((item) => item.id === skill.id)) throw new HttpError(409, 'Skill ID already exists.');
      db.skills.push(skill);
      db.skills.sort((a, b) => a.id.localeCompare(b.id));
      await atomicWriteJson(this.path, db);
      return structuredClone(skill);
    });
  }

  async setStatus(id, actorUserId, expectedVersion, status) {
    const normalized = String(status ?? '').toUpperCase();
    if (!STATUSES.has(normalized)) throw new HttpError(400, 'Invalid skill status.');
    return this.#withLock(async () => {
      const db = await readJson(this.path, EMPTY_DB);
      const index = db.skills.findIndex((item) => item.id === id);
      if (index === -1) throw new HttpError(404, 'Skill not found.');
      const current = db.skills[index];
      if (Number(expectedVersion) !== current.version) {
        throw new HttpError(409, 'Skill changed. Refresh and try again.', { currentVersion: current.version });
      }
      if (normalized === 'ACTIVE' && current.rules.length === 0) throw new HttpError(409, 'A skill without rules cannot be activated.');
      current.status = normalized;
      current.version += 1;
      current.updatedAt = nowIso();
      current.statusChangedByUserId = actorUserId;
      db.skills[index] = current;
      await atomicWriteJson(this.path, db);
      return structuredClone(current);
    });
  }

  #withLock(work) {
    const result = this.lock.then(work, work);
    this.lock = result.catch(() => {});
    return result;
  }
}

function upsertBuiltinSkill(db, id, seed) {
  const at = nowIso();
  const index = db.skills.findIndex((item) => item.id === id);
  const current = index === -1 ? null : db.skills[index];
  if (current && !['BUILTIN', 'IMPORTED_LOCAL_SKILL'].includes(current.source)) return;

  const skill = {
    id,
    label: String(seed.label ?? id).trim(),
    description: String(seed.description ?? '').trim(),
    status: 'ACTIVE',
    source: 'BUILTIN',
    version: current?.version ?? 1,
    rules: Array.isArray(seed.rules)
      ? [...new Set(seed.rules.map((item) => String(item).trim()).filter(Boolean))].slice(0, 40)
      : [],
    sourceFailureCaseIds: [],
    // 씨드는 저장소에 추적되는 공용 규칙이므로 전역이다.
    scope: 'global',
    createdByUserId: current?.createdByUserId ?? null,
    createdAt: current?.createdAt ?? at,
    updatedAt: current?.updatedAt ?? at,
    statusChangedByUserId: current?.statusChangedByUserId ?? null,
    manifest: inferSkillManifest({ ...current, ...seed, source: 'BUILTIN', manifest: seed.manifest ?? current?.manifest }),
  };
  skill.definitionSha256 = skillDefinitionHash(skill);
  if (index === -1) db.skills.push(skill);
  else db.skills[index] = skill;
}

function normalizeSkill(input, actorUserId, failureCases) {
  const id = String(input.id ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(id)) throw new HttpError(400, 'Skill ID must be 3-64 lowercase letters, numbers, or hyphens.');
  const label = String(input.label ?? id).trim();
  if (label.length < 3 || label.length > 120) throw new HttpError(400, 'Skill label must be 3-120 characters.');
  if (!Array.isArray(failureCases) || failureCases.length === 0) throw new HttpError(400, 'At least one failure case is required.');

  const suppliedRules = Array.isArray(input.rules) ? input.rules : [];
  const generatedRules = failureCases.map(ruleFromFailure).filter(Boolean);
  const rules = [...new Set([...suppliedRules, ...generatedRules]
    .map((item) => String(item).trim().slice(0, 1200))
    .filter(Boolean))].slice(0, 40);
  if (rules.length === 0) throw new HttpError(400, 'No skill rule could be produced from the selected failures.');

  const at = nowIso();
  const skill = {
    id,
    label,
    description: String(input.description ?? `Failure-derived rules from ${failureCases.length} case(s).`).trim().slice(0, 2000),
    status: 'DRAFT',
    source: 'FAILURE_DERIVED',
    version: 1,
    rules,
    sourceFailureCaseIds: [...new Set(failureCases.map((item) => item.id))].sort(),
    createdByUserId: actorUserId,
    createdAt: at,
    updatedAt: at,
    manifest: normalizeSkillManifest(input.manifest || {}, {
      skillType: 'assisted',
      automationLevel: 6,
      humanApprovalPoints: ['Review the failure-derived rule before it changes future agent behavior.'],
      sideEffectScope: [],
      requiredCapabilities: ['Read linked failure evidence and report skill outcomes.'],
    }),
  };
  skill.definitionSha256 = skillDefinitionHash(skill);
  return skill;
}

function skillDefinitionHash(skill) {
  return sha256(JSON.stringify({
    id: skill.id,
    label: skill.label,
    description: skill.description,
    rules: skill.rules,
    sourceFailureCaseIds: skill.sourceFailureCaseIds,
    manifest: skill.manifest,
  }));
}

export function ruleFromFailure(failure) {
  const evidence = failure?.lastEvidence ?? {};
  const command = [evidence.file, ...(evidence.args ?? [])].filter(Boolean).join(' ').trim();
  switch (failure?.kind) {
    case 'SCOPE_VIOLATION':
      return `작업의 allowedPaths 밖인 \`${evidence.path || failure.title}\` 경로를 수정하지 않는다. 완료 전 변경 경로를 다시 확인한다.`;
    case 'TIMEOUT':
      return `완료 전에 \`${command || failure.title}\` 검증을 실행하고 제한 시간 안에 종료되는지 확인한다.`;
    case 'SPAWN_ERROR':
      return `\`${command || failure.title}\` 검증 명령이 현재 환경에서 실제로 실행 가능한지 먼저 확인하고, 실행 불가 상태에서 완료를 보고하지 않는다.`;
    case 'EXIT_MISMATCH':
      return `완료 전에 \`${command || failure.title}\`를 실행해 exit code가 ${Number.isInteger(evidence.expectedExit) ? evidence.expectedExit : 0}인지 확인하고, 다르면 원인을 수정한다.`;
    case 'VERIFICATION_ERROR':
      return `\`${failure.harnessId || 'verification'}\` 검증 자체가 오류 없이 끝나는지 확인한 뒤 완료를 보고한다.`;
    default:
      return `과거 실패 \`${failure?.title || failure?.id}\`가 재발하지 않도록 관련 검증과 변경 범위를 완료 전에 확인한다.`;
  }
}
