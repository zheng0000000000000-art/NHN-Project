import test from 'node:test';
import assert from 'node:assert/strict';
import { compareHumanAndAiPolicies } from '../src/auction-policy-comparison.js';

function fakeSession(overrides = {}) {
  return {
    seed: 42,
    startingAssets: 20_000,
    cash: 20_500,
    informationSpent: 50,
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
      { lot: 1, type: 'BID', bid: 3300, won: true, profit: 500 },
      { lot: 2, type: 'PASS', bid: 0, won: false, profit: 0 },
    ],
    ...overrides,
  };
}

test('compares conservative, value, and speculative policies against the human result on the shared seed', () => {
  const result = compareHumanAndAiPolicies(fakeSession(), {});
  assert.equal(result.seed, 42);
  assert.equal(result.comparison.commonWorldSeed, 42);
  assert.equal(result.comparison.sharedLotCount, 2);

  const policyIds = result.policies.map((policy) => policy.id).sort();
  assert.deepEqual(policyIds, ['conservative', 'speculative', 'value']);

  for (const policy of result.policies) {
    assert.equal(typeof policy.roiPercent, 'number');
    assert.equal(typeof policy.vsHuman.roiPercentDelta, 'number');
    assert.ok(policy.lotsSeen <= 2);
    assert.equal(typeof policy.regret, 'number');
    assert.ok(policy.regret >= 0);
    assert.ok(policy.paybackLotIndex === null || (Number.isInteger(policy.paybackLotIndex) && policy.paybackLotIndex >= 1));
  }
});

test('a policy that never spends on information has no payback lot, since there is nothing to recoup', () => {
  const result = compareHumanAndAiPolicies(fakeSession(), {});
  const speculative = result.policies.find((policy) => policy.id === 'speculative');
  assert.equal(speculative.informationSpent, 0);
  assert.equal(speculative.paybackLotIndex, null);
});

test('every policy replays the exact same lots the human session generated from its seed', () => {
  const session = fakeSession();
  const result = compareHumanAndAiPolicies(session, {});
  for (const policy of result.policies) {
    assert.equal(policy.lotsSeen, session.lots.length);
  }
});

test('conservative buys full information every lot while speculative buys none', () => {
  const result = compareHumanAndAiPolicies(fakeSession(), {});
  const conservative = result.policies.find((policy) => policy.id === 'conservative');
  const speculative = result.policies.find((policy) => policy.id === 'speculative');
  assert.ok(conservative.informationSpent > 0);
  assert.equal(speculative.informationSpent, 0);
});

test('throws when the session has no generated lots', () => {
  assert.throws(() => compareHumanAndAiPolicies(fakeSession({ lots: [] }), {}));
  assert.throws(() => compareHumanAndAiPolicies(null, {}));
});
