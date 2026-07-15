import path from 'node:path';
import { atomicWriteJson, HttpError, nowIso, readJson, sha256 } from './utils.js';

const EMPTY_DB = { schemaVersion: 1, skills: [] };
const STATUSES = new Set(['DRAFT', 'ACTIVE', 'DISABLED']);

export class SkillRegistry {
  constructor({ dataDirectory }) {
    this.path = path.join(dataDirectory, 'skills.json');
    this.lock = Promise.resolve();
  }

  async initialize() {
    await this.#withLock(async () => {
      const db = await readJson(this.path, EMPTY_DB);
      if (!Array.isArray(db.skills)) throw new Error('Invalid skill registry.');
      await atomicWriteJson(this.path, db);
    });
  }

  async list({ includeDisabled = true } = {}) {
    const db = await readJson(this.path, EMPTY_DB);
    return db.skills
      .filter((item) => includeDisabled || item.status === 'ACTIVE')
      .map((item) => structuredClone(item))
      .sort((a, b) => a.id.localeCompare(b.id));
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
  };
  skill.definitionSha256 = sha256(JSON.stringify({
    id: skill.id,
    label: skill.label,
    description: skill.description,
    rules: skill.rules,
    sourceFailureCaseIds: skill.sourceFailureCaseIds,
  }));
  return skill;
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
