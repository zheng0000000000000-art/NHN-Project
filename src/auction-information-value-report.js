import { analyzeInformationValue } from './auction-information-value.js';
import { compareHumanAndAiPolicies } from './auction-policy-comparison.js';

// Presents the numbers scattered across analyzeInformationValue (regret) and
// compareHumanAndAiPolicies (return) as one side-by-side report, adds a
// payback distribution neither of those modules computes on its own, and
// compares the session's live prices against a balance-tuning candidate.
export function buildInformationValueReport(session, config, { priceExperiment = null } = {}) {
  const informationValue = analyzeInformationValue(session);
  const policyComparison = compareHumanAndAiPolicies(session, config);

  const human = {
    id: 'human',
    label: 'Human',
    roiPercent: policyComparison.human.roiPercent,
    realizedProfit: policyComparison.human.realizedProfit,
    informationSpent: policyComparison.human.informationSpent,
    regret: informationValue.regret,
    paybackLotIndex: humanPaybackLotIndex(session),
  };

  const policies = policyComparison.policies.map((policy) => ({
    id: policy.id,
    label: policy.label,
    roiPercent: policy.roiPercent,
    realizedProfit: policy.realizedProfit,
    informationSpent: policy.informationSpent,
    regret: policy.regret,
    paybackLotIndex: policy.paybackLotIndex,
  }));

  const entries = [human, ...policies];
  const prices = comparePrices(priceExperiment);

  return {
    seed: session.seed,
    returns: entries.map((entry) => ({ id: entry.id, label: entry.label, roiPercent: entry.roiPercent, realizedProfit: entry.realizedProfit })),
    regret: entries.map((entry) => ({ id: entry.id, label: entry.label, regret: entry.regret })),
    payback: entries.map((entry) => ({
      id: entry.id,
      label: entry.label,
      informationSpent: entry.informationSpent,
      paybackLotIndex: entry.paybackLotIndex,
      paidBack: entry.informationSpent > 0 ? entry.paybackLotIndex !== null : null,
    })),
    prices,
    recommendedNextExperiment: recommendNextExperiment({ entries, prices }),
  };
}

// Mirrors runPolicy's payback rule in auction-policy-comparison.js: the first
// lot (in play order) where cumulative realized profit catches up with
// cumulative information spend. A policy that never spends has nothing to
// pay back, so it stays null rather than reporting a trivial lot 1 payback.
function humanPaybackLotIndex(session) {
  let spend = 0;
  let profit = 0;
  for (const decision of session.decisions || []) {
    if (decision.type === 'BUY_APPRAISAL' || decision.type === 'BUY_DEMAND') {
      spend += number(decision.cost, 0);
    } else if (decision.type === 'BID' || decision.type === 'PASS') {
      if (decision.won) profit += number(decision.profit, 0);
      if (spend > 0 && profit >= spend) return decision.lot;
    }
  }
  return null;
}

// priceExperiment is a stored balance-tuning experiment's `result` (the shape
// tuneBalance returns: spec.parameters as baseline, candidate.parameters as
// the searched replacement). Only meaningful for tune-mode experiments with a
// parameterSpace - anything else yields no price comparison.
function comparePrices(priceExperiment) {
  const space = priceExperiment?.spec?.parameterSpace;
  if (!Array.isArray(space) || !space.length || !priceExperiment.candidate) return null;
  const baselineParameters = priceExperiment.spec?.parameters || {};
  const candidateParameters = priceExperiment.candidate?.parameters || {};
  return space.map((entry) => {
    const baseline = number(baselineParameters[entry.parameterId], null);
    const candidate = number(candidateParameters[entry.parameterId], null);
    return {
      parameterId: entry.parameterId,
      path: entry.path,
      baseline,
      candidate,
      delta: baseline != null && candidate != null ? round2(candidate - baseline) : null,
      percentChange: baseline ? round2((candidate - baseline) / baseline * 100) : null,
    };
  });
}

function recommendNextExperiment({ entries, prices }) {
  const aiEntries = entries.filter((entry) => entry.id !== 'human');
  const worstRegret = [...aiEntries].sort((a, b) => b.regret - a.regret)[0] || null;
  const unpaidBack = aiEntries.filter((entry) => entry.informationSpent > 0 && entry.paybackLotIndex === null);

  if (unpaidBack.length) {
    const target = unpaidBack[0];
    return {
      title: `Re-run information-price-tuning centered on the ${target.label} policy`,
      rationale: `${target.label} spent ${target.informationSpent} on information but never recouped it within this session (no payback lot). Re-run examples/balance/information-price-tuning.json with the appraisal/demand price bounds tightened around this session's seed to find prices where a selective buyer breaks even.`,
      reference: 'examples/balance/information-price-tuning.json',
    };
  }

  if (prices && prices.some((entry) => entry.delta !== null && entry.delta !== 0)) {
    const changed = prices.filter((entry) => entry.delta !== null && entry.delta !== 0);
    return {
      title: 'Apply the tuned candidate prices and replay this seed',
      rationale: `The last tuning run moved ${changed.map((entry) => entry.parameterId).join(', ')} away from baseline. Replay this session's seed with the candidate prices applied to confirm regret and payback improve outside simulation before applying it globally.`,
      reference: 'examples/balance/information-price-tuning.json',
    };
  }

  return {
    title: `Widen seed coverage for the ${worstRegret ? worstRegret.label : 'policy'} comparison`,
    rationale: `This report is based on a single shared-seed session. ${worstRegret ? `${worstRegret.label} carried the highest regret (${worstRegret.regret}).` : 'No policy stood out.'} Re-run the human-vs-AI comparison across the balance seed set to confirm the ranking holds before changing prices.`,
    reference: 'src/auction-policy-comparison.js',
  };
}

function number(value, fallback) {
  const candidate = Number(value);
  return Number.isFinite(candidate) ? candidate : fallback;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}
