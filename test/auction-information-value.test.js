import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeInformationValue } from '../src/auction-information-value.js';

function fakeSession({ rules = { saleFeeRate: 0.05 } } = {}) {
  return {
    rules,
    lots: [
      { blindEstimate: 1000, appraisalEstimate: 800, demandEstimate: 1.0 },
      { blindEstimate: 1000, appraisalEstimate: 1200, demandEstimate: 1.0 },
      { blindEstimate: 1000, appraisalEstimate: 1000, demandEstimate: 1.0 },
    ],
    decisions: [
      { lot: 1, type: 'BUY_APPRAISAL', cost: 50 },
      {
        lot: 1, type: 'PASS', bid: 0, won: false, profit: 0,
        revealed: ['appraisal'], trueSalePrice: 800, clearingPrice: 900,
      },
      { lot: 2, type: 'BUY_APPRAISAL', cost: 60 },
      {
        lot: 2, type: 'PASS', bid: 0, won: false, profit: 0,
        revealed: ['appraisal'], trueSalePrice: 1300, clearingPrice: 1100,
      },
      {
        lot: 3, type: 'BID', bid: 1000, won: true, price: 1000, netSale: 1140, profit: 140,
        trueSalePrice: 1200, clearingPrice: 1000,
      },
    ],
  };
}

test('measures bid changes caused by each information purchase', () => {
  const result = analyzeInformationValue(fakeSession());
  assert.equal(result.bidChanges.length, 2);
  assert.deepEqual(result.bidChanges[0], {
    lot: 1, type: 'BUY_APPRAISAL', cost: 50,
    beforeModeledBid: 900, afterModeledBid: 700, bidShift: -200,
  });
  assert.deepEqual(result.bidChanges[1], {
    lot: 2, type: 'BUY_APPRAISAL', cost: 60,
    beforeModeledBid: 900, afterModeledBid: 1100, bidShift: 200,
  });
});

test('aggregates avoided losses, missed opportunities, net information value, and regret', () => {
  const result = analyzeInformationValue(fakeSession());
  assert.equal(result.informedLotCount, 2);
  assert.equal(result.informationSpent, 110);
  assert.equal(result.avoidedLosses, 140);
  assert.equal(result.missedOpportunities, 135);
  assert.equal(result.netInformationValue, -105);
  assert.equal(result.regret, 135);
});

test('reads sessions saved before the rules field existed, without migration', () => {
  const session = fakeSession({ rules: undefined });
  delete session.rules;
  const result = analyzeInformationValue(session);
  assert.equal(result.avoidedLosses, 140);
  assert.equal(result.missedOpportunities, 135);
  assert.equal(result.regret, 135);
});

test('handles sessions with no information purchases and no decisions gracefully', () => {
  assert.deepEqual(analyzeInformationValue(null), {
    informedLotCount: 0,
    informationSpent: 0,
    bidChanges: [],
    avoidedLosses: 0,
    missedOpportunities: 0,
    netInformationValue: 0,
    regret: 0,
  });

  const blindOnly = analyzeInformationValue({
    rules: { saleFeeRate: 0.05 },
    lots: [{ blindEstimate: 1000 }],
    decisions: [
      { lot: 1, type: 'BID', bid: 1000, won: true, profit: 140, trueSalePrice: 1200, clearingPrice: 1000 },
    ],
  });
  assert.equal(blindOnly.informedLotCount, 0);
  assert.equal(blindOnly.bidChanges.length, 0);
  assert.equal(blindOnly.avoidedLosses, 0);
  assert.equal(blindOnly.missedOpportunities, 0);
  assert.equal(blindOnly.netInformationValue, 0);
  assert.equal(blindOnly.regret, 0);
});
