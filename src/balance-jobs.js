import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { atomicWriteJson, nowIso, randomId, readJson, HttpError } from './utils.js';

export class BalanceJobManager {
  constructor({ dataDirectory, onComplete }) {
    this.onComplete = onComplete;
    this.path = path.join(dataDirectory, 'balance-jobs.json');
    this.jobs = new Map();
    this.persistLock = Promise.resolve();
  }

  async initialize() {
    const db = await readJson(this.path, { schemaVersion: 1, jobs: [] });
    for (const saved of db.jobs || []) {
      const job = { ...saved, worker: null };
      if (['QUEUED', 'RUNNING'].includes(job.status)) {
        job.status = 'INTERRUPTED';
        job.progress = { ...job.progress, phase: 'INTERRUPTED' };
      }
      this.jobs.set(job.id, job);
    }
    await this.#persist();
  }

  async start({ actor, request }) {
    const id = randomId('baljob_');
    const job = {
      id,
      actorUserId: actor.id,
      actorRole: actor.role,
      status: 'QUEUED',
      progress: { phase: 'QUEUED', completed: 0, total: 1 },
      createdAt: nowIso(),
      startedAt: null,
      completedAt: null,
      experimentId: null,
      error: null,
      worker: null,
      request: structuredClone(request),
    };
    this.jobs.set(id, job);
    await this.#persist();
    this.#run(job, actor);
    return publicJob(job);
  }

  get(id, actor) {
    const job = this.#owned(id, actor);
    return publicJob(job);
  }

  async cancel(id, actor) {
    const job = this.#owned(id, actor);
    if (!['QUEUED', 'RUNNING'].includes(job.status)) throw new HttpError(409, 'Balance job is not running.');
    job.status = 'CANCELLED';
    job.completedAt = nowIso();
    job.progress = { ...job.progress, phase: 'CANCELLED' };
    job.worker?.terminate();
    job.worker = null;
    await this.#persist();
    return publicJob(job);
  }

  async resume(id, actor) {
    const job = this.#owned(id, actor);
    if (!['INTERRUPTED', 'FAILED', 'CANCELLED'].includes(job.status)) throw new HttpError(409, 'Balance job is not resumable.');
    job.status = 'QUEUED';
    job.error = null;
    job.completedAt = null;
    job.progress = { phase: 'QUEUED', completed: 0, total: 1 };
    await this.#persist();
    this.#run(job, actor);
    return publicJob(job);
  }

  #owned(id, actor) {
    const job = this.jobs.get(id);
    if (!job) throw new HttpError(404, 'Balance job not found.');
    if (job.actorUserId !== actor.id && actor.role !== 'admin') throw new HttpError(403, 'Only the job owner or an admin can read it.');
    return job;
  }

  #run(job, actor) {
    const worker = new Worker(new URL('./engine/balance-worker.js', import.meta.url), {
      type: 'module',
      execArgv: [],
    });
    job.worker = worker;
    job.status = 'RUNNING';
    job.startedAt = nowIso();
    job.progress = { phase: 'STARTING', completed: 0, total: 1 };
    worker.on('message', async (message) => {
      if (job.status === 'CANCELLED') return;
      if (message.type === 'progress') {
        job.progress = message.progress;
        this.#persist();
        return;
      }
      if (message.type === 'complete') {
        try {
          const experiment = await this.onComplete({ actor, request: job.request, result: message.result });
          job.status = 'COMPLETED';
          job.experimentId = experiment.id;
          job.completedAt = nowIso();
          job.progress = { phase: 'COMPLETED', completed: 1, total: 1 };
        } catch (error) {
          failJob(job, error);
        } finally {
          job.worker = null;
          try {
            await this.#persist();
          } finally {
            worker.terminate();
          }
        }
      } else if (message.type === 'failed') {
        failJob(job, message.error);
        job.worker = null;
        try {
          await this.#persist();
        } finally {
          worker.terminate();
        }
      }
    });
    worker.on('error', (error) => failJob(job, error));
    worker.postMessage({ request: job.request });
  }

  #persist() {
    const work = async () => {
      const jobs = [...this.jobs.values()]
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
        .slice(0, 100)
        .map(({ worker, ...job }) => job);
      await atomicWriteJson(this.path, { schemaVersion: 1, jobs });
    };
    const result = this.persistLock.then(work, work);
    this.persistLock = result.catch(() => {});
    return result;
  }
}

function failJob(job, error) {
  if (job.status === 'CANCELLED') return;
  job.status = 'FAILED';
  job.completedAt = nowIso();
  job.progress = { ...job.progress, phase: 'FAILED' };
  job.error = { message: error?.message || String(error), status: Number(error?.status) || 500 };
}

function publicJob(job) {
  const { worker, request, actorRole, ...visible } = job;
  return structuredClone(visible);
}
