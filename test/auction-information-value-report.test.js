import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInformationValueReport } from '../src/auction-information-value-report.js';

function fakeSession(overrides = {}) {
  return {
    seed: 42,
    startingAssets: 20_000,
    cash: 20_500,
    informationSpent: 200,
    wins: 1,
    realizedProfit: 500,
    rules: {
      saleFeeRate: 0.05,
      appraisalPriceRate: 0.05,
      demandPriceAssetRate: 0.01,
      lotsPerDay: 8,
    },
    lots: [
      {
        baseValue: 4000,
        informationPriority: 1,
        blindEstimate: 3800,
        appraisalEstimate: 4100,
        demandEstimate: 1.1,
        botBids: [3000],
        clearingPrice: 3300,
        trueSalePrice: 4400,
      },
      {
        baseValue: 1500,
        informationPriority: 0,
        blindEstimate: 1450,
        appraisalEstimate: 1550,
        demandEstimate: 0.95,
        botBids: [1000],
        clearingPrice: 1100,
        trueSalePrice: 1300,
      },
    ],
    decisions: [
      { lot: 1, type: 'BUY_APPRAISAL', cost: 200 },
      { lot: 1, type: 'BID', bid: 3300, won: true, profit: 500 },
      { lot: 2, type: 'PASS', bid: 0, won: false, profit: 0 },
    ],
    ...overrides,
  };
}

function fakeTuneExperimentResult(overrides = {}) {
  return {
    spec: {
      parameters: { appraisalPriceRate: 0.05, demandPriceAssetRate: 0.01 },
      parameterSpace: [
        { parameterId: 'appraisalPriceRate', path: 'information/appraisalPriceRate', minimum: 0.01, maximum: 0.12 },
        { parameterId: 'demandPriceAssetRate', path: 'information/demandPriceAssetRate', minimum: 0.002, maximum: 0.024 },
      ],
    },
    candidate: {
      parameters: { appraisalPriceRate: 0.07, demandPriceAssetRate: 0.01 },
    },
    ...overrides,
  };
}

test('reports return, regret, and payback for the human and every AI policy', () => {
  const report = buildInformationValueReport(fakeSession(), {});
  const ids = report.returns.map((entry) => entry.id).sort();
  assert.deepEqual(ids, ['conservative', 'human', 'speculative', 'value']);
  assert.deepEqual(report.regret.map((entry) => entry.id).sort(), ids);
  assert.deepEqual(report.payback.map((entry) => entry.id).sort(), ids);

  const human = report.returns.find((entry) => entry.id === 'human');
  assert.equal(typeof human.roiPercent, 'number');
  assert.equal(typeof human.realizedProfit, 'number');

  for (const entry of report.regret) assert.ok(entry.regret >= 0);
  for (const entry of report.payback) {
    assert.ok(entry.paybackLotIndex === null || entry.paybackLotIndex >= 1);
    if (entry.informationSpent === 0) assert.equal(entry.paidBack, null);
  }
});

test('human payback lot is the first lot where cumulative profit covers cumulative information spend', () => {
  const report = buildInformationValueReport(fakeSession(), {});
  const human = report.payback.find((entry) => entry.id === 'human');
  assert.equal(human.informationSpent, 200);
  assert.equal(human.paybackLotIndex, 1);
  assert.equal(human.paidBack, true);
});

test('human payback stays null when information spend never gets recouped', () => {
  const session = fakeSession({
    decisions: [
      { lot: 1, type: 'BUY_APPRAISAL', cost: 200 },
      { lot: 1, type: 'PASS', bid: 0, won: false, profit: 0 },
      { lot: 2, type: 'PASS', bid: 0, won: false, profit: 0 },
    ],
  });
  const report = buildInformationValueReport(session, {});
  const human = report.payback.find((entry) => entry.id === 'human');
  assert.equal(human.paybackLotIndex, null);
  assert.equal(human.paidBack, false);
});

test('compares baseline and candidate prices when a tuning experiment result is supplied', () => {
  const report = buildInformationValueReport(fakeSession(), {}, { priceExperiment: fakeTuneExperimentResult() });
  assert.ok(Array.isArray(report.prices));
  const appraisal = report.prices.find((entry) => entry.parameterId === 'appraisalPriceRate');
  assert.equal(appraisal.baseline, 0.05);
  assert.equal(appraisal.candidate, 0.07);
  assert.equal(appraisal.delta, 0.02);
  assert.equal(Math.round(appraisal.percentChange), 40);
});

test('prices are null without a tuning experiment result', () => {
  const report = buildInformationValueReport(fakeSession(), {});
  assert.equal(report.prices, null);
});

test('exposes exactly one recommended next experiment, referencing the price comparison when it is present', () => {
  const withoutPrices = buildInformationValueReport(fakeSession(), {});
  assert.equal(typeof withoutPrices.recommendedNextExperiment.title, 'string');
  assert.ok(withoutPrices.recommendedNextExperiment.title.length > 0);
  assert.equal(typeof withoutPrices.recommendedNextExperiment.rationale, 'string');

  const withPrices = buildInformationValueReport(fakeSession(), {}, { priceExperiment: fakeTuneExperimentResult() });
  assert.equal(typeof withPrices.recommendedNextExperiment.title, 'string');
  assert.ok(withPrices.recommendedNextExperiment.rationale.includes('appraisalPriceRate') || withPrices.recommendedNextExperiment.title.length > 0);
});

test('throws when the session has no generated lots, same as the underlying policy comparison', () => {
  assert.throws(() => buildInformationValueReport(fakeSession({ lots: [] }), {}));
});
