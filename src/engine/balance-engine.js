import { normalizeBalanceSpec, normalizeObservationSet } from '../contracts.js';

export function evaluateBalance({ spec: inputSpec, baseline, simulate }) {
  const spec = normalizeBalanceSpec(inputSpec);
  const result = simulate(structuredClone(baseline), { seed: spec.search.seed || 42 });
  const outputs = Object.fromEntries(spec.metrics.map((metric) => [metric.metricId, numericMetric(result, metric.metricId)]));
  return {
    spec,
    outputs,
    statistics: result?.statistics ?? {},
    diagnostics: result?.diagnostics ?? {},
    score: scoreOutputs(spec.metrics, outputs),
  };
}

export function tuneBalance({ spec: inputSpec, baseline, simulate, maxCandidates = 1000, onProgress = null, priorParameters = null }) {
  const spec = normalizeBalanceSpec(inputSpec);
  const untouchedBaseline = structuredClone(baseline);
  const baselineEvaluation = evaluateBalance({ spec, baseline: untouchedBaseline, simulate });
  let best = { data: structuredClone(untouchedBaseline), parameters: { ...spec.parameters }, ...baselineEvaluation };
  const observations = [];
  const spaces = spec.parameterSpace;
  const broadLimit = spaces.length ? Math.max(1, Math.floor(maxCandidates * 0.7)) : 0;
  const candidates = [
    ...(priorParameters && typeof priorParameters === 'object' ? [pickSpaceParameters(spaces, priorParameters)] : []),
    ...enumerate(spaces, broadLimit),
  ].filter((row) => Object.keys(row).length === spaces.length);
  const visited = new Set();

  const evaluateCandidates = (rows, phase) => {
    for (let localIndex = 0; localIndex < rows.length && observations.length < maxCandidates; localIndex += 1) {
      const signature = JSON.stringify(rows[localIndex]);
      if (visited.has(signature)) continue;
      visited.add(signature);
      const index = observations.length;
      const data = structuredClone(untouchedBaseline);
      const parameters = { ...spec.parameters };
      for (const [parameterId, value] of Object.entries(rows[localIndex])) {
        const definition = spaces.find((item) => item.parameterId === parameterId);
        setAtPath(data, definition.path, value);
        parameters[parameterId] = value;
      }
      const evaluation = evaluateBalance({ spec, baseline: data, simulate });
      observations.push({
        observationId: `candidate-${index + 1}`,
        iteration: index,
        inputs: rows[localIndex],
        outputs: evaluation.outputs,
        passed: evaluation.score.violations === 0,
        evidence: [`score=${evaluation.score.total}`, `phase=${phase}`],
      });
      if (better(evaluation.score, best.score)) best = { data, parameters, ...evaluation };
      if (onProgress && (index === 0 || observations.length === maxCandidates || index % Math.max(1, Math.floor(maxCandidates / 100)) === 0)) {
        onProgress({ phase, completed: observations.length, total: maxCandidates });
      }
    }
  };

  evaluateCandidates(candidates, 'BROAD_SEARCH');
  if (spaces.length && observations.length < maxCandidates) {
    evaluateCandidates(enumerate(localSpaces(spaces, best.parameters), maxCandidates - observations.length), 'LOCAL_REFINEMENT');
  }
  if (spaces.length && observations.length < maxCandidates) {
    evaluateCandidates(enumerate(spaces, maxCandidates), 'BROAD_FILL');
  }

  return {
    balanceId: spec.balanceId,
    baseline: {
      outputs: baselineEvaluation.outputs,
      statistics: baselineEvaluation.statistics,
      diagnostics: baselineEvaluation.diagnostics,
      score: baselineEvaluation.score,
    },
    candidate: {
      parameters: best.parameters,
      outputs: best.outputs,
      statistics: best.statistics,
      diagnostics: best.diagnostics,
      score: best.score,
      data: best.data,
    },
    solved: best.score.violations === 0,
    changed: JSON.stringify(best.data) !== JSON.stringify(untouchedBaseline),
    paretoCandidates: paretoFront(spec.metrics, observations).slice(0, 20),
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

function pickSpaceParameters(spaces, parameters) {
  return Object.fromEntries(spaces.flatMap((space) => {
    const value = Number(parameters[space.parameterId]);
    return Number.isFinite(value) && value >= space.minimum && value <= space.maximum
      ? [[space.parameterId, value]]
      : [];
  }));
}

function localSpaces(spaces, parameters) {
  return spaces.map((space) => {
    const center = Number(parameters[space.parameterId]);
    return {
      ...space,
      minimum: Math.max(space.minimum, center - space.step),
      maximum: Math.min(space.maximum, center + space.step),
    };
  });
}

function paretoFront(metrics, observations) {
  const rows = observations.map((observation) => ({
    observationId: observation.observationId,
    inputs: observation.inputs,
    outputs: observation.outputs,
    passed: observation.passed,
    distances: Object.fromEntries(metrics.map((metric) => [
      metric.metricId,
      metricDistance(metric, observation.outputs[metric.metricId]),
    ])),
  }));
  return rows.filter((candidate, index) => !rows.some((other, otherIndex) =>
    index !== otherIndex && dominates(other.distances, candidate.distances)));
}

function metricDistance(metric, value) {
  if (metric.minimum !== null && value < metric.minimum) return metric.minimum - value;
  if (metric.maximum !== null && value > metric.maximum) return value - metric.maximum;
  if (metric.target !== null && metric.minimum === null && metric.maximum === null) return Math.abs(value - metric.target);
  return 0;
}

function dominates(left, right) {
  const keys = Object.keys(right);
  return keys.every((key) => left[key] <= right[key])
    && keys.some((key) => left[key] < right[key]);
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
    rows = rows.flatMap((row) => values.map((value) => ({ ...row, [space.parameterId]: value })));
    if (rows.length > 100_000) throw new Error('Balance parameter grid exceeds the safe enumeration limit.');
  }
  if (rows.length <= maximum) return rows;
  return Array.from({ length: maximum }, (_, index) =>
    rows[Math.floor(index * (rows.length - 1) / Math.max(1, maximum - 1))]);
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
