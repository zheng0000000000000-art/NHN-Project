import { combatMetric, simulateCombat } from './engine/balance-simulator.js';
import { economyMetric, simulateAuctionEconomy } from './engine/economy-simulator.js';
import { evaluateBalance, tuneBalance } from './engine/balance-engine.js';
import { HttpError } from './utils.js';

export function runBalanceOperation(input = {}, { onProgress = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Balance request must be an object.');
  const provider = input.provider || 'combat-v1';
  if (!['combat-v1', 'auction-economy-v1'].includes(provider)) throw new HttpError(400, `Unsupported balance provider: ${provider}`);
  const seeds = normalizeSeeds(input.seeds ?? input.spec?.simulation?.seeds, input.seed ?? input.spec?.search?.seed ?? 42);
  const runsPerSeed = boundedInteger(input.runs ?? input.spec?.simulation?.runsPerSeed ?? 500, 1, 5_000);
  const maxCandidates = boundedInteger(input.maxCandidates ?? 1000, 1, 5_000);
  const simulate = (data) => {
    const results = seeds.map((seed) => provider === 'auction-economy-v1'
      ? simulateAuctionEconomy(data, {
        seed,
        runs: runsPerSeed,
        policies: input.spec?.simulation?.policies,
      })
      : simulateCombat(data, { seed, runs: runsPerSeed }));
    const metricRows = results.map((result) => Object.fromEntries((input.spec?.metrics || []).map((metric) => {
      const metricId = metric.metricId || metric.id || metric.name;
      return [metricId, provider === 'auction-economy-v1'
        ? economyMetric(metricId, result)
        : combatMetric(metricId, result)];
    })));
    const metrics = {};
    const statistics = {};
    for (const metric of input.spec?.metrics || []) {
      const metricId = metric.metricId || metric.id || metric.name;
      const values = metricRows.map((row) => Number(row[metricId]));
      const sorted = [...values].sort((a, b) => a - b);
      const outsideTarget = values.filter((value) =>
        (metric.minimum != null && value < Number(metric.minimum))
        || (metric.maximum != null && value > Number(metric.maximum))).length;
      metrics[metricId] = mean(values);
      statistics[metricId] = {
        mean: metrics[metricId],
        median: percentile(sorted, 0.5),
        p10: percentile(sorted, 0.1),
        p90: percentile(sorted, 0.9),
        standardDeviation: standardDeviation(values),
        minimum: Math.min(...values),
        maximum: Math.max(...values),
        failureRate: outsideTarget / Math.max(1, values.length),
        samples: values.length,
      };
    }
    return {
      metrics,
      statistics,
      diagnostics: provider === 'auction-economy-v1'
        ? {
          provider,
          seeds: results.map((result) => ({
            seed: result.seed,
            policies: result.diagnostics.policies,
            comparison: result.diagnostics.comparison,
          })),
        }
        : {},
      simulation: { seeds, runsPerSeed },
    };
  };
  const request = { spec: input.spec, baseline: input.baseline, simulate };
  return input.mode === 'evaluate'
    ? { mode: 'evaluate', ...evaluateBalance(request) }
    : {
      mode: 'tune',
      ...tuneBalance({
        ...request,
        maxCandidates,
        onProgress,
        priorParameters: input.priorParameters,
      }),
    };
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

function percentile(sorted, ratio) {
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + ((sorted[upper] - sorted[lower]) * (position - lower));
}

function boundedInteger(value, minimum, maximum) {
  const candidate = Math.round(Number(value));
  if (!Number.isFinite(candidate)) return minimum;
  return Math.max(minimum, Math.min(maximum, candidate));
}
