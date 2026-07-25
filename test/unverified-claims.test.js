import test from 'node:test';
import assert from 'node:assert/strict';
import { claimsIn, programEvidence, unverifiedClaims } from '../src/unverified-claims.js';

// 실측: 코덱스가 이렇게 보고했고, 재실행 결과는 exit 1이었다.
const CODEX_REPORT = [
  'Implemented only the requested criterion:',
  '- Added a candidate brainstorm fixture.',
  '- Confirmed `[caught]`: injected exit `1`, restored exit `0`.',
  '- Confirmed overall harness simulation exits `0` with all 10 faults caught.',
].join('\n');

const PROSE_ONLY = 'I added a fixture describing the candidate role and explained the trap in a comment.';

test('a verdict claim in a model report is recognised, plain description is not', () => {
  const claimed = claimsIn(CODEX_REPORT).map((item) => item.id);
  assert.ok(claimed.includes('EXIT_CODE'), 'claiming exit 0 is a yes or no verdict');
  assert.ok(claimed.includes('ALL_PASSED'));
  assert.ok(claimed.includes('VERIFIED'));
  assert.deepEqual(claimsIn(PROSE_ONLY), [], 'describing what was written is not a verdict');
  assert.deepEqual(claimsIn(''), []);
});

test('a recognised claim carries the sentence it came from', () => {
  const [first] = claimsIn(CODEX_REPORT);
  assert.ok(first.excerpt.length > 0);
  assert.match(first.excerpt, /exit/i);
});

test('only a real spawned check counts as program evidence', () => {
  const spawnFailed = programEvidence({ passed: false, checks: [{ file: 'agent-executor', spawnError: true, actualExit: 2 }] });
  assert.equal(spawnFailed.checkCount, 0, 'a check that never ran proves nothing');

  const ran = programEvidence({ passed: true, checks: [{ file: 'node', actualExit: 0, passed: true }] });
  assert.equal(ran.checkCount, 1);
  assert.equal(ran.passedCount, 1);
  assert.equal(ran.verdict, 'PASSED');
});

test('a claim with no program verdict behind it is a missing harness', () => {
  const result = unverifiedClaims({ report: CODEX_REPORT, verification: null, source: 'codex-exec' });
  assert.equal(result.missingHarness, true);
  assert.equal(result.source, 'codex-exec');
  assert.ok(result.claims.length >= 2);
});

test('a claim the program contradicts is worse than an unverified one', () => {
  const result = unverifiedClaims({
    report: CODEX_REPORT,
    verification: { passed: false, checks: [{ file: 'node', actualExit: 1, passed: false }] },
  });
  assert.equal(result.contradicted, true, 'the model said it passed and the program says it did not');
  assert.equal(result.missingHarness, false, 'a harness did run here; it disagreed');
});

test('a claim a program actually backs is neither', () => {
  const result = unverifiedClaims({
    report: CODEX_REPORT,
    verification: { passed: true, checks: [{ file: 'node', actualExit: 0, passed: true }] },
  });
  assert.equal(result.missingHarness, false);
  assert.equal(result.contradicted, false);
});

test('a report that claims nothing is never flagged, even with no verification', () => {
  const result = unverifiedClaims({ report: PROSE_ONLY, verification: null });
  assert.equal(result.missingHarness, false, 'silence is not a false claim');
  assert.equal(result.contradicted, false);
});
