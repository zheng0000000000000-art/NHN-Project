import { combatMetric, simulateCombat } from './engine/balance-simulator.js';
import { evaluateBalance, tuneBalance } from './engine/balance-engine.js';
import { HttpError } from './utils.js';

export function runBalanceOperation(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Balance request must be an object.');
  if (input.provider && input.provider !== 'combat-v1') throw new HttpError(400, `Unsupported balance provider: ${input.provider}`);
  const seeds = normalizeSeeds(input.seeds ?? input.spec?.simulation?.seeds, input.seed ?? input.spec?.search?.seed ?? 42);
  const simulate = (data) => {
    const results = seeds.map((seed) => simulateCombat(data, { seed, runs: input.runs ?? input.spec?.simulation?.runsPerSeed ?? 500 }));
    const metricRows = results.map((result) => Object.fromEntries((input.spec?.metrics || []).map((metric) => {
      const metricId = metric.metricId || metric.id || metric.name;
      return [metricId, combatMetric(metricId, result)];
    })));
    const metrics = {};
    const statistics = {};
    for (const metric of input.spec?.metrics || []) {
      const metricId = metric.metricId || metric.id || metric.name;
      const values = metricRows.map((row) => Number(row[metricId]));
      metrics[metricId] = mean(values);
      statistics[metricId] = {
        mean: metrics[metricId],
        standardDeviation: standardDeviation(values),
        minimum: Math.min(...values),
        maximum: Math.max(...values),
        samples: values.length,
      };
    }
    return {
      metrics,
      statistics,
      simulation: { seeds, runsPerSeed: input.runs ?? input.spec?.simulation?.runsPerSeed ?? 500 },
    };
  };
  const request = { spec: input.spec, baseline: input.baseline, simulate };
  return input.mode === 'evaluate'
    ? { mode: 'evaluate', ...evaluateBalance(request) }
    : { mode: 'tune', ...tuneBalance({ ...request, maxCandidates: input.maxCandidates ?? 1000 }) };
}

function normalizeSeeds(value, fallback) {
  const seeds = [...new Set((Array.isArray(value) ? value : [fallback]).map(Number).filter(Number.isFinite))].slice(0, 50);
  return seeds.length ? seeds : [42];
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function standardDeviation(values) {
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / Math.max(1, values.length));
}
