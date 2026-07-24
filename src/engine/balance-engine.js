import { normalizeBalanceSpec, normalizeObservationSet } from '../contracts.js';

export function evaluateBalance({ spec: inputSpec, baseline, simulate }) {
  const spec = normalizeBalanceSpec(inputSpec);
  const result = simulate(structuredClone(baseline), { seed: spec.search.seed || 42 });
  const outputs = Object.fromEntries(spec.metrics.map((metric) => [metric.metricId, numericMetric(result, metric.metricId)]));
  return { spec, outputs, statistics: result?.statistics ?? {}, score: scoreOutputs(spec.metrics, outputs) };
}

export function tuneBalance({ spec: inputSpec, baseline, simulate, maxCandidates = 1000 }) {
  const spec = normalizeBalanceSpec(inputSpec);
  const untouchedBaseline = structuredClone(baseline);
  const baselineEvaluation = evaluateBalance({ spec, baseline: untouchedBaseline, simulate });
  let best = { data: structuredClone(untouchedBaseline), parameters: { ...spec.parameters }, ...baselineEvaluation };
  const observations = [];
  const spaces = spec.parameterSpace;
  const candidates = enumerate(spaces, maxCandidates);

  for (let index = 0; index < candidates.length; index += 1) {
    const data = structuredClone(untouchedBaseline);
    const parameters = { ...spec.parameters };
    for (const [parameterId, value] of Object.entries(candidates[index])) {
      const definition = spaces.find((item) => item.parameterId === parameterId);
      setAtPath(data, definition.path, value);
      parameters[parameterId] = value;
    }
    const evaluation = evaluateBalance({ spec, baseline: data, simulate });
    observations.push({
      observationId: `candidate-${index + 1}`,
      iteration: index,
      inputs: candidates[index],
      outputs: evaluation.outputs,
      passed: evaluation.score.violations === 0,
      evidence: [`score=${evaluation.score.total}`],
    });
    if (better(evaluation.score, best.score)) best = { data, parameters, ...evaluation };
  }

  return {
    balanceId: spec.balanceId,
    baseline: { outputs: baselineEvaluation.outputs, score: baselineEvaluation.score },
    candidate: { parameters: best.parameters, outputs: best.outputs, score: best.score, data: best.data },
    solved: best.score.violations === 0,
    changed: JSON.stringify(best.data) !== JSON.stringify(untouchedBaseline),
    observationSet: normalizeObservationSet({
      observationSetId: `${spec.balanceId}-search`,
      balanceId: spec.balanceId,
      observations: observations.length ? observations : [{
        observationId: 'baseline', iteration: 0, inputs: spec.parameters,
        outputs: baselineEvaluation.outputs, passed: baselineEvaluation.score.violations === 0,
      }],
    }),
  };
}

function scoreOutputs(metrics, outputs) {
  let total = 0;
  let violations = 0;
  const distances = {};
  for (const metric of metrics) {
    const value = outputs[metric.metricId];
    let distance = 0;
    if (metric.minimum !== null && value < metric.minimum) distance = metric.minimum - value;
    if (metric.maximum !== null && value > metric.maximum) distance = value - metric.maximum;
    if (metric.target !== null && metric.minimum === null && metric.maximum === null) distance = Math.abs(value - metric.target);
    distances[metric.metricId] = distance;
    if (distance > 0) violations += 1;
    total += distance * metric.weight;
  }
  return { total, violations, distances };
}

function numericMetric(result, metricId) {
  const value = result?.metrics?.[metricId] ?? result?.[metricId];
  if (!Number.isFinite(Number(value))) throw new Error(`Simulation did not produce numeric metric: ${metricId}`);
  return Number(value);
}

function enumerate(spaces, maximum) {
  if (!spaces.length) return [];
  let rows = [{}];
  for (const space of spaces) {
    const values = [];
    for (let value = space.minimum; value <= space.maximum + space.step / 1_000_000; value += space.step) values.push(Number(value.toFixed(12)));
    rows = rows.flatMap((row) => values.map((value) => ({ ...row, [space.parameterId]: value }))).slice(0, maximum);
  }
  return rows;
}

function setAtPath(target, slashPath, value) {
  const parts = slashPath.split('/').filter(Boolean);
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = /^\d+$/.test(parts[index]) ? Number(parts[index]) : parts[index];
    cursor = cursor[key];
    if (!cursor || typeof cursor !== 'object') throw new Error(`Balance parameter path does not exist: ${slashPath}`);
  }
  const leaf = /^\d+$/.test(parts.at(-1)) ? Number(parts.at(-1)) : parts.at(-1);
  if (!(leaf in cursor)) throw new Error(`Balance parameter path does not exist: ${slashPath}`);
  cursor[leaf] = value;
}

function better(candidate, current) {
  return candidate.violations < current.violations
    || (candidate.violations === current.violations && candidate.total < current.total);
}
