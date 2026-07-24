import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { AuctionPlaySessionStore } from '../src/auction-play-sessions.js';

const seedPath = new URL('../examples/balance/unknown-auction-economy.json', import.meta.url);
const actor = { id: 'user-1', name: 'tester', role: 'member' };

test('greybox sessions expose observations but keep hidden truth on the server', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'auction-play-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AuctionPlaySessionStore({ dataDirectory: directory, seedPath });
  await store.initialize();

  const started = await store.start(actor, { seed: 42 });
  assert.equal(started.status, 'ACTIVE');
  assert.equal(started.currentLot.appraisalEstimate, null);
  assert.equal('trueSalePrice' in started.currentLot, false);
  assert.equal('clearingPrice' in started.currentLot, false);
  assert.ok(started.currentLot.informationPrices.appraisal >= 100);
  assert.ok(started.currentLot.informationPrices.demand >= 100);

  const informed = await store.act(started.id, actor, { type: 'BUY_APPRAISAL' });
  assert.equal(typeof informed.currentLot.appraisalEstimate, 'number');
  assert.ok(informed.economy.informationSpent > 0);

  const resolved = await store.act(started.id, actor, { type: 'PASS' });
  assert.equal(resolved.progress.completed, 1);
  assert.equal(resolved.currentLot.index, 2);
  assert.equal(resolved.recentDecisions[0].type, 'PASS');
});

test('greybox sessions are deterministic for a shared seed', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'auction-play-seed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AuctionPlaySessionStore({ dataDirectory: directory, seedPath });
  await store.initialize();
  const left = await store.start(actor, { seed: 7123 });
  const right = await store.start(actor, { seed: 7123 });
  assert.deepEqual(left.currentLot, right.currentLot);
});
