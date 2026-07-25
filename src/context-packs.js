import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicWriteJson, HttpError, nowIso, randomId, readJson, sha256 } from './utils.js';

const EMPTY_PACKS = { schemaVersion: 1, packs: [] };

export class ContextSeedRegistry {
  constructor(manifestPath) {
    this.manifestPath = manifestPath;
    this.seeds = [];
  }

  async initialize() {
    const manifest = await readJson(this.manifestPath, { schemaVersion: 1, seeds: [] });
    if (!Array.isArray(manifest.seeds)) throw new Error('Invalid context seed manifest.');
    this.seeds = manifest.seeds.map((item) => normalizeSeed(item));
  }

  list() {
    return this.seeds.map((item) => structuredClone(item));
  }

  get(id) {
    const seed = this.seeds.find((item) => item.id === id);
    return seed ? structuredClone(seed) : null;
  }
}

export class ContextPackStore {
  constructor({ dataDirectory, workspaceRoot }) {
    this.path = path.join(dataDirectory, 'context-packs.json');
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.lock = Promise.resolve();
  }

  async initialize() {
    await this.#withLock(async () => {
      const db = await readJson(this.path, EMPTY_PACKS);
      if (!Array.isArray(db.packs)) throw new Error('Invalid context pack store.');
      await atomicWriteJson(this.path, db);
    });
  }

  async list(actorUserId, { limit = 30 } = {}) {
    const db = await readJson(this.path, EMPTY_PACKS);
    return db.packs.filter((item) => item.actorUserId === actorUserId)
      .slice(0, Math.max(1, Math.min(100, Number(limit) || 30)))
      .map((item) => summary(item));
  }

  async get(id, actor) {
    const db = await readJson(this.path, EMPTY_PACKS);
    const pack = db.packs.find((item) => item.id === id);
    authorize(pack, actor);
    return structuredClone(pack);
  }

  async record(actor, seed, pack, budgetIncrease = null) {
    const rationale = String(budgetIncrease?.rationale || '').trim();
    if (budgetIncrease && !rationale) throw new HttpError(400, 'Increasing a context budget requires a rationale.');
    const record = {
      id: randomId('ctx_'),
      actorUserId: actor.id,
      seedId: seed.id,
      seed: structuredClone(seed),
      status: 'DRAFT',
      pack: structuredClone(pack),
      budgetRationale: rationale || null,
      receipt: null,
      createdAt: nowIso(),
      lockedAt: null,
    };
    return this.#withLock(async () => {
      const db = await readJson(this.path, EMPTY_PACKS);
      db.packs.unshift(record);
      db.packs = db.packs.slice(0, 100);
      await atomicWriteJson(this.path, db);
      return structuredClone(record);
    });
  }

  async lockPack(id, actor) {
    return this.#withLock(async () => {
      const db = await readJson(this.path, EMPTY_PACKS);
      const record = db.packs.find((item) => item.id === id);
      authorize(record, actor);
      const receipt = await buildReceipt(record, this.workspaceRoot);
      if (receipt.integrity.failures.length) throw new HttpError(409, 'Context pack contains missing or stale inputs.', { receipt });
      record.status = 'LOCKED';
      record.lockedAt = nowIso();
      record.receipt = receipt;
      await atomicWriteJson(this.path, db);
      return structuredClone(record);
    });
  }

  #withLock(work) {
    const result = this.lock.then(work, work);
    this.lock = result.catch(() => {});
    return result;
  }
}

function normalizeSeed(input) {
  const id = String(input?.id || '').trim();
  if (!id) throw new Error('Context seed id is required.');
  return {
    id,
    label: String(input.label || id),
    description: String(input.description || ''),
    maxSourceChunks: clamp(input.maxSourceChunks, 1, 12, 6),
    maxSourceCharacters: clamp(input.maxSourceCharacters, 1000, 24000, 9000),
    maxWikiEntries: clamp(input.maxWikiEntries, 1, 20, 8),
    forbiddenActions: stringList(input.forbiddenActions, 50),
    layers: stringList(input.layers, 10),
  };
}

async function buildReceipt(record, workspaceRoot) {
  const required = record.pack.contract.requiredInputs || [];
  const failures = [];
  const requiredInputs = [];
  for (const input of required) {
    const absolute = resolveInside(workspaceRoot, input.path);
    const bytes = await readFile(absolute).catch(() => null);
    const actualSha256 = bytes ? sha256(bytes) : null;
    if (!bytes) failures.push({ path: input.path, reason: 'missing' });
    else if (actualSha256 !== input.sha256) failures.push({ path: input.path, reason: 'stale', expectedSha256: input.sha256, actualSha256 });
    const segments = (record.pack.sources?.sources || []).filter((item) => item.path === input.path);
    requiredInputs.push({
      path: input.path,
      declaredSha256: input.sha256,
      actualSha256,
      verified: actualSha256 === input.sha256,
      loaded: segments.length > 0,
      includedInModelRequest: segments.length > 0,
      requestSegmentSha256: segments.length ? sha256(segments.map((item) => item.text).join('\n')) : null,
      includedRanges: segments.map((item) => `chunk:${item.chunk}`),
    });
  }
  const sourceCharacters = record.pack.sources?.characters || 0;
  const budgetCharacters = record.pack.sources?.budgetCharacters || record.seed.maxSourceCharacters;
  return {
    schemaVersion: 1,
    kind: 'team-loop-context-receipt',
    receiptId: randomId('rcpt_'),
    packId: record.pack.contract.packId,
    createdAt: nowIso(),
    stages: { declared: true, verified: failures.length === 0, loaded: true, serialized: true, transported: false },
    requiredInputs,
    integrity: { ok: failures.length === 0, failures },
    budget: {
      sourceCharacters,
      estimatedTokens: record.pack.sources?.estimatedTokens || Math.ceil(sourceCharacters / 4),
      maximumCharacters: budgetCharacters,
      utilization: sourceCharacters / Math.max(1, budgetCharacters),
      exceeded: sourceCharacters > budgetCharacters,
      exceptionReason: null,
    },
  };
}

function summary(record) {
  return {
    id: record.id,
    seedId: record.seedId,
    seedLabel: record.seed.label,
    status: record.status,
    goal: record.pack.goal,
    sourceCount: record.pack.sources?.sourceCount || 0,
    estimatedTokens: record.pack.sources?.estimatedTokens || 0,
    integrityOk: record.receipt?.integrity?.ok ?? null,
    budgetRationale: record.budgetRationale || null,
    createdAt: record.createdAt,
    lockedAt: record.lockedAt,
  };
}

function authorize(record, actor) {
  if (!record) throw new HttpError(404, 'Context pack not found.');
  if (record.actorUserId !== actor.id && actor.role !== 'admin') throw new HttpError(403, 'Context pack is private to its owner.');
}

function resolveInside(root, candidate) {
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new HttpError(400, `Path escapes workspace: ${candidate}`);
  return resolved;
}

function stringList(value, maximum) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item).trim()).filter(Boolean))].slice(0, maximum);
}

function clamp(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}
