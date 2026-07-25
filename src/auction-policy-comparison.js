import { HttpError } from './utils.js';

const DEFAULT_EXPECTED_DEMAND_MULTIPLIER = 1.05;
const DEFAULT_RUIN_THRESHOLD_RATIO = 0.1;

// Three AI policies replayed on the exact same lots (and therefore the same
// world seed) the human session saw, so the comparison isolates decision
// strategy rather than world variance.
export const AI_POLICIES = [
  {
    id: 'conservative',
    label: 'Conservative',
    description: 'Buys every piece of information before bidding and only bids with a wide safety margin.',
    information: ['appraisal', 'demand'],
    acquisition: 'EVERY_LOT',
    minimumPriority: 0,
    targetMarginRate: 0.16,
  },
  {
    id: 'value',
    label: 'Value',
    description: 'Buys information only for lots worth the cost and bids at a moderate margin.',
    information: ['appraisal', 'demand'],
    acquisition: 'SELECTIVE',
    minimumPriority: 1,
    targetMarginRate: 0.08,
  },
  {
    id: 'speculative',
    label: 'Speculative',
    description: 'Skips paid information and bids on the blind estimate with a thin margin.',
    information: [],
    acquisition: 'NONE',
    minimumPriority: 0,
    targetMarginRate: 0.02,
  },
];

export function compareAiPoliciesToHuman(session, config = {}) {
  if (!session || !Array.isArray(session.lots) || !session.lots.length) {
    throw new HttpError(409, 'Policy comparison needs a session with generated lots.');
  }
  if (session.status !== 'COMPLETED') {
    throw new HttpError(409, 'Policy comparison is only available once the human session has settled.');
  }

  const rules = session.rules || {};
  const shared = {
    saleFeeRate: number(rules.saleFeeRate, 0.05),
    appraisalPriceRate: number(rules.appraisalPriceRate, 0.05),
    demandPriceAssetRate: number(rules.demandPriceAssetRate, 0.01),
    lotsPerDay: integer(rules.lotsPerDay, 8),
    expectedDemandMultiplier: number(config.economy?.expectedDemandMultiplier, DEFAULT_EXPECTED_DEMAND_MULTIPLIER),
    ruinThresholdRatio: number(config.economy?.ruinThresholdRatio, DEFAULT_RUIN_THRESHOLD_RATIO),
  };

  const policies = {};
  for (const policy of AI_POLICIES) {
    policies[policy.id] = simulatePolicy(session, policy, shared);
  }

  return {
    seed: session.seed,
    sessionId: session.id,
    lotCount: session.lots.length,
    human: humanResult(session),
    policies,
  };
}

// Walks the shared lot sequence lot by lot. Each lot only exposes the
// estimates the policy chose to pay for; the lot's clearingPrice/trueSalePrice
// (hidden truth) are read only after the bid is already decided, matching the
// settlement point a human player faces.
function simulatePolicy(session, policy, shared) {
  let cash = session.startingAssets;
  let informationSpent = 0;
  let wins = 0;
  let decisions = 0;
  let ruined = false;

  for (const lot of session.lots) {
    if (cash <= session.startingAssets * shared.ruinThresholdRatio) {
      ruined = true;
      break;
    }

    let revealedAppraisal = false;
    let revealedDemand = false;
    const shouldBuy = policy.acquisition === 'EVERY_LOT'
      || (policy.acquisition === 'SELECTIVE' && number(lot.informationPriority, 0) >= policy.minimumPriority);
    if (shouldBuy) {
      if (policy.information.includes('appraisal')) {
        const cost = informationCost(lot.baseValue * shared.appraisalPriceRate);
        if (cash >= cost) {
          cash -= cost;
          informationSpent += cost;
          revealedAppraisal = true;
        }
      }
      if (policy.information.includes('demand')) {
        const cost = informationCost(cash * shared.demandPriceAssetRate / shared.lotsPerDay);
        if (cash >= cost) {
          cash -= cost;
          informationSpent += cost;
          revealedDemand = true;
        }
      }
    }

    const valueEstimate = revealedAppraisal && Number.isFinite(lot.appraisalEstimate)
      ? lot.appraisalEstimate
      : lot.blindEstimate;
    const demandMultiplier = revealedDemand && Number.isFinite(lot.demandEstimate)
      ? lot.demandEstimate
      : shared.expectedDemandMultiplier;
    const bid = Math.max(0, valueEstimate * demandMultiplier * (1 - policy.targetMarginRate));

    const won = bid >= lot.clearingPrice && cash >= lot.clearingPrice;
    decisions += 1;
    if (won) {
      const netSale = lot.trueSalePrice * (1 - shared.saleFeeRate);
      cash -= lot.clearingPrice;
      cash += netSale;
      wins += 1;
    }
  }

  return {
    cash: round2(cash),
    roiPercent: round2((cash / session.startingAssets - 1) * 100),
    informationSpent: round2(informationSpent),
    informationSpendRate: round2(informationSpent / session.startingAssets * 100),
    wins,
    decisions,
    lotWinRate: round2(wins / Math.max(1, decisions) * 100),
    ruined,
  };
}

function humanResult(session) {
  const completedLots = session.decisions.filter((decision) => decision.type === 'BID' || decision.type === 'PASS').length;
  return {
    cash: round2(session.cash),
    roiPercent: round2((session.cash / session.startingAssets - 1) * 100),
    informationSpent: round2(session.informationSpent),
    informationSpendRate: round2(session.informationSpent / session.startingAssets * 100),
    wins: session.wins,
    decisions: completedLots,
    lotWinRate: round2(session.wins / Math.max(1, completedLots) * 100),
    ruined: session.cash <= session.startingAssets * DEFAULT_RUIN_THRESHOLD_RATIO,
  };
}

function informationCost(value) {
  return value > 0 ? Math.max(100, Math.round(value / 100) * 100) : 0;
}

function number(value, fallback) {
  const candidate = Number(value);
  return Number.isFinite(candidate) ? candidate : fallback;
}

function integer(value, fallback) {
  const candidate = Number(value);
  return Number.isFinite(candidate) ? Math.round(candidate) : fallback;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}
