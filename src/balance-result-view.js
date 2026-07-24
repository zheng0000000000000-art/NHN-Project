export function projectBalanceExperiment(experiment, { view = 'summary', metricId = '', policyId = '' } = {}) {
  if (!experiment) return null;
  if (view === 'full' || view === 'raw') return structuredClone(experiment);
  if (view === 'diagnostics') return diagnosticView(experiment, { metricId, policyId });
  return summaryView(experiment);
}

export function projectBalanceResult(result, view = 'summary') {
  if (view === 'full' || view === 'raw') return structuredClone(result);
  return compactResult(result);
}

function summaryView(experiment) {
  return {
    id: experiment.id,
    title: experiment.title,
    provider: experiment.provider,
    status: experiment.status,
    createdAt: experiment.createdAt,
    appliedAt: experiment.appliedAt,
    result: compactResult(experiment.result),
    availableViews: ['summary', 'diagnostics', 'raw'],
  };
}

function compactResult(result = {}) {
  const baseline = result.baseline || {};
  const candidate = result.candidate || {};
  return {
    mode: result.mode,
    balanceId: result.balanceId || result.spec?.balanceId,
    solved: result.solved ?? baseline.score?.violations === 0,
    changed: result.changed ?? false,
    baseline: {
      outputs: baseline.outputs || result.outputs || {},
      score: baseline.score || result.score || {},
    },
    candidate: result.candidate ? {
      parameters: candidate.parameters || {},
      outputs: candidate.outputs || {},
      score: candidate.score || {},
    } : null,
    observationCount: result.observationSet?.observations?.length || 0,
  };
}

function diagnosticView(experiment, { metricId, policyId }) {
  const result = experiment.result || {};
  const response = {
    experiment: summaryView(experiment),
    filters: {
      metricId: metricId || null,
      policyId: policyId || null,
    },
    metrics: selectMetrics(result, metricId),
    policy: policyId ? selectPolicyDiagnostics(result, policyId) : null,
  };
  return response;
}

function selectMetrics(result, metricId) {
  const ids = metricId
    ? [metricId]
    : [...new Set([
      ...Object.keys(result.baseline?.statistics || result.statistics || {}),
      ...Object.keys(result.candidate?.statistics || {}),
    ])];
  return Object.fromEntries(ids.map((id) => [id, {
    baseline: result.baseline?.statistics?.[id] || result.statistics?.[id] || null,
    candidate: result.candidate?.statistics?.[id] || null,
    target: metricTarget(result.spec?.metrics, id),
  }]));
}

function selectPolicyDiagnostics(result, policyId) {
  const sources = [
    ['baseline', result.baseline?.diagnostics || result.diagnostics],
    ['candidate', result.candidate?.diagnostics],
  ];
  return Object.fromEntries(sources.map(([label, diagnostics]) => [
    label,
    compactPolicySide(diagnostics?.seeds || [], policyId),
  ]));
}

function compactPolicySide(seeds, policyId) {
  const rows = seeds.map((entry) => ({
    seed: entry.seed,
    policy: entry.policies?.[policyId],
  })).filter((entry) => entry.policy);
  if (!rows.length) return null;
  const maximumDays = Math.max(...rows.map((row) => row.policy.timeline?.length || 0));
  return {
    contract: rows[0].policy.contract,
    seeds: rows.map((row) => row.seed),
    failureCauses: mergeCauseCounts(rows.map((row) => row.policy.failureCauses || {})),
    eventCounts: sumObjects(rows.map((row) => row.policy.eventCounts || {})),
    timeline: Array.from({ length: maximumDays }, (_, index) => {
      const days = rows.map((row) => row.policy.timeline?.[index]).filter(Boolean);
      return {
        day: index + 1,
        reachedRate: average(days.map((day) => day.reachedRate)),
        endAssets: averageSummary(days.map((day) => day.endAssets)),
        profit: averageSummary(days.map((day) => day.profit)),
        informationSpent: averageSummary(days.map((day) => day.informationSpent)),
        wins: averageSummary(days.map((day) => day.wins)),
      };
    }),
  };
}

function mergeCauseCounts(rows) {
  const counts = {};
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) counts[key] = (counts[key] || 0) + Number(value.count || 0);
  }
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(Object.entries(counts).map(([key, count]) => [key, {
    count,
    rate: count / Math.max(1, total) * 100,
  }]));
}

function sumObjects(rows) {
  const output = {};
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) output[key] = (output[key] || 0) + Number(value || 0);
  }
  return output;
}

function averageSummary(rows) {
  const keys = ['mean', 'p10', 'median', 'p90', 'minimum', 'maximum'];
  return Object.fromEntries(keys.map((key) => [key, average(rows.map((row) => row?.[key]))]));
}

function average(values) {
  const numeric = values.map(Number).filter(Number.isFinite);
  return numeric.reduce((sum, value) => sum + value, 0) / Math.max(1, numeric.length);
}

function metricTarget(metrics, metricId) {
  const metric = (metrics || []).find((item) => item.metricId === metricId);
  return metric ? {
    minimum: metric.minimum,
    maximum: metric.maximum,
    target: metric.target,
    weight: metric.weight,
  } : null;
}
