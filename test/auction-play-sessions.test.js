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

test('information value analysis reflects purchases and outcomes recorded in the session', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'auction-play-infovalue-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AuctionPlaySessionStore({ dataDirectory: directory, seedPath });
  await store.initialize();

  const started = await store.start(actor, { seed: 42 });
  const untouched = store.informationValue(started.id, actor);
  assert.deepEqual(untouched, {
    informedLotCount: 0,
    informationSpent: 0,
    bidChanges: [],
    avoidedLosses: 0,
    missedOpportunities: 0,
    netInformationValue: 0,
    regret: 0,
  });

  await store.act(started.id, actor, { type: 'BUY_APPRAISAL' });
  await store.act(started.id, actor, { type: 'PASS' });
  const informed = store.informationValue(started.id, actor);
  assert.equal(informed.informedLotCount, 1);
  assert.equal(informed.bidChanges.length, 1);
  assert.equal(informed.bidChanges[0].type, 'BUY_APPRAISAL');
  assert.equal(typeof informed.bidChanges[0].bidShift, 'number');
  assert.equal(informed.informationSpent, informed.bidChanges[0].cost);
  assert.ok(informed.regret >= 0);
  assert.ok(informed.avoidedLosses >= 0);
  assert.ok(informed.missedOpportunities >= 0);
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

test('policy comparison is unavailable until the human session settles', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'auction-play-policycmp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AuctionPlaySessionStore({ dataDirectory: directory, seedPath });
  await store.initialize();

  const started = await store.start(actor, { seed: 321 });
  assert.throws(() => store.policyComparison(started.id, actor), /completed/i);

  let current = started;
  while (current.status === 'ACTIVE') {
    current = await store.act(started.id, actor, { type: 'PASS' });
  }
  assert.equal(current.status, 'COMPLETED');

  const comparison = store.policyComparison(started.id, actor);
  assert.equal(comparison.seed, 321);
  assert.equal(comparison.comparison.commonWorldSeed, 321);
  assert.deepEqual(
    comparison.policies.map((policy) => policy.id).sort(),
    ['conservative', 'speculative', 'value'],
  );
  assert.equal(typeof comparison.human.roiPercent, 'number');
  for (const policy of comparison.policies) {
    assert.equal(policy.lotsSeen <= comparison.comparison.sharedLotCount, true);
    assert.equal(typeof policy.vsHuman.roiPercentDelta, 'number');
  }
});

test('the same seed run twice yields identical policy-comparison results', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'auction-play-policycmp-seed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AuctionPlaySessionStore({ dataDirectory: directory, seedPath });
  await store.initialize();

  async function playToCompletion(seed) {
    let current = await store.start(actor, { seed });
    while (current.status === 'ACTIVE') {
      current = await store.act(current.id, actor, { type: 'PASS' });
    }
    return current;
  }

  const left = await playToCompletion(555);
  const right = await playToCompletion(555);
  const leftComparison = store.policyComparison(left.id, actor);
  const rightComparison = store.policyComparison(right.id, actor);
  assert.deepEqual(leftComparison.policies, rightComparison.policies);
});

test('information value report is unavailable until the human session settles', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'auction-play-infovaluereport-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AuctionPlaySessionStore({ dataDirectory: directory, seedPath });
  await store.initialize();

  const started = await store.start(actor, { seed: 321 });
  assert.throws(() => store.informationValueReport(started.id, actor), /completed/i);

  let current = started;
  while (current.status === 'ACTIVE') {
    current = await store.act(started.id, actor, { type: 'PASS' });
  }
  assert.equal(current.status, 'COMPLETED');

  const report = store.informationValueReport(started.id, actor);
  assert.equal(report.seed, 321);
  assert.deepEqual(report.returns.map((entry) => entry.id).sort(), ['conservative', 'human', 'speculative', 'value']);
  assert.deepEqual(report.regret.map((entry) => entry.id).sort(), ['conservative', 'human', 'speculative', 'value']);
  assert.deepEqual(report.payback.map((entry) => entry.id).sort(), ['conservative', 'human', 'speculative', 'value']);
  assert.equal(report.prices, null);
  assert.equal(typeof report.recommendedNextExperiment.title, 'string');
  assert.ok(report.recommendedNextExperiment.title.length > 0);
});
