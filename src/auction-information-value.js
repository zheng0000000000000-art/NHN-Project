const DEFAULT_DEMAND_MULTIPLIER = 1.05;

// Reads a session as saved by AuctionPlaySessionStore. Only touches fields that
// have existed since the store's first schema (lots[], decisions[], rules{}),
// so it works unchanged on sessions written before this analysis existed.
export function analyzeInformationValue(session) {
  if (!session || !Array.isArray(session.decisions)) return emptySummary();

  const saleFeeRate = number(session.rules?.saleFeeRate, 0.05);
  const lots = Array.isArray(session.lots) ? session.lots : [];

  const byLot = new Map();
  for (const decision of session.decisions) {
    const lotNumber = Number(decision.lot);
    if (!Number.isFinite(lotNumber)) continue;
    if (!byLot.has(lotNumber)) byLot.set(lotNumber, []);
    byLot.get(lotNumber).push(decision);
  }

  const bidChanges = [];
  let avoidedLosses = 0;
  let missedOpportunities = 0;
  let informationSpent = 0;
  let informedLotCount = 0;

  for (const [lotNumber, lotDecisions] of byLot) {
    const lot = lots[lotNumber - 1] || null;
    const resolveDecision = lotDecisions.find((item) => item.type === 'BID' || item.type === 'PASS');
    const purchases = lotDecisions.filter((item) => item.type === 'BUY_APPRAISAL' || item.type === 'BUY_DEMAND');

    let revealedAppraisal = false;
    let revealedDemand = false;
    let priorModeledBid = lot ? modeledBid(lot, revealedAppraisal, revealedDemand, saleFeeRate) : null;
    for (const purchase of purchases) {
      const cost = number(purchase.cost, 0);
      informationSpent += cost;
      if (purchase.type === 'BUY_APPRAISAL') revealedAppraisal = true;
      if (purchase.type === 'BUY_DEMAND') revealedDemand = true;
      const afterModeledBid = lot ? modeledBid(lot, revealedAppraisal, revealedDemand, saleFeeRate) : null;
      bidChanges.push({
        lot: lotNumber,
        type: purchase.type,
        cost,
        beforeModeledBid: priorModeledBid,
        afterModeledBid,
        bidShift: priorModeledBid != null && afterModeledBid != null ? afterModeledBid - priorModeledBid : null,
      });
      priorModeledBid = afterModeledBid;
    }

    if (!resolveDecision || purchases.length === 0) continue;

    const clearingPrice = number(resolveDecision.clearingPrice, lot?.clearingPrice);
    const trueSalePrice = number(resolveDecision.trueSalePrice, lot?.trueSalePrice);
    if (!Number.isFinite(clearingPrice) || !Number.isFinite(trueSalePrice)) continue;

    informedLotCount += 1;
    const trueNetSale = trueSalePrice * (1 - saleFeeRate);
    const wouldBeProfitable = trueNetSale > clearingPrice;
    const won = Boolean(resolveDecision.won);

    if (!wouldBeProfitable && !won) {
      avoidedLosses += Math.max(0, clearingPrice - trueNetSale);
    }
    if (wouldBeProfitable && !won) {
      missedOpportunities += Math.max(0, trueNetSale - clearingPrice);
    }
  }

  let regret = 0;
  for (const decision of session.decisions) {
    if (decision.type !== 'BID' && decision.type !== 'PASS') continue;
    const clearingPrice = number(decision.clearingPrice, null);
    const trueSalePrice = number(decision.trueSalePrice, null);
    if (clearingPrice == null || trueSalePrice == null) continue;
    const trueNetSale = trueSalePrice * (1 - saleFeeRate);
    const optimalProfit = trueNetSale > clearingPrice ? trueNetSale - clearingPrice : 0;
    const actualProfit = decision.won ? number(decision.profit, 0) : 0;
    regret += Math.max(0, optimalProfit - actualProfit);
  }

  const netInformationValue = avoidedLosses - missedOpportunities - informationSpent;

  return {
    informedLotCount,
    informationSpent: round2(informationSpent),
    bidChanges,
    avoidedLosses: round2(avoidedLosses),
    missedOpportunities: round2(missedOpportunities),
    netInformationValue: round2(netInformationValue),
    regret: round2(regret),
  };
}

function modeledBid(lot, appraisalRevealed, demandRevealed, saleFeeRate) {
  const valueEstimate = appraisalRevealed && Number.isFinite(lot.appraisalEstimate)
    ? lot.appraisalEstimate
    : lot.blindEstimate;
  if (!Number.isFinite(valueEstimate)) return null;
  const demandMultiplier = demandRevealed && Number.isFinite(lot.demandEstimate)
    ? lot.demandEstimate
    : DEFAULT_DEMAND_MULTIPLIER;
  const netSaleEstimate = valueEstimate * demandMultiplier * (1 - saleFeeRate);
  return Math.max(0, Math.floor(netSaleEstimate / 100) * 100);
}

function emptySummary() {
  return {
    informedLotCount: 0,
    informationSpent: 0,
    bidChanges: [],
    avoidedLosses: 0,
    missedOpportunities: 0,
    netInformationValue: 0,
    regret: 0,
  };
}

function number(value, fallback) {
  const candidate = Number(value);
  return Number.isFinite(candidate) ? candidate : fallback;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}
