import { combatMetric, simulateCombat } from './engine/balance-simulator.js';
import { evaluateBalance, tuneBalance } from './engine/balance-engine.js';
import { HttpError } from './utils.js';

export function runBalanceOperation(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Balance request must be an object.');
  if (input.provider && input.provider !== 'combat-v1') throw new HttpError(400, `Unsupported balance provider: ${input.provider}`);
  const simulate = (data, options) => {
    const result = simulateCombat(data, { seed: input.seed ?? options.seed ?? 42, runs: input.runs ?? 500 });
    return {
      ...result,
      metrics: Object.fromEntries((input.spec?.metrics || []).map((metric) => {
        const metricId = metric.metricId || metric.id || metric.name;
        return [metricId, combatMetric(metricId, result)];
      })),
    };
  };
  const request = { spec: input.spec, baseline: input.baseline, simulate };
  return input.mode === 'evaluate'
    ? { mode: 'evaluate', ...evaluateBalance(request) }
    : { mode: 'tune', ...tuneBalance({ ...request, maxCandidates: input.maxCandidates ?? 1000 }) };
}
