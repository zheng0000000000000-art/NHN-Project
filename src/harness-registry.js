import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicWriteJson, HttpError, normalizeRelativePath, nowIso, randomId, readJson, sha256 } from './utils.js';
import { runProcess } from './verifier.js';

const EMPTY_DB = { schemaVersion: 1, harnesses: [] };
const STATUS = new Set(['DRAFT', 'ACTIVE', 'DISABLED']);

export class HarnessRegistry {
  constructor({ dataDirectory, seedProfilePath, workspaceRoot }) {
    this.path = path.join(dataDirectory, 'harnesses.json');
    this.seedProfilePath = seedProfilePath;
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.lock = Promise.resolve();
  }

  async initialize() {
    await this.#withLock(async () => {
      const db = await readJson(this.path, EMPTY_DB);
      if (!Array.isArray(db.harnesses)) throw new Error('Invalid harness registry.');
      const seeds = await readJson(this.seedProfilePath, { schemaVersion: 1, profiles: {} });
      const existing = new Set(db.harnesses.map((item) => item.id));
      for (const [id, profile] of Object.entries(seeds.profiles ?? {})) {
        if (existing.has(id)) continue;
        const createdAt = nowIso();
        const harness = {
          id,
          label: String(profile.label ?? id),
          description: String(profile.description ?? ''),
          status: 'ACTIVE',
          source: 'BUILTIN',
          version: 1,
          commands: normalizeCommands(profile.commands ?? []),
          fixtureCandidates: [],
          createdByUserId: null,
          createdAt,
          updatedAt: createdAt,
          lastTest: null,
        };
        harness.definitionSha256 = definitionHash(harness);
        db.harnesses.push(harness);
      }
      db.harnesses.sort((a, b) => a.id.localeCompare(b.id));
      await atomicWriteJson(this.path, db);
    });
  }

  async list({ includeDisabled = true } = {}) {
    const db = await readJson(this.path, EMPTY_DB);
    return db.harnesses
      .filter((item) => includeDisabled || item.status === 'ACTIVE')
      .map((item) => structuredClone(item))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async get(id) {
    const db = await readJson(this.path, EMPTY_DB);
    const harness = db.harnesses.find((item) => item.id === id);
    return harness ? structuredClone(harness) : null;
  }

  async activeIds() {
    return (await this.list({ includeDisabled: false })).map((item) => item.id);
  }

  async publicProfiles() {
    const active = await this.list({ includeDisabled: false });
    return Object.fromEntries(active.map((item) => [item.id, {
      id: item.id,
      label: item.label,
      description: item.description,
      commandCount: item.commands.length,
      version: item.version,
      source: item.source,
    }]));
  }

  async resolveActive(id) {
    const harness = await this.get(id);
    if (!harness) throw new HttpError(400, `Harness not found: ${id}`);
    if (harness.status !== 'ACTIVE') throw new HttpError(409, `Harness is not active: ${id}`);
    return harness;
  }

  async create(actor, input) {
    const candidate = normalizeDefinition(input, actor.id);
    return this.#withLock(async () => {
      const db = await readJson(this.path, EMPTY_DB);
      if (db.harnesses.some((item) => item.id === candidate.id)) throw new HttpError(409, 'Harness ID already exists.');
      db.harnesses.push(candidate);
      db.harnesses.sort((a, b) => a.id.localeCompare(b.id));
      await atomicWriteJson(this.path, db);
      return structuredClone(candidate);
    });
  }

  async createFromFailures(actor, input, failureCases) {
    if (!Array.isArray(failureCases) || failureCases.length === 0) {
      throw new HttpError(400, 'At least one failure case is required.');
    }
    const commands = commandsFromFailures(failureCases);
    if (commands.length === 0) {
      throw new HttpError(409, 'The selected failures do not contain executable command evidence. Use a skill rule for scope-only or non-command failures.');
    }
    return this.create(actor, {
      id: input.id,
      label: input.label ?? input.id,
      description: input.description ?? `Regression harness derived from ${failureCases.length} failure case(s).`,
      commands,
      source: 'FAILURE_DERIVED',
      sourceFailureCaseIds: failureCases.map((item) => item.id),
    });
  }

  async update(id, actor, expectedVersion, input) {
    return this.#withLock(async () => {
      const db = await readJson(this.path, EMPTY_DB);
      const index = db.harnesses.findIndex((item) => item.id === id);
      if (index === -1) throw new HttpError(404, 'Harness not found.');
      const current = db.harnesses[index];
      if (current.source === 'BUILTIN') throw new HttpError(409, 'Built-in harness definitions are immutable. Create a new harness instead.');
      if (Number(expectedVersion) !== current.version) throw new HttpError(409, 'Harness changed. Refresh and try again.', { currentVersion: current.version });
      const next = normalizeDefinition({
        ...input,
        id,
        source: current.source,
        sourceFailureCaseIds: current.sourceFailureCaseIds ?? [],
      }, current.createdByUserId ?? actor.id, current.createdAt);
      next.version = current.version + 1;
      next.fixtureCandidates = current.fixtureCandidates ?? [];
      next.status = 'DRAFT';
      next.lastTest = null;
      next.updatedAt = nowIso();
      next.definitionSha256 = definitionHash(next);
      db.harnesses[index] = next;
      await atomicWriteJson(this.path, db);
      return structuredClone(next);
    });
  }

  async test(id, actorUserId) {
    const harness = await this.get(id);
    if (!harness) throw new HttpError(404, 'Harness not found.');
    const startedAt = nowIso();
    const checks = [];
    for (const command of harness.commands) {
      const cwd = resolveWorkspaceCwd(this.workspaceRoot, command.cwd);
      const result = await runProcess({
        file: command.file,
        args: command.args,
        cwd,
        expectedExit: command.expectedExit,
        timeoutMs: command.timeoutMs,
      });
      checks.push(compactCheck(result, command.cwd));
    }
    const lastTest = {
      testId: randomId('ht_'),
      definitionSha256: harness.definitionSha256,
      passed: checks.every((item) => item.passed),
      startedAt,
      finishedAt: nowIso(),
      testedByUserId: actorUserId,
      checks,
    };
    const updated = await this.#withLock(async () => {
      const db = await readJson(this.path, EMPTY_DB);
      const index = db.harnesses.findIndex((item) => item.id === id);
      if (index === -1) throw new HttpError(404, 'Harness not found.');
      if (db.harnesses[index].definitionSha256 !== harness.definitionSha256) throw new HttpError(409, 'Harness changed while the test was running.');
      db.harnesses[index].lastTest = lastTest;
      db.harnesses[index].updatedAt = nowIso();
      await atomicWriteJson(this.path, db);
      return structuredClone(db.harnesses[index]);
    });
    return { harness: updated, test: lastTest };
  }

  async setStatus(id, actorUserId, expectedVersion, status) {
    if (!STATUS.has(status)) throw new HttpError(400, 'Invalid harness status.');
    return this.#withLock(async () => {
      const db = await readJson(this.path, EMPTY_DB);
      const index = db.harnesses.findIndex((item) => item.id === id);
      if (index === -1) throw new HttpError(404, 'Harness not found.');
      const current = db.harnesses[index];
      if (Number(expectedVersion) !== current.version) throw new HttpError(409, 'Harness changed. Refresh and try again.', { currentVersion: current.version });
      if (status === 'ACTIVE') {
        if (!current.lastTest?.passed || current.lastTest.definitionSha256 !== current.definitionSha256) {
          throw new HttpError(409, 'The current harness definition must pass a test before activation.');
        }
      }
      current.status = status;
      current.version += 1;
      current.updatedAt = nowIso();
      current.statusChangedByUserId = actorUserId;
      await atomicWriteJson(this.path, db);
      return structuredClone(current);
    });
  }

  async addFixtureCandidate(harnessId, failureCase, actorUserId) {
    return this.#withLock(async () => {
      const db = await readJson(this.path, EMPTY_DB);
      const index = db.harnesses.findIndex((item) => item.id === harnessId);
      if (index === -1) throw new HttpError(404, 'Harness not found.');
      const harness = db.harnesses[index];
      harness.fixtureCandidates = harness.fixtureCandidates ?? [];
      const existing = harness.fixtureCandidates.find((item) => item.sourceFailureCaseId === failureCase.id);
      if (existing) return structuredClone(existing);
      const candidate = {
        id: randomId('fxc_'),
        name: `${failureCase.kind.toLowerCase()}-${failureCase.id.slice(-8)}`,
        status: 'DRAFT',
        sourceFailureCaseId: failureCase.id,
        failureSignatureSha256: failureCase.signatureSha256,
        expectedAfterFix: 'PASS',
        replayReady: false,
        replayBlocker: 'Fixture files or deterministic setup steps have not been supplied.',
        createdByUserId: actorUserId,
        createdAt: nowIso(),
      };
      harness.fixtureCandidates.push(candidate);
      harness.version += 1;
      harness.updatedAt = nowIso();
      await atomicWriteJson(this.path, db);
      return structuredClone(candidate);
    });
  }

  #withLock(work) {
    const result = this.lock.then(work, work);
    this.lock = result.catch(() => {});
    return result;
  }
}

function normalizeDefinition(input, actorUserId, createdAt = nowIso()) {
  const id = String(input.id ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(id)) throw new HttpError(400, 'Harness ID must be 3-64 lowercase letters, numbers, or hyphens.');
  const label = String(input.label ?? '').trim();
  if (label.length < 3 || label.length > 120) throw new HttpError(400, 'Harness label must be 3-120 characters.');
  const harness = {
    id,
    label,
    description: String(input.description ?? '').trim().slice(0, 2000),
    status: 'DRAFT',
    source: input.source === 'FAILURE_DERIVED' ? 'FAILURE_DERIVED' : 'USER',
    version: 1,
    commands: normalizeCommands(input.commands),
    sourceFailureCaseIds: [...new Set((Array.isArray(input.sourceFailureCaseIds) ? input.sourceFailureCaseIds : []).map((item) => String(item).trim()).filter(Boolean))].sort(),
    fixtureCandidates: [],
    createdByUserId: actorUserId,
    createdAt,
    updatedAt: nowIso(),
    lastTest: null,
  };
  harness.definitionSha256 = definitionHash(harness);
  return harness;
}

function normalizeCommands(commands) {
  if (!Array.isArray(commands) || commands.length === 0 || commands.length > 20) throw new HttpError(400, 'Harness must contain 1-20 commands.');
  return commands.map((command, index) => {
    if (!command || typeof command !== 'object' || Array.isArray(command)) throw new HttpError(400, `Command ${index + 1} must be an object.`);
    const file = String(command.file ?? '').trim();
    if (!file || file.length > 300) throw new HttpError(400, `Command ${index + 1} file is required.`);
    const args = Array.isArray(command.args) ? command.args.map((item) => String(item)) : [];
    if (args.length > 100 || args.some((item) => item.length > 2000)) throw new HttpError(400, `Command ${index + 1} arguments are too large.`);
    const expectedExit = Number.isInteger(command.expectedExit) ? command.expectedExit : 0;
    const timeoutMs = Number.isFinite(Number(command.timeoutMs)) ? Number(command.timeoutMs) : 120_000;
    if (timeoutMs < 100 || timeoutMs > 1_800_000) throw new HttpError(400, `Command ${index + 1} timeout must be 100-1800000ms.`);
    const cwd = normalizeCwd(command.cwd ?? '.');
    return { file, args, cwd, expectedExit, timeoutMs };
  });
}

function normalizeCwd(value) {
  const raw = String(value ?? '.').trim() || '.';
  if (path.isAbsolute(raw)) throw new HttpError(400, 'Harness command cwd must be relative to the workspace.');
  const normalized = normalizeRelativePath(raw) || '.';
  if (normalized === '..' || normalized.startsWith('../')) throw new HttpError(400, 'Harness command cwd cannot escape the workspace.');
  return normalized;
}

function resolveWorkspaceCwd(root, relative) {
  const resolved = path.resolve(root, relative === '.' ? '' : relative);
  const prefix = `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(prefix)) throw new HttpError(400, 'Harness command cwd escapes the workspace.');
  return resolved;
}

function definitionHash(harness) {
  return sha256(JSON.stringify({
    id: harness.id,
    label: harness.label,
    description: harness.description,
    commands: harness.commands,
    sourceFailureCaseIds: harness.sourceFailureCaseIds ?? [],
  }));
}

function commandsFromFailures(failureCases) {
  const seen = new Set();
  const commands = [];
  for (const failure of failureCases) {
    const evidence = failure?.lastEvidence ?? {};
    const file = String(evidence.file ?? '').trim();
    if (!file) continue;
    const command = {
      file,
      args: Array.isArray(evidence.args) ? evidence.args.map((item) => String(item)) : [],
      cwd: evidence.cwd ?? '.',
      expectedExit: Number.isInteger(evidence.expectedExit) ? evidence.expectedExit : 0,
      timeoutMs: Number.isFinite(Number(evidence.timeoutMs)) ? Number(evidence.timeoutMs) : 120000,
    };
    const key = JSON.stringify(command);
    if (seen.has(key)) continue;
    seen.add(key);
    commands.push(command);
  }
  return commands;
}

function compactCheck(result, cwd) {
  return {
    file: result.file,
    args: result.args,
    cwd,
    expectedExit: result.expectedExit,
    actualExit: result.actualExit,
    timedOut: result.timedOut,
    spawnError: Boolean(result.spawnError),
    passed: result.passed,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    stdoutSha256: sha256(result.stdout),
    stderrSha256: sha256(result.stderr),
    stdoutTail: result.stdout.slice(-4000),
    stderrTail: result.stderr.slice(-4000),
  };
}
