import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BalanceJobManager } from '../src/balance-jobs.js';

const actor = { id: 'user-1', role: 'member' };
const request = {
  provider: 'combat-v1',
  mode: 'evaluate',
  runs: 20,
  spec: {
    balanceId: 'job-test',
    parameters: { dummy: 1 },
    parameterSpace: [],
    metrics: [{ metricId: 'completionRate', minimum: 0, maximum: 100 }],
  },
  baseline: {
    player: { maxHp: 100, attack: 12 },
    rooms: [{ enemies: { hp: 10, attack: 1, count: 1 }, rewards: {} }],
  },
};

test('balance jobs execute off-thread and expose a saved experiment id', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'balance-jobs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new BalanceJobManager({
    dataDirectory: directory,
    async onComplete() {
      return { id: 'bal_saved' };
    },
  });
  await manager.initialize();
  const started = await manager.start({ actor, request });
  assert.ok(['QUEUED', 'RUNNING'].includes(started.status));
  let job = started;
  for (let attempt = 0; attempt < 100 && !['COMPLETED', 'FAILED'].includes(job.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    job = manager.get(started.id, actor);
  }
  assert.equal(job.status, 'COMPLETED', JSON.stringify(job.error));
  assert.equal(job.experimentId, 'bal_saved');
  await new Promise((resolve) => setTimeout(resolve, 30));
});

test('running jobs become resumable after process restart', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'balance-jobs-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'balance-jobs.json'), JSON.stringify({
    schemaVersion: 1,
    jobs: [{
      id: 'baljob_saved',
      actorUserId: actor.id,
      actorRole: actor.role,
      status: 'RUNNING',
      progress: { phase: 'SEARCH', completed: 5, total: 10 },
      request,
      createdAt: new Date().toISOString(),
    }],
  }));
  const manager = new BalanceJobManager({ dataDirectory: directory, async onComplete() { return { id: 'bal_saved' }; } });
  await manager.initialize();
  assert.equal(manager.get('baljob_saved', actor).status, 'INTERRUPTED');
  const resumed = await manager.resume('baljob_saved', actor);
  assert.equal(resumed.status, 'RUNNING');
  let completed = resumed;
  for (let attempt = 0; attempt < 100 && !['COMPLETED', 'FAILED'].includes(completed.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    completed = manager.get('baljob_saved', actor);
  }
  assert.equal(completed.status, 'COMPLETED', JSON.stringify(completed.error));
  await new Promise((resolve) => setTimeout(resolve, 30));
});
