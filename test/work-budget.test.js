import test from 'node:test';
import assert from 'node:assert/strict';
import { TURN_CEILING, decideWorkBudget, readOnlySources } from '../src/work-budget.js';

const WRITE_SCOPE = ['test/loop-failure-evidence.test.js'];

// 실측: 관련도 검색이 주변 코드를 끌어오므로, 읽을 것이 없다고 쓴 작업도 소스를 여럿 받는다.
const RETRIEVED_PACK = {
  sources: {
    sourceCount: 3,
    estimatedTokens: 3000,
    sources: [
      { path: 'test/loop-failure-evidence.test.js', chunk: 0 },
      { path: 'src/entry-service.js', chunk: 0 },
      { path: 'src/store.js', chunk: 0 },
    ],
  },
};

test('a source the work may write is not counted as reading', () => {
  assert.deepEqual(
    readOnlySources(RETRIEVED_PACK, WRITE_SCOPE).sort(),
    ['src/entry-service.js', 'src/store.js'],
  );
});

test('a glob write scope covers what it matches', () => {
  const pack = { sources: { sources: [{ path: 'test/a.test.js' }, { path: 'src/store.js' }] } };
  assert.deepEqual(readOnlySources(pack, ['test/**']), ['src/store.js']);
});

test('the ceiling is the one the evidence supports, and says it is a ceiling not a spend', () => {
  assert.equal(TURN_CEILING.value, 40);
  assert.match(TURN_CEILING.evidence, /12 and again at 24/);
  assert.match(TURN_CEILING.evidence, /not spend/i);
});

test('pack facts are recorded even though they do not yet decide the ceiling', () => {
  const decided = decideWorkBudget({ pack: RETRIEVED_PACK, allowedPaths: WRITE_SCOPE });
  assert.equal(decided.readOnlySourceCount, 2);
  assert.equal(decided.packSourceCount, 3);
  assert.equal(decided.packEstimatedTokens, 3000);
  assert.equal(decided.maxTurns, 40);
});

test('the decision does not pretend to have a discriminator it has not validated', () => {
  const decided = decideWorkBudget({ pack: RETRIEVED_PACK, allowedPaths: WRITE_SCOPE });
  assert.equal(decided.discriminator, 'NONE_VALIDATED');
  assert.equal(decided.provisional, true);
});

test('retrieval noise cannot silently change the ceiling', () => {
  const noisy = decideWorkBudget({ pack: RETRIEVED_PACK, allowedPaths: WRITE_SCOPE });
  const bare = decideWorkBudget({ pack: { sources: { sources: [{ path: 'test/loop-failure-evidence.test.js' }] } }, allowedPaths: WRITE_SCOPE });
  assert.equal(noisy.maxTurns, bare.maxTurns,
    'until a discriminator is validated, a pack that merely retrieved more neighbours must not change the ceiling');
  assert.notEqual(noisy.readOnlySourceCount, bare.readOnlySourceCount, 'the difference is still recorded');
});

test('a missing pack still yields a usable ceiling and honest zeros', () => {
  const decided = decideWorkBudget({ pack: null, allowedPaths: WRITE_SCOPE });
  assert.equal(decided.maxTurns, 40);
  assert.equal(decided.readOnlySourceCount, 0);
  assert.equal(decided.packSourceCount, 0);
  assert.equal(decideWorkBudget({}).maxTurns, 40);
});
