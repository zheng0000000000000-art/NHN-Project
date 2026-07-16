import path from 'node:path';
import { atomicWriteJson, HttpError, nowIso, randomId, readJson, sha256 } from './utils.js';

const EMPTY_DB = { schemaVersion: 1, cases: [] };
const STATUSES = new Set(['OPEN', 'FIXTURE_CANDIDATE', 'RESOLVED', 'IGNORED']);

export class FailureCaseStore {
  constructor(dataDirectory) {
    this.path = path.join(dataDirectory, 'failure-cases.json');
    this.lock = Promise.resolve();
  }

  async initialize() {
    await this.#withLock(async () => {
      const db = await readJson(this.path, EMPTY_DB);
      if (!Array.isArray(db.cases)) throw new Error('Invalid failure case store.');
      await atomicWriteJson(this.path, db);
    });
  }

  async list({ status, harnessId, limit = 200 } = {}) {
    const db = await readJson(this.path, EMPTY_DB);
    return db.cases
      .filter((item) => !status || item.status === status)
      .filter((item) => !harnessId || item.harnessId === harnessId)
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .slice(0, Math.max(1, Math.min(1000, Number(limit) || 200)))
      .map((item) => structuredClone(item));
  }

  async get(id) {
    const db = await readJson(this.path, EMPTY_DB);
    const item = db.cases.find((entry) => entry.id === id);
    return item ? structuredClone(item) : null;
  }

  async summary() {
    const cases = await this.list({ limit: 1000 });
    return {
      total: cases.length,
      open: cases.filter((item) => item.status === 'OPEN').length,
      fixtureCandidates: cases.filter((item) => item.status === 'FIXTURE_CANDIDATE').length,
      resolved: cases.filter((item) => item.status === 'RESOLVED').length,
      ignored: cases.filter((item) => item.status === 'IGNORED').length,
      occurrences: cases.reduce((sum, item) => sum + item.occurrences, 0),
    };
  }

  async recordVerification({ task, verification, actorUserId }) {
    const observations = buildVerificationFailures(task, verification);
    const recorded = [];
    for (const observation of observations) recorded.push(await this.#record(observation, actorUserId));
    return recorded;
  }

  async recordHarnessTest({ harness, test, actorUserId }) {
    const task = { id: null, title: `Harness test: ${harness.id}`, verificationProfile: harness.id };
    const verification = { ...test, profile: harness.id, status: test.passed ? 'PASSED' : 'FAILED', passed: test.passed, scopeViolations: [], changedPaths: [] };
    return this.recordVerification({ task, verification, actorUserId });
  }

  async setStatus(id, actorUserId, status, note = '') {
    if (!STATUSES.has(status)) throw new HttpError(400, 'Invalid failure status.');
    return this.#withLock(async () => {
      const db = await readJson(this.path, EMPTY_DB);
      const item = db.cases.find((entry) => entry.id === id);
      if (!item) throw new HttpError(404, 'Failure case not found.');
      item.status = status;
      item.statusNote = String(note ?? '').trim().slice(0, 2000);
      item.statusChangedByUserId = actorUserId;
      item.statusChangedAt = nowIso();
      await atomicWriteJson(this.path, db);
      return structuredClone(item);
    });
  }

  async linkFixtureCandidate(id, actorUserId, fixtureCandidateId) {
    return this.#withLock(async () => {
      const db = await readJson(this.path, EMPTY_DB);
      const item = db.cases.find((entry) => entry.id === id);
      if (!item) throw new HttpError(404, 'Failure case not found.');
      item.status = 'FIXTURE_CANDIDATE';
      item.fixtureCandidateId = fixtureCandidateId;
      item.statusChangedByUserId = actorUserId;
      item.statusChangedAt = nowIso();
      await atomicWriteJson(this.path, db);
      return structuredClone(item);
    });
  }

  async linkLearningArtifact(id, actorUserId, artifact) {
    return this.#withLock(async () => {
      const db = await readJson(this.path, EMPTY_DB);
      const item = db.cases.find((entry) => entry.id === id);
      if (!item) throw new HttpError(404, 'Failure case not found.');
      item.learningArtifacts = Array.isArray(item.learningArtifacts) ? item.learningArtifacts : [];
      const normalized = {
        type: String(artifact.type ?? '').toUpperCase(),
        id: String(artifact.id ?? ''),
        version: Number(artifact.version) || 1,
        linkedByUserId: actorUserId,
        linkedAt: nowIso(),
      };
      const existing = item.learningArtifacts.find((entry) => entry.type === normalized.type && entry.id === normalized.id);
      if (existing) Object.assign(existing, normalized);
      else item.learningArtifacts.push(normalized);
      await atomicWriteJson(this.path, db);
      return structuredClone(item);
    });
  }

  async #record(observation, actorUserId) {
    return this.#withLock(async () => {
      const db = await readJson(this.path, EMPTY_DB);
      const existing = db.cases.find((item) => item.signatureSha256 === observation.signatureSha256);
      const at = nowIso();
      if (existing) {
        existing.occurrences += 1;
        existing.lastSeenAt = at;
        existing.lastSeenByUserId = actorUserId;
        existing.lastEvidence = observation.lastEvidence;
        existing.taskIds = [...new Set([...(existing.taskIds ?? []), ...(observation.taskIds ?? [])])].filter(Boolean).slice(-50);
        if (existing.status === 'RESOLVED') {
          existing.status = 'OPEN';
          existing.reopenedAt = at;
        }
        await atomicWriteJson(this.path, db);
        return structuredClone(existing);
      }
      const item = {
        id: randomId('fail_'),
        status: 'OPEN',
        occurrences: 1,
        firstSeenAt: at,
        lastSeenAt: at,
        firstSeenByUserId: actorUserId,
        lastSeenByUserId: actorUserId,
        ...observation,
      };
      db.cases.push(item);
      await atomicWriteJson(this.path, db);
      return structuredClone(item);
    });
  }

  #withLock(work) {
    const result = this.lock.then(work, work);
    this.lock = result.catch(() => {});
    return result;
  }
}

function buildVerificationFailures(task, verification) {
  const harnessId = verification.profile ?? task.verificationProfile ?? 'unknown';
  const taskIds = task.id ? [task.id] : [];
  const output = [];
  if (verification.error || verification.status === 'ERROR') {
    output.push(makeCase({
      harnessId,
      kind: 'VERIFICATION_ERROR',
      title: verification.error || 'Verification failed before checks completed.',
      taskIds,
      identity: { harnessId, kind: 'VERIFICATION_ERROR', error: String(verification.error ?? '') },
      evidence: { error: verification.error, startedAt: verification.startedAt, finishedAt: verification.finishedAt },
    }));
  }
  for (const [index, check] of (verification.checks ?? []).entries()) {
    if (check.passed) continue;
    const kind = check.timedOut ? 'TIMEOUT' : check.spawnError ? 'SPAWN_ERROR' : 'EXIT_MISMATCH';
    output.push(makeCase({
      harnessId,
      kind,
      title: `${check.file} ${check.args?.join(' ') ?? ''}`.trim(),
      taskIds,
      identity: {
        harnessId,
        kind,
        commandIndex: index,
        file: check.file,
        args: check.args ?? [],
        cwd: check.cwd ?? '.',
        expectedExit: check.expectedExit,
      },
      evidence: compactEvidence(check, verification),
    }));
  }
  const scopeViolations = [...new Set((verification.scopeViolations ?? []).map((item) => String(item).trim()).filter(Boolean))].sort();
  if (scopeViolations.length) {
    output.push(makeCase({
      harnessId,
      kind: 'SCOPE_VIOLATION',
      title: scopeViolations.length === 1 ? scopeViolations[0] : `${scopeViolations.length} paths outside allowed scope`,
      taskIds,
      identity: { harnessId, kind: 'SCOPE_VIOLATION', paths: scopeViolations },
      evidence: {
        path: scopeViolations[0],
        paths: scopeViolations,
        changedPaths: verification.changedPaths ?? [],
        workspaceFingerprint: verification.workspaceFingerprint,
      },
    }));
  }
  return output;
}

function makeCase({ harnessId, kind, title, taskIds, identity, evidence }) {
  return {
    harnessId,
    kind,
    title,
    taskIds,
    signatureSha256: sha256(JSON.stringify(identity)),
    identity,
    lastEvidence: evidence,
  };
}

function compactEvidence(check, verification) {
  const stdout = String(check.stdout ?? check.stdoutTail ?? '');
  const stderr = String(check.stderr ?? check.stderrTail ?? '');
  return {
    file: check.file,
    args: check.args ?? [],
    cwd: check.cwd ?? '.',
    expectedExit: check.expectedExit,
    actualExit: check.actualExit,
    timedOut: Boolean(check.timedOut),
    spawnError: Boolean(check.spawnError),
    stdoutSha256: check.stdoutSha256 ?? sha256(stdout),
    stderrSha256: check.stderrSha256 ?? sha256(stderr),
    stdoutTail: stdout.slice(-4000),
    stderrTail: stderr.slice(-4000),
    startedAt: check.startedAt,
    finishedAt: check.finishedAt,
    workspaceFingerprint: verification.workspaceFingerprint,
  };
}
