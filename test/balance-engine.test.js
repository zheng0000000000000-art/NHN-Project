import test from 'node:test';
import assert from 'node:assert/strict';
import { runBalanceOperation } from '../src/balance-service.js';
import { simulateCombat } from '../src/engine/balance-simulator.js';

const baseline = {
  player: { maxHp: 100, attack: 12 },
  rooms: [
    { id: 'room-1', enemies: { hp: 25, attack: 4, count: 2 }, rewards: { commonDropRate: 0.4, healAmount: 10 } },
    { id: 'room-2', enemies: { hp: 34, attack: 10, count: 3 }, rewards: { commonDropRate: 0.2, healAmount: 5 } },
  ],
};

const spec = {
  balanceId: 'ruined-lab-combat',
  parameters: { room2Attack: 10 },
  parameterSpace: [{ parameterId: 'room2Attack', path: 'rooms/1/enemies/attack', minimum: 4, maximum: 10, step: 2 }],
  metrics: [
    { metricId: 'completionRate', minimum: 45, maximum: 70, weight: 2 },
    { metricId: 'room1DeathRate', minimum: 0, maximum: 20 },
    { metricId: 'avgRewardPerRun', minimum: 0, maximum: 20 },
  ],
  search: { deterministic: true, seed: '42', strategy: 'explicit-grid' },
};

test('combat simulation is deterministic for a seed and does not mutate input', () => {
  const before = structuredClone(baseline);
  assert.deepEqual(simulateCombat(baseline, { seed: 42, runs: 200 }), simulateCombat(baseline, { seed: 42, runs: 200 }));
  assert.deepEqual(baseline, before);
});

test('balance tuner preserves baseline, emits observations, and is reproducible', () => {
  const before = structuredClone(baseline);
  const first = runBalanceOperation({ spec, baseline, seed: 42, runs: 200 });
  const second = runBalanceOperation({ spec, baseline, seed: 42, runs: 200 });
  assert.deepEqual(first, second);
  assert.deepEqual(baseline, before);
  assert.equal(first.observationSet.kind, 'team-loop-observation-set');
  assert.equal(first.observationSet.observations.length, 4);
  assert.ok(first.candidate.score.total <= first.baseline.score.total);
});

test('no-solution is reported without applying a candidate', () => {
  const impossible = structuredClone(spec);
  impossible.metrics[0] = { metricId: 'completionRate', minimum: 101, maximum: 110 };
  const result = runBalanceOperation({ spec: impossible, baseline, seed: 42, runs: 50 });
  assert.equal(result.solved, false);
  assert.deepEqual(baseline.player, { maxHp: 100, attack: 12 });
});

test('multi-seed simulation aggregates reproducible statistics instead of optimizing one lucky run', () => {
  const request = { spec, baseline, seeds: [11, 23, 42, 71], runs: 100, mode: 'evaluate' };
  const first = runBalanceOperation(request);
  const second = runBalanceOperation(request);
  assert.deepEqual(first, second);
  assert.equal(first.statistics.completionRate.samples, 4);
  assert.ok(first.statistics.completionRate.maximum >= first.statistics.completionRate.minimum);
  assert.ok(first.statistics.completionRate.standardDeviation >= 0);
  assert.ok(first.statistics.completionRate.p10 <= first.statistics.completionRate.median);
  assert.ok(first.statistics.completionRate.median <= first.statistics.completionRate.p90);
  assert.ok(first.statistics.completionRate.failureRate >= 0 && first.statistics.completionRate.failureRate <= 1);
});

test('tuning exposes baseline and candidate distributions for review', () => {
  const result = runBalanceOperation({ spec, baseline, seeds: [11, 23, 42, 71], runs: 100 });
  assert.equal(result.baseline.statistics.completionRate.samples, 4);
  assert.equal(result.candidate.statistics.completionRate.samples, 4);
  assert.equal(typeof result.candidate.statistics.completionRate.failureRate, 'number');
});

test('tuning returns a bounded pareto front and evaluates prior parameters first', () => {
  const result = runBalanceOperation({
    spec,
    baseline,
    runs: 20,
    maxCandidates: 4,
    priorParameters: { room2Attack: 6 },
  });
  assert.ok(result.paretoCandidates.length > 0);
  assert.ok(result.paretoCandidates.length <= 20);
  assert.equal(result.observationSet.observations[0].inputs.room2Attack, 6);
});
