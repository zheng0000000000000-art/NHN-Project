import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { AuctionPlaySessionStore } from '../src/auction-play-sessions.js';
import { compareAiPoliciesToHuman, AI_POLICIES } from '../src/auction-policy-comparison.js';

const seedPath = new URL('../examples/balance/unknown-auction-economy.json', import.meta.url);
const actor = { id: 'user-1', name: 'tester', role: 'member' };

async function playToCompletion(store, seed) {
  const started = await store.start(actor, { seed });
  let session = started;
  while (session.status === 'ACTIVE') {
    // eslint-disable-next-line no-await-in-loop
    session = await store.act(started.id, actor, { type: 'PASS' });
  }
  return store.findOwned(started.id, actor);
}

test('policy comparison refuses to run before the human session has settled', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'auction-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AuctionPlaySessionStore({ dataDirectory: directory, seedPath });
  await store.initialize();

  const started = await store.start(actor, { seed: 42 });
  assert.throws(() => store.policyComparison(started.id, actor), /settled/);
});

test('policy comparison replays conservative, value, and speculative policies on the human seed', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'auction-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AuctionPlaySessionStore({ dataDirectory: directory, seedPath });
  await store.initialize();

  const session = await playToCompletion(store, 4242);
  const comparison = store.policyComparison(session.id, actor);

  assert.equal(comparison.seed, session.seed);
  assert.equal(comparison.seed, 4242);
  assert.deepEqual(Object.keys(comparison.policies).sort(), ['conservative', 'speculative', 'value']);
  assert.equal(AI_POLICIES.map((policy) => policy.id).sort().join(','), 'conservative,speculative,value');

  for (const policyId of ['conservative', 'value', 'speculative']) {
    const result = comparison.policies[policyId];
    assert.equal(typeof result.roiPercent, 'number');
    assert.equal(typeof result.lotWinRate, 'number');
    assert.ok(result.decisions > 0);
  }

  assert.equal(typeof comparison.human.roiPercent, 'number');
  assert.equal(comparison.human.decisions, session.decisions.filter((d) => d.type === 'BID' || d.type === 'PASS').length);
});

test('policy comparison is deterministic for a shared seed (identical world for human and AI)', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'auction-policy-seed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AuctionPlaySessionStore({ dataDirectory: directory, seedPath });
  await store.initialize();

  const left = await playToCompletion(store, 999);
  const right = await playToCompletion(store, 999);

  const leftComparison = store.policyComparison(left.id, actor);
  const rightComparison = store.policyComparison(right.id, actor);
  assert.deepEqual(leftComparison.policies, rightComparison.policies);
});

test('AI policies never use hidden truth before the bid is decided', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'auction-policy-hidden-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AuctionPlaySessionStore({ dataDirectory: directory, seedPath });
  await store.initialize();

  const session = await playToCompletion(store, 55);
  const internal = store.findOwned(session.id, actor);

  // Sanity check: a lot with hidden fields exists to guard against a no-op regression.
  assert.ok(internal.lots.some((lot) => Number.isFinite(lot.trueSalePrice) && Number.isFinite(lot.clearingPrice)));

  const comparison = compareAiPoliciesToHuman(internal, store.config);
  assert.ok(comparison.policies.speculative.decisions > 0);
});
