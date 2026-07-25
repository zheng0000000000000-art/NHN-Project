import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describeReviewBlock, REVIEW_BLOCK_REASON } from '../src/review-block.js';
import { applyAgentDeliveryGate } from '../src/delivery-gate.js';

const SERVER = await readFile('server.js', 'utf8');

test('a rejection names the action it blocks and the reason it blocks it', () => {
  const block = describeReviewBlock({ executionMode: 'HUMAN' }, { at: '2026-07-26T00:00:00.000Z', byUserId: 'usr_1' });
  assert.equal(block.reason, REVIEW_BLOCK_REASON);
  assert.equal(block.blockedAction, 'request-review');
  assert.equal(block.byUserId, 'usr_1');
  assert.match(block.detail, /A passing verification is required/);
  assert.ok(block.clearedBy.length > 0, 'a dead end without an exit is still silence');
});

test('an AGENT task is told the hand-run verify it would try next also fails', () => {
  const block = describeReviewBlock({ executionMode: 'AGENT' }, { at: '2026-07-26T00:00:00.000Z' });
  assert.equal(block.deliveryGate.applies, true);
  // 게이트가 실제로 붙이는 이름과 같아야 한다. 다른 이름을 적어두면 안내가 오답이 된다.
  const gated = applyAgentDeliveryGate({ passed: true, checks: [], changedPaths: ['src/a.js'] }, { executionMode: 'AGENT' }, {});
  assert.equal(gated.deliveryGate.failureKinds[0], block.deliveryGate.failureKind);
  assert.equal(gated.passed, false);
});

test('a HUMAN task is not told about a gate that does not apply to it', () => {
  const block = describeReviewBlock({ executionMode: 'HUMAN' }, { at: '2026-07-26T00:00:00.000Z' });
  assert.equal(block.deliveryGate.applies, false);
  assert.equal(block.deliveryGate.failureKind, null);
  assert.equal(block.clearedBy.length, 1, 're-verifying by hand is the whole exit for a human runner');
  assert.match(block.clearedBy[0], /verification again/);
  const gated = applyAgentDeliveryGate({ passed: true, checks: [], changedPaths: [] }, { executionMode: 'HUMAN' }, {});
  assert.equal(gated.passed, true, 'the gate really does skip HUMAN runs');
});

test('the AGENT exit is a new executor run, not a repeat of the verify that just failed', () => {
  const block = describeReviewBlock({ executionMode: 'AGENT' }, { at: '2026-07-26T00:00:00.000Z' });
  assert.match(block.clearedBy.join('\n'), /executor exit code/);
});

test('the reject path records the block only when it invalidated a verification', () => {
  const from = SERVER.indexOf("decision === 'APPROVE' ? 'REVIEW_APPROVED' : 'REVIEW_REJECTED'");
  const branch = SERVER.slice(from, SERVER.indexOf("if (decision === 'APPROVE' && task.status === 'DONE')", from));
  assert.match(branch, /next\.reviewBlock = next\.verification\s*\?\s*describeReviewBlock\(next, \{ at: nowIso\(\), byUserId: actor\.id \}\)\s*:\s*null;/);
  assert.ok(
    branch.indexOf('next.reviewBlock =') < branch.indexOf("status: 'STALE'"),
    'the block must be described from the verification the reject is about to invalidate',
  );
});

test('a passing verification clears the block instead of leaving a stale dead end', () => {
  const from = SERVER.indexOf('async function saveVerificationResult(');
  const body = SERVER.slice(from, SERVER.indexOf('async function safeRecordUsage(', from));
  const clears = body.match(/if \(verification\.passed\) next\.reviewBlock = null;/g) || [];
  assert.equal(clears.length, 2, 'both the direct and the post-conflict record paths must clear it');
});
