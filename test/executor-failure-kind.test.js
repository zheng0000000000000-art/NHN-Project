import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAgentDeliveryGate, executorFailureKind } from '../src/delivery-gate.js';
import { SYNTHETIC_FAILURE_KINDS, injectionReadiness, isRerunnableFailure } from '../src/failure-evidence.js';

// 실측: 사람이 손으로 task verify를 돌리면 에이전트 실행 기록이 없어 게이트가 막는데,
// 그 판정에 EXECUTOR_FAILED가 붙었다. 실행자는 실패한 적이 없다 — 돌지를 않았다.
// 원인을 프록시로 단정하지 말라는 규칙을 게이트 자신이 어기고 있었다.
const AGENT_TASK = { executionMode: 'AGENT', allowNoChanges: true };

test('a missing run record is not called an executor failure', () => {
  assert.equal(executorFailureKind({}), 'EXECUTOR_RESULT_MISSING');
  assert.equal(executorFailureKind({ exitCode: null }), 'EXECUTOR_RESULT_MISSING');
  assert.equal(executorFailureKind({ exitCode: undefined }), 'EXECUTOR_RESULT_MISSING');
});

test('a timeout is named as a timeout, even though it also has no exit code', () => {
  assert.equal(executorFailureKind({ timedOut: true }), 'EXECUTOR_TIMED_OUT');
  assert.equal(executorFailureKind({ timedOut: true, exitCode: 1 }), 'EXECUTOR_TIMED_OUT',
    'the more specific cause wins');
});

test('an executor that really ran and failed keeps the original name', () => {
  assert.equal(executorFailureKind({ exitCode: 1 }), 'EXECUTOR_FAILED');
  assert.equal(executorFailureKind({ exitCode: 137 }), 'EXECUTOR_FAILED');
});

test('a clean exit produces no gate failure at all', () => {
  const result = applyAgentDeliveryGate({ checks: [], changedPaths: ['a.js'] }, AGENT_TASK, { exitCode: 0 });
  assert.ok(!result.deliveryGate);
});

test('the gate stamps the distinguishing name onto the check it emits', () => {
  const missing = applyAgentDeliveryGate({ checks: [], changedPaths: ['a.js'] }, AGENT_TASK, {});
  assert.equal(missing.checks.at(-1).failureKind, 'EXECUTOR_RESULT_MISSING');
  assert.equal(missing.checks.at(-1).title, 'Agent executor result is missing');

  const failed = applyAgentDeliveryGate({ checks: [], changedPaths: ['a.js'] }, AGENT_TASK, { exitCode: 2 });
  assert.equal(failed.checks.at(-1).failureKind, 'EXECUTOR_FAILED');

  const timedOut = applyAgentDeliveryGate({ checks: [], changedPaths: ['a.js'] }, AGENT_TASK, { timedOut: true });
  assert.equal(timedOut.checks.at(-1).failureKind, 'EXECUTOR_TIMED_OUT');
});

// 실패 코퍼스의 identity는 kind를 담는다. 이름이 갈리면 서로 다른 원인이 한 통에 섞이지 않는다.
test('the three causes no longer share one corpus bucket', () => {
  const kinds = [{}, { exitCode: 1 }, { timedOut: true }].map((run) =>
    applyAgentDeliveryGate({ checks: [], changedPaths: ['a.js'] }, AGENT_TASK, run).checks.at(-1).failureKind);
  assert.equal(new Set(kinds).size, 3, 'one bucket cannot hold three different causes');
});

// 이 라벨들은 실행 파일이 아니다. 하나라도 빠지면 승격 점수가 실행 가능한 근거로 세어 부푼다.
test('every gate label stays excluded from replayable evidence', () => {
  for (const kind of ['EXECUTOR_FAILED', 'EXECUTOR_TIMED_OUT', 'EXECUTOR_RESULT_MISSING', 'NO_DELIVERABLE']) {
    assert.ok(SYNTHETIC_FAILURE_KINDS.has(kind), `${kind} must be known to be a label`);
    const failure = { kind, lastEvidence: { file: 'agent-executor', args: [] } };
    assert.equal(isRerunnableFailure(failure), false, `${kind} is not a command that can be rerun`);
    assert.equal(injectionReadiness([failure]), 0, `${kind} carries neither a command nor a target`);
  }
});

// executionResult는 HTTP 본문에서 온다. JSON에 undefined가 없으므로 종료 코드가 없는 실행은
// null로 실려 오는데, Number(null)이 0이라 게이트가 정상 종료로 읽고 있었다.
test('a null exit code from the wire is an absence, not a success', () => {
  const result = applyAgentDeliveryGate({ checks: [], changedPaths: ['a.js'] }, AGENT_TASK, { exitCode: null });
  assert.equal(result.passed, false, 'a run with no reported code must not pass the gate');
  assert.equal(result.checks.at(-1).failureKind, 'EXECUTOR_RESULT_MISSING');
  assert.equal(result.checks.at(-1).actualExit, null);
  assert.equal(result.checks.at(-1).spawnError, true);
});

test('an explicit zero is still a success', () => {
  const result = applyAgentDeliveryGate({ checks: [], changedPaths: ['a.js'] }, AGENT_TASK, { exitCode: 0 });
  assert.ok(!result.deliveryGate, 'only a reported zero counts as a clean run');
  assert.equal(applyAgentDeliveryGate({ checks: [], changedPaths: ['a.js'] }, AGENT_TASK, { exitCode: '0' }).deliveryGate, undefined);
});
