import path from 'node:path';
import { atomicWriteJson, HttpError, nowIso, randomId, readJson } from './utils.js';

const EMPTY_EXPERIMENTS = { schemaVersion: 1, experiments: [] };

export class BalanceExperimentStore {
  constructor(dataDirectory) {
    this.path = path.join(dataDirectory, 'balance-experiments.json');
    this.lock = Promise.resolve();
  }

  async initialize() {
    await this.#withLock(async () => {
      const db = await readJson(this.path, EMPTY_EXPERIMENTS);
      if (!Array.isArray(db.experiments)) throw new Error('Invalid balance experiment store.');
      await atomicWriteJson(this.path, db);
    });
  }

  async list({ limit = 30, actorUserId = null } = {}) {
    const db = await readJson(this.path, EMPTY_EXPERIMENTS);
    return db.experiments
      .filter((item) => !actorUserId || item.actorUserId === actorUserId)
      .slice(0, Math.max(1, Math.min(100, Number(limit) || 30)))
      .map((item) => structuredClone(item));
  }

  async get(id, { actorUserId = null, actorRole = 'member' } = {}) {
    const db = await readJson(this.path, EMPTY_EXPERIMENTS);
    const experiment = db.experiments.find((item) => item.id === id);
    if (!experiment) throw new HttpError(404, 'Balance experiment not found.');
    if (actorUserId && experiment.actorUserId !== actorUserId && actorRole !== 'admin') {
      throw new HttpError(403, 'Only the experiment owner or an admin can read it.');
    }
    return structuredClone(experiment);
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
      const db = await readJson(this.path, EMPTY_EXPERIMENTS);
      db.experiments.unshift(experiment);
      db.experiments = db.experiments.slice(0, 100);
      await atomicWriteJson(this.path, db);
      return structuredClone(experiment);
    });
  }

  async apply(id, actor) {
    return this.#withLock(async () => {
      const db = await readJson(this.path, EMPTY_EXPERIMENTS);
      const experiment = db.experiments.find((item) => item.id === id);
      if (!experiment) throw new HttpError(404, 'Balance experiment not found.');
      if (experiment.actorUserId !== actor.id && actor.role !== 'admin') throw new HttpError(403, 'Only the experiment owner or an admin can apply it.');
      if (!experiment.result?.candidate?.data) throw new HttpError(409, 'This experiment has no candidate to apply.');
      experiment.status = 'APPLIED';
      experiment.appliedAt = nowIso();
      experiment.appliedByUserId = actor.id;
      await atomicWriteJson(this.path, db);
      return structuredClone(experiment);
    });
  }

  #withLock(work) {
    const result = this.lock.then(work, work);
    this.lock = result.catch(() => {});
    return result;
  }
}
