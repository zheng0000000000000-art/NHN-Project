import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BalanceExperimentStore } from '../src/balance-experiments.js';
import { BalanceSeedRegistry } from '../src/balance-seeds.js';

test('balance seeds supply replaceable contracts instead of product hard-coding', async () => {
  const registry = new BalanceSeedRegistry({
    projectRoot: path.resolve('.'),
    manifestPath: path.resolve('config/balance-seeds.json'),
  });
  await registry.initialize();
  const seeds = registry.list();
  assert.ok(seeds.length > 0);
  assert.equal('request' in seeds[0], false);
  const seed = registry.get(seeds[0].id);
  assert.ok(seed.request.spec.balanceId);
  assert.ok(seed.request.baseline);
});

test('candidate approval is persisted separately from the immutable request baseline', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'balance-experiments-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new BalanceExperimentStore(directory);
  await store.initialize();
  const actor = { id: 'user-1', role: 'member' };
  const request = { spec: { balanceId: 'test' }, baseline: { value: 1 } };
  const result = { candidate: { data: { value: 2 } } };
  const recorded = await store.record(actor, request, result);
  assert.equal(recorded.status, 'PROPOSED');
  const applied = await store.apply(recorded.id, actor);
  assert.equal(applied.status, 'APPLIED');
  assert.deepEqual(applied.request.baseline, { value: 1 });
  assert.deepEqual(applied.result.candidate.data, { value: 2 });
});
