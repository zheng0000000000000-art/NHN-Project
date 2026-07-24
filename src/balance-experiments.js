import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { atomicWriteJson, HttpError, nowIso, randomId, readJson } from './utils.js';
import { projectBalanceExperiment } from './balance-result-view.js';

const EMPTY_LEGACY = { schemaVersion: 1, experiments: [] };
const EMPTY_INDEX = { schemaVersion: 2, experiments: [] };

export class BalanceExperimentStore {
  constructor(dataDirectory) {
    this.legacyPath = path.join(dataDirectory, 'balance-experiments.json');
    this.root = path.join(dataDirectory, 'balance-experiments');
    this.indexPath = path.join(this.root, 'index.json');
    this.lock = Promise.resolve();
  }

  async initialize() {
    await this.#withLock(async () => {
      await mkdir(this.root, { recursive: true });
      const existing = await readJson(this.indexPath, null);
      if (existing) {
        validateIndex(existing);
        return;
      }
      const legacy = await readJson(this.legacyPath, EMPTY_LEGACY);
      if (!Array.isArray(legacy.experiments)) throw new Error('Invalid legacy balance experiment store.');
      const index = structuredClone(EMPTY_INDEX);
      for (const experiment of legacy.experiments.slice(0, 100)) {
        await this.#writeExperiment(experiment);
        index.experiments.push(indexEntry(experiment));
      }
      await atomicWriteJson(this.indexPath, index);
    });
  }

  async list({ limit = 30, actorUserId = null, detail = 'full' } = {}) {
    const index = await this.#readIndex();
    const entries = index.experiments
      .filter((item) => !actorUserId || item.actorUserId === actorUserId)
      .slice(0, Math.max(1, Math.min(100, Number(limit) || 30)));
    return Promise.all(entries.map((entry) => detail === 'summary'
      ? readJson(path.join(this.root, safeExperimentId(entry.id), 'summary.json'), null)
      : this.#readExperiment(entry.id)));
  }

  async get(id, { actorUserId = null, actorRole = 'member' } = {}) {
    const experiment = await this.#readExperiment(id);
    if (actorUserId && experiment.actorUserId !== actorUserId && actorRole !== 'admin') {
      throw new HttpError(403, 'Only the experiment owner or an admin can read it.');
    }
    return experiment;
  }

  async record(actor, request, result) {
    const experiment = {
      id: randomId('bal_'),
      title: String(request.title || request.spec?.objective || request.spec?.balanceId || 'Balance experiment').trim().slice(0, 160),
      provider: String(request.provider || 'combat-v1'),
      status: 'PROPOSED',
      actorUserId: actor.id,
      request: structuredClone(request),
      result: structuredClone(result),
      createdAt: nowIso(),
      appliedAt: null,
      appliedByUserId: null,
    };
    return this.#withLock(async () => {
      const index = await this.#readIndex();
      await this.#writeExperiment(experiment);
      index.experiments.unshift(indexEntry(experiment));
      index.experiments = index.experiments.slice(0, 100);
      await atomicWriteJson(this.indexPath, index);
      return structuredClone(experiment);
    });
  }

  async apply(id, actor) {
    return this.#withLock(async () => {
      const experiment = await this.#readExperiment(id);
      if (experiment.actorUserId !== actor.id && actor.role !== 'admin') throw new HttpError(403, 'Only the experiment owner or an admin can apply it.');
      if (!experiment.result?.candidate?.data) throw new HttpError(409, 'This experiment has no candidate to apply.');
      experiment.status = 'APPLIED';
      experiment.appliedAt = nowIso();
      experiment.appliedByUserId = actor.id;
      await this.#writeExperiment(experiment);
      const index = await this.#readIndex();
      const position = index.experiments.findIndex((item) => item.id === id);
      if (position >= 0) index.experiments[position] = indexEntry(experiment);
      await atomicWriteJson(this.indexPath, index);
      return structuredClone(experiment);
    });
  }

  async #readIndex() {
    const index = await readJson(this.indexPath, EMPTY_INDEX);
    validateIndex(index);
    return index;
  }

  async #readExperiment(id) {
    const safeId = safeExperimentId(id);
    const experiment = await readJson(path.join(this.root, safeId, 'raw.json'), null);
    if (!experiment) throw new HttpError(404, 'Balance experiment not found.');
    return structuredClone(experiment);
  }

  async #writeExperiment(experiment) {
    const safeId = safeExperimentId(experiment.id);
    const directory = path.join(this.root, safeId);
    await mkdir(directory, { recursive: true });
    await Promise.all([
      atomicWriteJson(path.join(directory, 'raw.json'), experiment),
      atomicWriteJson(path.join(directory, 'summary.json'), summaryArtifact(experiment)),
      atomicWriteJson(path.join(directory, 'diagnostics.json'), diagnosticsArtifact(experiment)),
    ]);
  }

  #withLock(work) {
    const result = this.lock.then(work, work);
    this.lock = result.catch(() => {});
    return result;
  }
}

function indexEntry(experiment) {
  return {
    id: experiment.id,
    title: experiment.title,
    provider: experiment.provider,
    status: experiment.status,
    actorUserId: experiment.actorUserId,
    createdAt: experiment.createdAt,
    appliedAt: experiment.appliedAt,
  };
}

function summaryArtifact(experiment) {
  return projectBalanceExperiment(experiment, { view: 'summary' });
}

function diagnosticsArtifact(experiment) {
  const result = experiment.result || {};
  return {
    id: experiment.id,
    spec: result.spec,
    baseline: { statistics: result.baseline?.statistics || result.statistics || {}, diagnostics: result.baseline?.diagnostics || result.diagnostics || {} },
    candidate: result.candidate ? {
      statistics: result.candidate.statistics || {},
      diagnostics: result.candidate.diagnostics || {},
    } : null,
  };
}

function safeExperimentId(value) {
  const id = String(value || '');
  if (!/^bal_[a-zA-Z0-9_-]+$/.test(id)) throw new HttpError(400, 'Invalid balance experiment id.');
  return id;
}

function validateIndex(index) {
  if (index?.schemaVersion !== 2 || !Array.isArray(index.experiments)) throw new Error('Invalid balance experiment index.');
}
