import { HttpError } from './utils.js';

const DEFAULT_EXPECTED_DEMAND_MULTIPLIER = 1.05;
const VALUE_INFORMATION_PRIORITY_THRESHOLD = 1;

// Each policy only ever reads blindEstimate/appraisalEstimate/demandEstimate/
// informationPriority when deciding a bid. clearingPrice and trueSalePrice -
// the hidden truth of a lot - are read only after the bid is placed, exactly
// like a human player who submits a bid before the competition line and the
// resale outcome are revealed.
const POLICY_DEFINITIONS = {
  conservative: {
    label: 'Conservative',
    buysAppraisal: () => true,
    buysDemand: () => true,
    targetMarginRate: 0.15,
  },
  value: {
    label: 'Value',
    buysAppraisal: (lot) => lot.informationPriority >= VALUE_INFORMATION_PRIORITY_THRESHOLD,
    buysDemand: (lot) => lot.informationPriority >= VALUE_INFORMATION_PRIORITY_THRESHOLD,
    targetMarginRate: 0.08,
  },
  speculative: {
    label: 'Speculative',
    buysAppraisal: () => false,
    buysDemand: () => false,
    targetMarginRate: 0.02,
  },
};

// Compares a completed human play session against conservative/value/speculative
// AI policies replayed over the exact same session.lots - the world the human
// played was generated from session.seed, so this is a shared-seed comparison
// rather than a fresh simulation with independently sampled lots.
export function compareHumanAndAiPolicies(session, config) {
  if (!session || !Array.isArray(session.lots) || !session.lots.length) {
    throw new HttpError(409, 'Session has no generated lots to compare.');
  }

  const startingAssets = number(session.startingAssets, number(config?.economy?.startingAssets, 20_000));
  const saleFeeRate = number(session.rules?.saleFeeRate, number(config?.economy?.saleFeeRate, 0.05));
  const appraisalPriceRate = number(
    session.rules?.appraisalPriceRate,
    number(config?.information?.appraisalPriceRate, 0.05),
  );
  const demandPriceAssetRate = number(
    session.rules?.demandPriceAssetRate,
    number(config?.information?.demandPriceAssetRate, 0.01),
  );
  const lotsPerDay = integer(session.rules?.lotsPerDay, integer(config?.auction?.lotsPerDay, 8));
  const ruinThresholdRatio = number(config?.economy?.ruinThresholdRatio, 0.1);
  const expectedDemandMultiplier = number(
    config?.economy?.expectedDemandMultiplier,
    DEFAULT_EXPECTED_DEMAND_MULTIPLIER,
  );

  const rules = {
    startingAssets, saleFeeRate, appraisalPriceRate, demandPriceAssetRate,
    lotsPerDay, ruinThresholdRatio, expectedDemandMultiplier,
  };

  const humanLotsSeen = session.decisions.filter((decision) => decision.type === 'BID' || decision.type === 'PASS').length;
  const human = {
    startingAssets,
    endAssets: session.cash,
    roiPercent: percent(session.cash, startingAssets),
    informationSpent: round2(session.informationSpent),
    informationSpendRate: startingAssets > 0 ? round2(session.informationSpent / startingAssets * 100) : 0,
    wins: session.wins,
    lotsSeen: humanLotsSeen,
    lotWinRate: humanLotsSeen ? round2(session.wins / humanLotsSeen * 100) : 0,
    realizedProfit: round2(session.realizedProfit),
  };

  const policies = Object.keys(POLICY_DEFINITIONS).map((policyId) => {
    const result = runPolicy(policyId, session.lots, rules);
    return {
      ...result,
      vsHuman: {
        roiPercentDelta: round2(result.roiPercent - human.roiPercent),
        realizedProfitDelta: round2(result.realizedProfit - human.realizedProfit),
        lotWinRateDelta: round2(result.lotWinRate - human.lotWinRate),
      },
    };
  });

  return {
    seed: session.seed,
    comparison: { commonWorldSeed: session.seed, sharedLotCount: session.lots.length },
    human,
    policies,
  };
}

function runPolicy(policyId, lots, rules) {
  const definition = POLICY_DEFINITIONS[policyId];
  let cash = rules.startingAssets;
  let informationSpent = 0;
  let wins = 0;
  let realizedProfit = 0;
  let lotsSeen = 0;
  let ruined = false;
  let regret = 0;
  let paybackLotIndex = null;

  for (const lot of lots) {
    if (cash <= rules.startingAssets * rules.ruinThresholdRatio) { ruined = true; break; }
    lotsSeen += 1;

    const buyAppraisal = definition.buysAppraisal(lot);
    const buyDemand = definition.buysDemand(lot);
    const appraisalCost = buyAppraisal ? informationCost(lot.baseValue * rules.appraisalPriceRate) : 0;
    const demandCost = buyDemand ? informationCost(cash * rules.demandPriceAssetRate / rules.lotsPerDay) : 0;
    const spend = Math.min(cash, appraisalCost + demandCost);
    cash -= spend;
    informationSpent += spend;

    // Decision inputs are limited to estimates - never clearingPrice/trueSalePrice.
    const valueEstimate = buyAppraisal && Number.isFinite(lot.appraisalEstimate) ? lot.appraisalEstimate : lot.blindEstimate;
    const demandEstimate = buyDemand && Number.isFinite(lot.demandEstimate) ? lot.demandEstimate : rules.expectedDemandMultiplier;
    const expectedNetSale = valueEstimate * demandEstimate * (1 - rules.saleFeeRate);
    const bid = Math.max(0, roundTo100(expectedNetSale * (1 - definition.targetMarginRate)));

    // Hidden truth (clearingPrice, trueSalePrice) is only consulted now, at settlement.
    const won = bid > 0 && bid >= lot.clearingPrice && cash >= lot.clearingPrice;
    let lotProfit = 0;
    if (won) {
      const netSale = lot.trueSalePrice * (1 - rules.saleFeeRate);
      lotProfit = netSale - lot.clearingPrice;
      cash += lotProfit;
      wins += 1;
      realizedProfit += lotProfit;
    }

    // Same regret definition as analyzeInformationValue: the profit a perfectly-informed
    // bidder would have captured on this lot, minus what the policy actually captured.
    const trueNetSale = lot.trueSalePrice * (1 - rules.saleFeeRate);
    const optimalProfit = trueNetSale > lot.clearingPrice ? trueNetSale - lot.clearingPrice : 0;
    regret += Math.max(0, optimalProfit - lotProfit);

    if (paybackLotIndex === null && informationSpent > 0 && realizedProfit >= informationSpent) paybackLotIndex = lotsSeen;
  }

  return {
    id: policyId,
    label: definition.label,
    startingAssets: rules.startingAssets,
    endAssets: round2(cash),
    roiPercent: percent(cash, rules.startingAssets),
    informationSpent: round2(informationSpent),
    informationSpendRate: rules.startingAssets > 0 ? round2(informationSpent / rules.startingAssets * 100) : 0,
    wins,
    lotsSeen,
    lotWinRate: lotsSeen ? round2(wins / lotsSeen * 100) : 0,
    realizedProfit: round2(realizedProfit),
    regret: round2(regret),
    paybackLotIndex,
    ruined,
  };
}

function informationCost(value) {
  return value > 0 ? Math.max(100, roundTo100(value)) : 0;
}

function roundTo100(value) {
  return Math.round(value / 100) * 100;
}

function percent(endAssets, startingAssets) {
  return startingAssets > 0 ? round2((endAssets / startingAssets - 1) * 100) : 0;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function integer(value, fallback) {
  const candidate = Number(value);
  return Number.isFinite(candidate) ? Math.round(candidate) : fallback;
}

function number(value, fallback) {
  const candidate = Number(value);
  return Number.isFinite(candidate) ? candidate : fallback;
}
