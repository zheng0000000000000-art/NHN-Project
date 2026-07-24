import test from 'node:test';
import assert from 'node:assert/strict';
import { projectBalanceExperiment } from '../src/balance-result-view.js';

const experiment = {
  id: 'bal_test',
  title: 'Test',
  provider: 'auction-economy-v1',
  status: 'PROPOSED',
  createdAt: '2026-01-01T00:00:00.000Z',
  result: {
    balanceId: 'economy',
    solved: true,
    changed: true,
    spec: { metrics: [{ metricId: 'roi', minimum: 0, maximum: 10, weight: 1 }] },
    baseline: {
      outputs: { roi: 12 },
      score: { violations: 1 },
      statistics: { roi: { mean: 12, p10: 10, p90: 14 } },
      diagnostics: { provider: 'auction-economy-v1', seeds: [] },
    },
    candidate: {
      parameters: { bid: 0.8 },
      outputs: { roi: 8 },
      score: { violations: 0 },
      statistics: { roi: { mean: 8, p10: 7, p90: 9 } },
      diagnostics: { provider: 'auction-economy-v1', seeds: [] },
      data: { very: 'large candidate data' },
    },
    observationSet: { observations: Array.from({ length: 20 }, (_, index) => ({ index })) },
  },
};

test('balance summary excludes large diagnostics, candidate data, and observations', () => {
  const summary = projectBalanceExperiment(experiment);
  assert.equal(summary.result.observationCount, 20);
  assert.equal(summary.result.candidate.data, undefined);
  assert.equal(summary.result.candidate.diagnostics, undefined);
  assert.equal(summary.result.observationSet, undefined);
});

test('balance diagnostics can be filtered to one metric', () => {
  const diagnostics = projectBalanceExperiment(experiment, { view: 'diagnostics', metricId: 'roi' });
  assert.deepEqual(Object.keys(diagnostics.metrics), ['roi']);
  assert.equal(diagnostics.metrics.roi.baseline.mean, 12);
  assert.equal(diagnostics.metrics.roi.candidate.mean, 8);
});

test('policy diagnostics aggregate seeds instead of repeating full per-seed trees', () => {
  const withPolicies = structuredClone(experiment);
  withPolicies.result.baseline.diagnostics.seeds = [1, 2].map((seed) => ({
    seed,
    policies: {
      blind: {
        contract: { id: 'blind' },
        failureCauses: { NONE: { count: 10, rate: 100 } },
        eventCounts: { lotsOpened: 100 },
        timeline: [{ day: 1, reachedRate: 100, endAssets: { mean: 100, p10: 80, median: 100, p90: 120, minimum: 70, maximum: 130 }, profit: {}, informationSpent: {}, wins: {} }],
      },
    },
  }));
  const diagnostics = projectBalanceExperiment(withPolicies, { view: 'diagnostics', policyId: 'blind' });
  assert.deepEqual(diagnostics.policy.baseline.seeds, [1, 2]);
  assert.equal(diagnostics.policy.baseline.eventCounts.lotsOpened, 200);
  assert.equal(diagnostics.policy.baseline.timeline.length, 1);
});

test('raw balance view preserves exact stored evidence', () => {
  const raw = projectBalanceExperiment(experiment, { view: 'raw' });
  assert.deepEqual(raw, experiment);
  assert.notEqual(raw, experiment);
});
