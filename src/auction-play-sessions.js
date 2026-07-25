import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  createAuctionBotBids,
  createAuctionBotProfiles,
  createAuctionLot,
  createSeededRandom,
} from './engine/economy-simulator.js';
import { HttpError, nowIso, randomId } from './utils.js';
import { analyzeInformationValue } from './auction-information-value.js';
import { compareHumanAndAiPolicies } from './auction-policy-comparison.js';
import { buildInformationValueReport } from './auction-information-value-report.js';

export class AuctionPlaySessionStore {
  constructor({ dataDirectory, seedPath }) {
    this.path = path.join(dataDirectory, 'auction-play-sessions.json');
    this.seedPath = seedPath;
    this.sessions = [];
    this.config = null;
  }

  async initialize() {
    await mkdir(path.dirname(this.path), { recursive: true });
    const seed = JSON.parse(await readFile(this.seedPath, 'utf8'));
    this.config = seed.baseline;
    try {
      const payload = JSON.parse(await readFile(this.path, 'utf8'));
      this.sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.save();
    }
  }

  async start(actor, { seed = Date.now() } = {}) {
    const numericSeed = (Number(seed) || Date.now()) >>> 0;
    const session = createSession(this.config, actor, numericSeed);
    this.sessions.unshift(session);
    this.sessions = this.sessions.slice(0, 200);
    await this.save();
    return publicSession(session);
  }

  get(id, actor) {
    return publicSession(this.findOwned(id, actor));
  }

  list(actor, { limit = 20 } = {}) {
    return this.sessions
      .filter((session) => session.actorUserId === actor.id)
      .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)))
      .map(summary);
  }

  async act(id, actor, action) {
    const session = this.findOwned(id, actor);
    if (session.status !== 'ACTIVE') throw new HttpError(409, 'Auction play session is already complete.');
    const lot = session.lots[session.cursor];
    if (!lot) throw new HttpError(409, 'No active auction lot.');
    const type = String(action?.type || '').toUpperCase();

    if (type === 'BUY_APPRAISAL' || type === 'BUY_DEMAND') {
      buyInformation(session, lot, type, this.config);
    } else if (type === 'BID' || type === 'PASS') {
      resolveLot(session, lot, type === 'PASS' ? 0 : Number(action.amount), this.config);
    } else {
      throw new HttpError(400, 'Action must be BUY_APPRAISAL, BUY_DEMAND, BID, or PASS.');
    }

    session.updatedAt = nowIso();
    await this.save();
    return publicSession(session);
  }

  informationValue(id, actor) {
    return analyzeInformationValue(this.findOwned(id, actor));
  }

  policyComparison(id, actor) {
    const session = this.findOwned(id, actor);
    if (session.status !== 'COMPLETED') {
      throw new HttpError(409, 'Auction play session must be completed before comparing policies.');
    }
    return compareHumanAndAiPolicies(session, this.config);
  }

  informationValueReport(id, actor, { priceExperiment = null } = {}) {
    const session = this.findOwned(id, actor);
    if (session.status !== 'COMPLETED') {
      throw new HttpError(409, 'Auction play session must be completed before reporting information value.');
    }
    return buildInformationValueReport(session, this.config, { priceExperiment });
  }

  findOwned(id, actor) {
    const session = this.sessions.find((item) => item.id === id);
    if (!session || (actor.role !== 'admin' && session.actorUserId !== actor.id)) {
      throw new HttpError(404, 'Auction play session not found.');
    }
    return session;
  }

  async save() {
    await writeFile(this.path, `${JSON.stringify({ schemaVersion: 1, sessions: this.sessions }, null, 2)}\n`);
  }
}

function createSession(config, actor, seed) {
  const random = createSeededRandom(seed);
  const lots = [];
  const days = integer(config.economy?.days, 12);
  const lotsPerDay = integer(config.auction?.lotsPerDay, 8);
  const botProfiles = createAuctionBotProfiles(config, random);
  for (let index = 0; index < days * lotsPerDay; index += 1) {
    const lot = createAuctionLot(config, random);
    const botBids = createAuctionBotBids(config, lot, number(config.economy?.startingAssets, 20_000), random, botProfiles);
    const highestBot = Math.max(0, ...botBids);
    const increment = Math.max(100, roundTo100(highestBot * number(config.auction?.minimumIncrementRate, 0.1)));
    lots.push({
      ...lot,
      botBids,
      clearingPrice: Math.max(lot.startBid, highestBot + increment),
      blindEstimate: lot.baseValue * (1 + symmetric(random, number(config.information?.blindValueErrorRate, 0.35))),
      appraisalEstimate: lot.baseValue * (1 + symmetric(random, number(config.information?.appraisalErrorRate, 0.2))),
      demandEstimate: lot.demandMultiplier * (1 + symmetric(random, number(config.information?.demandErrorRate, 0.15))),
      revealed: [],
    });
  }
  const at = nowIso();
  return {
    id: randomId('play'),
    actorUserId: actor.id,
    actorName: actor.name,
    seed,
    status: 'ACTIVE',
    createdAt: at,
    updatedAt: at,
    cursor: 0,
    cash: number(config.economy?.startingAssets, 20_000),
    startingAssets: number(config.economy?.startingAssets, 20_000),
    informationSpent: 0,
    wins: 0,
    realizedProfit: 0,
    lots,
    decisions: [],
    rules: {
      saleFeeRate: number(config.economy?.saleFeeRate, 0.05),
      appraisalPriceRate: number(config.information?.appraisalPriceRate, 0.05),
      demandPriceAssetRate: number(config.information?.demandPriceAssetRate, 0.01),
      lotsPerDay,
    },
  };
}

function buyInformation(session, lot, type, config) {
  const key = type === 'BUY_APPRAISAL' ? 'appraisal' : 'demand';
  if (lot.revealed.includes(key)) throw new HttpError(409, `${key} information was already purchased.`);
  const cost = key === 'appraisal'
    ? lot.baseValue * number(config.information?.appraisalPriceRate, 0.05)
    : session.cash * number(config.information?.demandPriceAssetRate, 0.01)
      / integer(config.auction?.lotsPerDay, 8);
  const roundedCost = informationCost(cost);
  if (session.cash < roundedCost) throw new HttpError(409, 'Not enough cash to buy information.');
  session.cash -= roundedCost;
  session.informationSpent += roundedCost;
  lot.revealed.push(key);
  session.decisions.push({ at: nowIso(), lot: session.cursor + 1, type, cost: roundedCost });
}

function resolveLot(session, lot, bid, config) {
  if (!Number.isFinite(bid) || bid < 0) throw new HttpError(400, 'Bid must be a non-negative number.');
  const submittedBid = roundTo100(bid);
  const won = submittedBid >= lot.clearingPrice && session.cash >= lot.clearingPrice;
  let price = 0;
  let netSale = 0;
  if (won) {
    price = lot.clearingPrice;
    netSale = lot.trueSalePrice * (1 - number(config.economy?.saleFeeRate, 0.05));
    session.cash += netSale - price;
    session.wins += 1;
    session.realizedProfit += netSale - price;
  }
  session.decisions.push({
    at: nowIso(),
    lot: session.cursor + 1,
    type: submittedBid > 0 ? 'BID' : 'PASS',
    bid: submittedBid,
    won,
    price,
    netSale,
    profit: won ? netSale - price : 0,
    revealed: [...lot.revealed],
    trueSalePrice: lot.trueSalePrice,
    clearingPrice: lot.clearingPrice,
  });
  session.cursor += 1;
  if (session.cursor >= session.lots.length
    || session.cash <= session.startingAssets * number(config.economy?.ruinThresholdRatio, 0.1)) {
    session.status = 'COMPLETED';
    session.completedAt = nowIso();
  }
}

function publicSession(session) {
  const lot = session.status === 'ACTIVE' ? session.lots[session.cursor] : null;
  const completedLots = session.decisions.filter((decision) => decision.type === 'BID' || decision.type === 'PASS').length;
  return {
    id: session.id,
    seed: session.seed,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    completedAt: session.completedAt || null,
    progress: {
      current: Math.min(session.cursor + 1, session.lots.length),
      completed: completedLots,
      total: session.lots.length,
    },
    economy: {
      cash: session.cash,
      startingAssets: session.startingAssets,
      roiPercent: (session.cash / session.startingAssets - 1) * 100,
      informationSpent: session.informationSpent,
      wins: session.wins,
      realizedProfit: session.realizedProfit,
    },
    currentLot: lot ? {
      index: session.cursor + 1,
      day: Math.floor(session.cursor / 8) + 1,
      slot: session.cursor % 8 + 1,
      gradeId: lot.gradeId,
      category: lot.category,
      startBid: lot.startBid,
      blindEstimate: lot.blindEstimate,
      appraisalEstimate: lot.revealed.includes('appraisal') ? lot.appraisalEstimate : null,
      demandEstimate: lot.revealed.includes('demand') ? lot.demandEstimate : null,
      revealed: [...lot.revealed],
      informationPrices: {
        appraisal: informationCost(lot.baseValue * number(session.rules?.appraisalPriceRate, 0.05)),
        demand: informationCost(session.cash * number(session.rules?.demandPriceAssetRate, 0.01) / integer(session.rules?.lotsPerDay, 8)),
      },
    } : null,
    rules: {
      saleFeeRate: number(session.rules?.saleFeeRate, 0.05),
      settlement: 'IMMEDIATE_RESALE',
      bidRule: 'Your bid is a maximum. When it beats the hidden competition line, you pay the competition line.',
    },
    recentDecisions: session.decisions.slice(-12).reverse(),
    result: session.status === 'COMPLETED' ? {
      roiPercent: (session.cash / session.startingAssets - 1) * 100,
      informationSpendRate: session.informationSpent / session.startingAssets * 100,
      lotWinRate: session.wins / Math.max(1, completedLots) * 100,
      decisions: completedLots,
    } : null,
  };
}

function summary(session) {
  const view = publicSession(session);
  return {
    id: view.id,
    seed: view.seed,
    status: view.status,
    updatedAt: view.updatedAt,
    progress: view.progress,
    economy: view.economy,
    result: view.result,
  };
}

function symmetric(random, radius) {
  return (random() * 2 - 1) * radius;
}

function roundTo100(value) {
  return Math.round(value / 100) * 100;
}

function informationCost(value) {
  return value > 0 ? Math.max(100, roundTo100(value)) : 0;
}

function integer(value, fallback) {
  const candidate = Number(value);
  return Number.isFinite(candidate) ? Math.round(candidate) : fallback;
}

function number(value, fallback) {
  const candidate = Number(value);
  return Number.isFinite(candidate) ? candidate : fallback;
}
