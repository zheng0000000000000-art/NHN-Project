import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runBalanceOperation } from '../src/balance-service.js';
import { simulateAuctionEconomy } from '../src/engine/economy-simulator.js';

const request = JSON.parse(await readFile(new URL('../examples/balance/unknown-auction-economy.json', import.meta.url), 'utf8'));

test('auction economy simulation is deterministic and preserves its baseline', () => {
  const before = structuredClone(request.baseline);
  const first = simulateAuctionEconomy(request.baseline, { seed: 42, runs: 100 });
  const second = simulateAuctionEconomy(request.baseline, { seed: 42, runs: 100 });
  assert.deepEqual(first, second);
  assert.deepEqual(request.baseline, before);
});

test('auction economy provider exposes policy distributions and failure metrics', () => {
  const result = runBalanceOperation({ ...request, mode: 'evaluate', runs: 100 });
  assert.equal(result.mode, 'evaluate');
  assert.equal(result.statistics.blindNegativeDayRate.samples, request.seeds.length);
  assert.equal(typeof result.outputs.informationTransactionAdvantage, 'number');
  assert.equal(typeof result.outputs.botValueLeakageResidual, 'number');
  assert.ok(result.statistics.informedRuinRate.failureRate >= 0);
  assert.equal(result.diagnostics.provider, 'auction-economy-v1');
  assert.equal(result.diagnostics.seeds.length, request.seeds.length);
  const blind = result.diagnostics.seeds[0].policies.blind;
  assert.equal(blind.contract.acquisition, 'EVERY_LOT');
  assert.equal(blind.timeline.length, 12);
  assert.equal(typeof blind.timeline[0].endAssets.p10, 'number');
  assert.equal(typeof blind.eventCounts.lotsOpened, 'number');
  assert.equal(Object.values(blind.failureCauses).reduce((sum, item) => sum + item.count, 0), 100);
});

test('auction economy seed can be tuned without mutating the request', () => {
  const before = structuredClone(request.baseline);
  const result = runBalanceOperation({ ...request, runs: 50, maxCandidates: 10 });
  assert.equal(result.observationSet.observations.length, 10);
  assert.deepEqual(request.baseline, before);
  assert.equal(result.baseline.diagnostics.provider, 'auction-economy-v1');
  assert.equal(result.candidate.diagnostics.provider, 'auction-economy-v1');
});

test('policy contracts keep comparable world streams while allowing different information strategies', () => {
  const policies = [
    { id: 'none', information: [], acquisition: 'EVERY_LOT' },
    { id: 'all', information: ['appraisal', 'demand'], acquisition: 'EVERY_LOT' },
  ];
  const result = simulateAuctionEconomy(request.baseline, { seed: 7, runs: 20, policies });
  assert.deepEqual(result.policies.map(({ id, information, acquisition }) => ({ id, information, acquisition })), policies);
  assert.equal(result.diagnostics.comparison.commonWorldSeeds, true);
  assert.equal(result.diagnostics.policies.none.eventCounts.informationPurchases, 0);
  assert.ok(result.diagnostics.policies.all.eventCounts.informationPurchases > 0);
});
