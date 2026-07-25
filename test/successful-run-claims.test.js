import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXECUTOR_REPORT_LIMIT,
  observationFromTask,
  retainExecutorReport,
} from '../src/turn-budget-observations.js';

// 실측: 코덱스가 이렇게 보고했고, 하네스를 다시 돌린 결과는 exit 1이었다.
// 실행자 자신은 끝까지 돌아 "성공"으로 끝냈으므로 executorFailure가 없다.
const CODEX_REPORT = [
  'Implemented only the requested criterion:',
  '- Added a candidate brainstorm fixture.',
  '- Confirmed overall harness simulation exits `0` with all 10 faults caught.',
].join('\n');

// 실행자는 정상 종료했고(체크에 executorFailure가 없다) 프로그램 판정은 실패다.
function finishedRunTask(reportText) {
  return {
    id: 'tsk_finished_ok',
    verificationProfile: 'node-project',
    allowedPaths: ['tools/verification/loop-scenarios.mjs'],
    acceptanceCriteria: ['the simulation catches all 10 faults'],
    executor: { tool: 'codex-exec' },
    executorReport: retainExecutorReport(reportText, '2026-07-26T00:00:00.000Z'),
    agentActivity: { preflight: { maxTurns: 40 } },
    verification: {
      passed: false,
      changedPaths: ['tools/verification/loop-scenarios.mjs'],
      checks: [{ file: 'node', actualExit: 1, passed: false }],
    },
  };
}

test('a run that finished and reported success is audited, not skipped for lack of a failure excerpt', () => {
  const task = finishedRunTask(CODEX_REPORT);
  assert.equal(
    task.verification.checks.some((check) => check.executorFailure),
    false,
    'this run carries no executorFailure — that is the whole point',
  );

  const { claimAudit } = observationFromTask(task);
  assert.ok(claimAudit.claims.includes('EXIT_CODE'), 'the exit 0 claim must be seen on a run that reported success');
  assert.ok(claimAudit.claims.includes('ALL_PASSED'));
  assert.equal(claimAudit.contradicted, true, 'the program judged this run failed, so the claim is contradicted');
  assert.equal(claimAudit.missingHarness, false, 'a harness did run and gave a verdict');
});

test('a run with no retained report claims nothing — the audit reports what was said, not what was assumed', () => {
  const task = finishedRunTask('');
  assert.equal(task.executorReport, null, 'empty output is not retained as an empty record');
  const { claimAudit } = observationFromTask(task);
  assert.deepEqual(claimAudit.claims, []);
  assert.equal(claimAudit.contradicted, false);
});

test('the retained report is bounded, and it keeps the tail where the final report is', () => {
  const padded = `${'x'.repeat(EXECUTOR_REPORT_LIMIT * 2)}\n${CODEX_REPORT}`;
  const retained = retainExecutorReport(padded);

  assert.equal(retained.outputExcerpt.length, EXECUTOR_REPORT_LIMIT, 'a run must not store an unbounded blob');
  assert.ok(retained.outputExcerpt.endsWith(CODEX_REPORT), 'the end of the output is the final report');
  assert.ok(retained.at, 'the retained report is timestamped');

  // 잘린 뒤에도 감사는 그 문면 위에서 돌아야 한다.
  const { claimAudit } = observationFromTask({ ...finishedRunTask(''), executorReport: retained });
  assert.ok(claimAudit.claims.includes('EXIT_CODE'));
  assert.equal(claimAudit.contradicted, true);
});

test('the failure excerpt keeps being the report for runs that died — the old path is untouched', () => {
  const task = {
    id: 'tsk_failed',
    verification: {
      passed: false,
      changedPaths: [],
      checks: [{
        file: 'agent-executor',
        executorFailure: { subtype: 'error_max_turns', outputExcerpt: 'all 10 faults caught, exit 0' },
      }],
    },
  };
  const { claimAudit } = observationFromTask(task);
  assert.ok(claimAudit.claims.includes('EXIT_CODE'));
  assert.ok(claimAudit.claims.includes('ALL_PASSED'));
});
