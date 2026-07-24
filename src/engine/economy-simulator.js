const DEFAULT_POLICIES = ['blind', 'appraisal', 'demand', 'informed'];

export function simulateAuctionEconomy(gameData, { seed = 42, runs = 500, policies = DEFAULT_POLICIES } = {}) {
  const baseline = structuredClone(gameData);
  const random = seededRandom(seed);
  const policyContracts = normalizePolicies(policies);
  const results = Object.fromEntries(policyContracts.map((policy) => [policy.id, []]));

  for (let run = 0; run < Math.max(0, runs); run += 1) {
    const worldSeed = Math.floor(random() * 0xFFFFFFFF);
    for (const policy of policyContracts) {
      results[policy.id].push(simulateRun(baseline, policy, worldSeed));
    }
  }

  const metrics = {};
  const diagnostics = { policies: {}, comparison: { commonWorldSeeds: true } };
  for (const policy of policyContracts) {
    const rows = results[policy.id];
    const endAssets = rows.map((row) => row.endAssets).sort((a, b) => a - b);
    const returns = rows.map((row) => row.roiPercent).sort((a, b) => a - b);
    metrics[`${policy.id}EndAssetsP10`] = percentile(endAssets, 0.1);
    metrics[`${policy.id}EndAssetsP50`] = percentile(endAssets, 0.5);
    metrics[`${policy.id}EndAssetsP90`] = percentile(endAssets, 0.9);
    metrics[`${policy.id}RoiMean`] = mean(returns);
    metrics[`${policy.id}TransactionRoiMean`] = mean(rows.map((row) => row.transactionRoiPercent));
    metrics[`${policy.id}NegativeDayRate`] = mean(rows.map((row) => row.negativeDayRate));
    metrics[`${policy.id}DailyGrowthRate`] = mean(rows.map((row) => row.dailyGrowthRate));
    metrics[`${policy.id}LossRate`] = ratio(rows, (row) => row.endAssets < row.startAssets) * 100;
    metrics[`${policy.id}RuinRate`] = ratio(rows, (row) => row.ruined) * 100;
    metrics[`${policy.id}LotWinRate`] = mean(rows.map((row) => row.lotWinRate));
    metrics[`${policy.id}NoContestRate`] = mean(rows.map((row) => row.noContestRate));
    for (const gradeId of ['common', 'rare', 'epic', 'legendary']) {
      metrics[`${policy.id}${capitalize(gradeId)}NoContestRate`] =
        mean(rows.map((row) => row.gradeNoContestRates[gradeId] ?? 0));
      metrics[`${policy.id}${capitalize(gradeId)}ProfitableNoContestRate`] =
        mean(rows.map((row) => row.gradeProfitableNoContestRates[gradeId] ?? 0));
    }
    metrics[`${policy.id}InformationSpendRate`] = mean(rows.map((row) => row.informationSpendRate));
    diagnostics.policies[policy.id] = {
      contract: policy,
      timeline: aggregateTimeline(rows),
      failureCauses: countBy(rows, (row) => row.failureCause),
      eventCounts: sumObjects(rows.map((row) => row.eventCounts)),
    };
  }
  metrics.informationAdvantage = metrics.informedRoiMean - metrics.blindRoiMean;
  metrics.informationTransactionAdvantage =
    metrics.informedTransactionRoiMean - metrics.blindTransactionRoiMean;
  metrics.informationLossReduction = metrics.blindLossRate - metrics.informedLossRate;
  metrics.botValueLeakageResidual = botValueLeakageResidual(baseline, seed, Math.max(200, runs));

  return {
    metrics,
    policies: policyContracts,
    runs,
    seed,
    diagnostics,
    distributions: Object.fromEntries(Object.entries(results).map(([policy, rows]) => [policy, {
      endAssets: summarize(rows.map((row) => row.endAssets)),
      roiPercent: summarize(rows.map((row) => row.roiPercent)),
    }])),
  };
}

export function economyMetric(metricId, result) {
  return result?.metrics?.[metricId] ?? null;
}

function simulateRun(config, policy, worldSeed) {
  const random = seededRandom(worldSeed);
  const observationRandom = seededRandom(worldSeed ^ hashString(policy.id));
  const startAssets = number(config.economy?.startingAssets, 20_000);
  const days = integer(config.economy?.days, 12);
  const lotsPerDay = integer(config.auction?.lotsPerDay, 8);
  const feeRate = number(config.economy?.saleFeeRate, 0.05);
  let cash = startAssets;
  let informationSpent = 0;
  let wins = 0;
  let contests = 0;
  let noContests = 0;
  const gradeLots = {};
  const gradeNoContests = {};
  const profitableGradeLots = {};
  const profitableGradeNoContests = {};
  let acquisitionSpent = 0;
  let netSales = 0;
  const botProfiles = createBotProfiles(config, random);
  const timeline = [];
  const eventCounts = {
    lotsOpened: 0,
    informationPurchases: 0,
    bidsWon: 0,
    bidsRejectedByMargin: 0,
    bidsRejectedByCash: 0,
    sales: 0,
  };

  for (let day = 1; day <= days; day += 1) {
    if (cash <= startAssets * number(config.economy?.ruinThresholdRatio, 0.1)) break;
    const dayStartAssets = cash;
    let dayWins = 0;
    let dayInformationSpent = 0;
    let informationPurchasesRemaining = policy.maxPurchasesPerDay;
    for (let lotIndex = 0; lotIndex < lotsPerDay; lotIndex += 1) {
      eventCounts.lotsOpened += 1;
      const lot = createLot(config, random);
      const information = observeLot(config, lot, policy, cash, observationRandom, informationPurchasesRemaining);
      cash -= information.cost;
      informationSpent += information.cost;
      dayInformationSpent += information.cost;
      if (information.cost > 0) {
        eventCounts.informationPurchases += 1;
        informationPurchasesRemaining -= 1;
      }
      const playerMax = Math.max(0, information.expectedSale * (1 - number(config.player?.targetMarginRate, 0.08)));
      const botBids = createBotBids(config, lot, cash, random, botProfiles);
      const activeBots = botBids.filter((bid) => bid >= lot.startBid);
      gradeLots[lot.gradeId] = (gradeLots[lot.gradeId] || 0) + 1;
      const profitableAtStart = lot.trueSalePrice * (1 - feeRate) > lot.startBid;
      if (profitableAtStart) {
        profitableGradeLots[lot.gradeId] = (profitableGradeLots[lot.gradeId] || 0) + 1;
      }
      if (!activeBots.length) {
        noContests += 1;
        gradeNoContests[lot.gradeId] = (gradeNoContests[lot.gradeId] || 0) + 1;
        if (profitableAtStart) {
          profitableGradeNoContests[lot.gradeId] = (profitableGradeNoContests[lot.gradeId] || 0) + 1;
        }
      }
      else contests += 1;
      const highestBot = Math.max(0, ...botBids);
      const increment = Math.max(100, roundTo100(highestBot * number(config.auction?.minimumIncrementRate, 0.1)));
      const price = Math.max(lot.startBid, highestBot + increment);
      if (playerMax >= price && cash >= price) {
        cash -= price;
        const netSale = lot.trueSalePrice * (1 - feeRate);
        cash += netSale;
        acquisitionSpent += price;
        netSales += netSale;
        wins += 1;
        dayWins += 1;
        eventCounts.bidsWon += 1;
        eventCounts.sales += 1;
      } else if (playerMax < price) {
        eventCounts.bidsRejectedByMargin += 1;
      } else {
        eventCounts.bidsRejectedByCash += 1;
      }
    }
    timeline.push({
      day,
      startAssets: dayStartAssets,
      endAssets: cash,
      profit: cash - dayStartAssets,
      informationSpent: dayInformationSpent,
      wins: dayWins,
    });
  }

  const totalLots = days * lotsPerDay;
  const ruined = cash <= startAssets * number(config.economy?.ruinThresholdRatio, 0.1);
  const completedDays = Math.max(1, timeline.length);
  return {
    startAssets,
    endAssets: cash,
    roiPercent: (cash / startAssets - 1) * 100,
    transactionRoiPercent: acquisitionSpent > 0 ? (netSales / acquisitionSpent - 1) * 100 : 0,
    negativeDayRate: ratio(timeline, (day) => day.profit < 0) * 100,
    dailyGrowthRate: (Math.pow(Math.max(0.000001, cash / startAssets), 1 / completedDays) - 1) * 100,
    ruined,
    failureCause: ruined ? 'RUINED' : cash < startAssets ? 'ENDED_BELOW_START' : 'NONE',
    lotWinRate: wins / totalLots * 100,
    noContestRate: noContests / Math.max(1, noContests + contests) * 100,
    gradeNoContestRates: Object.fromEntries(Object.entries(gradeLots).map(([gradeId, count]) => [
      gradeId,
      (gradeNoContests[gradeId] || 0) / Math.max(1, count) * 100,
    ])),
    gradeProfitableNoContestRates: Object.fromEntries(Object.entries(profitableGradeLots).map(([gradeId, count]) => [
      gradeId,
      (profitableGradeNoContests[gradeId] || 0) / Math.max(1, count) * 100,
    ])),
    informationSpendRate: informationSpent / startAssets * 100,
    timeline,
    eventCounts,
  };
}

function createLot(config, random) {
  const grades = Array.isArray(config.grades) ? config.grades : [];
  const grade = weightedChoice(grades, random);
  const baseValue = number(grade?.baseValue, 1_500);
  const target = number(config.economy?.expectedDemandMultiplier, 1.05);
  const demandMultiplier = sampleAroundMean(
    random,
    number(grade?.demandMinimum, 0.95),
    target,
    number(grade?.demandMaximum, 1.1),
  );
  return {
    gradeId: grade?.id || 'unknown',
    category: weightedChoice(
      (Array.isArray(config.categories) ? config.categories : []).map((id) => ({ id, weight: 1 })),
      random,
    )?.id || 'general',
    informationPriority: number(grade?.informationPriority, 0),
    baseValue,
    demandMultiplier,
    trueSalePrice: baseValue * demandMultiplier,
    startBid: roundTo100(baseValue * number(config.auction?.startBidRatio, 0.5)),
  };
}

function observeLot(config, lot, policy, cash, random, purchasesRemaining) {
  const appraisalError = number(config.information?.appraisalErrorRate, 0.2);
  const demandError = number(config.information?.demandErrorRate, 0.15);
  let observedValue = lot.baseValue * (1 + symmetric(random, number(config.information?.blindValueErrorRate, 0.35)));
  let observedDemand = number(config.economy?.expectedDemandMultiplier, 1.05);
  let cost = 0;
  const shouldBuy = purchasesRemaining > 0 && (
    policy.acquisition === 'EVERY_LOT'
    || (policy.acquisition === 'SELECTIVE' && lot.informationPriority >= policy.minimumPriority)
  );
  if (!shouldBuy) return { expectedSale: observedValue * observedDemand, cost: 0 };
  if (policy.information.includes('appraisal')) {
    observedValue = lot.baseValue * (1 + symmetric(random, appraisalError));
    cost += lot.baseValue * number(config.information?.appraisalPriceRate, 0.05);
  }
  if (policy.information.includes('demand')) {
    observedDemand = lot.demandMultiplier * (1 + symmetric(random, demandError));
    cost += cash * number(config.information?.demandPriceAssetRate, 0.01) / integer(config.auction?.lotsPerDay, 8);
  }
  return { expectedSale: observedValue * observedDemand, cost: Math.min(cost, cash) };
}

function normalizePolicies(policies) {
  const source = Array.isArray(policies) && policies.length ? policies : DEFAULT_POLICIES;
  return source.map((policy) => {
    if (typeof policy === 'string') {
      return {
        id: policy,
        information: policy === 'informed' ? ['appraisal', 'demand']
          : ['appraisal', 'demand'].filter((item) => item === policy),
        acquisition: 'EVERY_LOT',
        maxPurchasesPerDay: Number.POSITIVE_INFINITY,
        minimumPriority: 0,
      };
    }
    const id = String(policy?.id || '').trim();
    if (!id) throw new Error('Economy policy contracts need an id.');
    return {
      id,
      information: [...new Set(Array.isArray(policy.information) ? policy.information.map(String) : [])],
      acquisition: String(policy.acquisition || 'EVERY_LOT'),
      maxPurchasesPerDay: nonNegative(policy.maxPurchasesPerDay, Number.POSITIVE_INFINITY),
      minimumPriority: number(policy.minimumPriority, 0),
    };
  });
}

function aggregateTimeline(rows) {
  const maximumDay = Math.max(0, ...rows.map((row) => row.timeline.length));
  const timeline = [];
  for (let dayIndex = 0; dayIndex < maximumDay; dayIndex += 1) {
    const dayRows = rows.map((row) => row.timeline[dayIndex]).filter(Boolean);
    const assets = dayRows.map((row) => row.endAssets).sort((a, b) => a - b);
    timeline.push({
      day: dayIndex + 1,
      reachedRate: dayRows.length / Math.max(1, rows.length) * 100,
      endAssets: summarize(assets),
      profit: summarize(dayRows.map((row) => row.profit)),
      informationSpent: summarize(dayRows.map((row) => row.informationSpent)),
      wins: summarize(dayRows.map((row) => row.wins)),
    });
  }
  return timeline;
}

function countBy(rows, selector) {
  const counts = {};
  for (const row of rows) {
    const key = selector(row) || 'UNKNOWN';
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).map(([key, count]) => [key, {
    count,
    rate: count / Math.max(1, rows.length) * 100,
  }]));
}

function sumObjects(rows) {
  const result = {};
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) result[key] = (result[key] || 0) + value;
  }
  return result;
}

function hashString(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createBotProfiles(config, random) {
  const count = integer(config.bots?.count, 3);
  const categories = Array.isArray(config.categories) && config.categories.length ? config.categories : ['general'];
  return Array.from({ length: count }, (_, index) => ({
    id: `bot-${index + 1}`,
    interests: Object.fromEntries(categories.map((category) => [
      category,
      randomBetween(random, 0, 1),
    ])),
  }));
}

function createBotBids(config, lot, playerCash, random, profiles = createBotProfiles(config, random)) {
  const bids = [];
  for (const profile of profiles) {
    const estimate = lot.baseValue * lot.demandMultiplier
      * (1 + symmetric(random, number(config.bots?.estimateErrorRate, 0.3)));
    const expectedMargin = (estimate * (1 - number(config.economy?.saleFeeRate, 0.05)) - lot.startBid)
      / Math.max(1, estimate);
    const interest = (profile.interests[lot.category] ?? 0)
      + lot.informationPriority * number(config.bots?.gradeInterestBonus, 0.12);
    const budget = Math.max(
      number(config.bots?.minimumBudget, 0),
      playerCash * randomBetween(random,
        number(config.bots?.budgetMinimumRatio, 0.6),
        number(config.bots?.budgetMaximumRatio, 1.2)),
    );
    const spendableBudget = Math.max(0, budget - playerCash * number(config.bots?.reserveCashRate, 0.25));
    if (interest < number(config.bots?.interestThreshold, 0.5)
      || expectedMargin < number(config.bots?.minimumExpectedMargin, 0.08)
      || spendableBudget < lot.startBid) {
      bids.push(0);
      continue;
    }
    const circumstanceActive = random() < number(config.bots?.circumstanceDensity, 0.35);
    const circumstance = circumstanceActive
      ? lot.baseValue * randomBetween(random,
        number(config.bots?.circumstanceMinimumRatio, 0.45),
        number(config.bots?.circumstanceMaximumRatio, 1.15))
      : 0;
    bids.push(Math.min(spendableBudget, Math.max(estimate * number(config.bots?.marketBidRatio, 0.78), circumstance)));
  }
  return bids;
}

function botValueLeakageResidual(config, seed, samples) {
  const random = seededRandom(seed ^ 0xA53C9E1);
  const values = [];
  const bids = [];
  const groups = [];
  for (let index = 0; index < samples; index += 1) {
    const lot = createLot(config, random);
    values.push(lot.trueSalePrice);
    bids.push(Math.max(...createBotBids(config, lot, number(config.economy?.startingAssets, 20_000), random)));
    groups.push(`${lot.baseValue}:${lot.category}`);
  }
  return Math.abs(correlation(residualize(values, groups), residualize(bids, groups)));
}

function residualize(values, groups) {
  const grouped = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const bucket = grouped.get(groups[index]) || [];
    bucket.push(values[index]);
    grouped.set(groups[index], bucket);
  }
  const means = new Map([...grouped].map(([key, rows]) => [key, mean(rows)]));
  return values.map((value, index) => value - means.get(groups[index]));
}

function weightedChoice(rows, random) {
  const total = rows.reduce((sum, row) => sum + Math.max(0, number(row.weight, 0)), 0);
  if (!rows.length || total <= 0) return null;
  let cursor = random() * total;
  for (const row of rows) {
    cursor -= Math.max(0, number(row.weight, 0));
    if (cursor <= 0) return row;
  }
  return rows.at(-1);
}

function sampleAroundMean(random, minimum, target, maximum) {
  const lowerDistance = Math.max(0, target - minimum);
  const upperDistance = Math.max(0, maximum - target);
  if (!lowerDistance || !upperDistance) return target;
  const lowerProbability = upperDistance / (lowerDistance + upperDistance);
  return random() < lowerProbability
    ? target - random() * lowerDistance
    : target + random() * upperDistance;
}

function correlation(left, right) {
  const leftMean = mean(left);
  const rightMean = mean(right);
  let numerator = 0;
  let leftSquare = 0;
  let rightSquare = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] - leftMean;
    const b = right[index] - rightMean;
    numerator += a * b;
    leftSquare += a * a;
    rightSquare += b * b;
  }
  return numerator / Math.sqrt(leftSquare * rightSquare || 1);
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    mean: mean(values),
    p10: percentile(sorted, 0.1),
    median: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    minimum: sorted[0] ?? 0,
    maximum: sorted.at(-1) ?? 0,
  };
}

function ratio(rows, predicate) {
  return rows.filter(predicate).length / Math.max(1, rows.length);
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function percentile(sorted, ratioValue) {
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * ratioValue;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function seededRandom(seed) {
  let state = (Number(seed) || 1) >>> 0;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function symmetric(random, radius) {
  return (random() * 2 - 1) * radius;
}

function randomBetween(random, minimum, maximum) {
  return minimum + random() * (maximum - minimum);
}

function roundTo100(value) {
  return Math.round(value / 100) * 100;
}

function integer(value, fallback) {
  const candidate = Number(value);
  return Number.isFinite(candidate) ? Math.round(candidate) : fallback;
}

function nonNegative(value, fallback) {
  const candidate = Number(value);
  return Number.isFinite(candidate) && candidate >= 0 ? candidate : fallback;
}

function capitalize(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : '';
}

function number(value, fallback) {
  const candidate = Number(value);
  return Number.isFinite(candidate) ? candidate : fallback;
}
