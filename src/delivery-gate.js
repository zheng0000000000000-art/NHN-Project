// 보고된 종료 코드를 읽는다. executionResult는 HTTP 본문에서 오고 JSON에는 undefined가
// 없으므로, 종료 코드가 없는 실행은 null로 실려 온다. Number(null)은 0이라 그대로 쓰면
// "코드가 없다"가 "정상 종료했다"로 읽힌다. 부재는 값이 아니므로 NaN으로 돌린다.
function reportedExitCode(executionResult) {
  const raw = executionResult?.exitCode;
  if (raw === null || raw === undefined || raw === '') return NaN;
  return Number(raw);
}

// 실행자에게 무슨 일이 있었는지를 이름으로 구분한다. 시간 초과가 가장 구체적이고,
// 종료 코드가 아예 없으면 실패가 아니라 기록 부재다.
export function executorFailureKind(executionResult = {}) {
  if (executionResult.timedOut === true) return 'EXECUTOR_TIMED_OUT';
  if (!Number.isFinite(reportedExitCode(executionResult))) return 'EXECUTOR_RESULT_MISSING';
  return 'EXECUTOR_FAILED';
}

export function applyAgentDeliveryGate(verification, task, executionResult = {}) {
  const result = structuredClone(verification);
  if (task?.executionMode !== 'AGENT') return result;
  const failures = [];
  const exitCode = reportedExitCode(executionResult);
  if (!Number.isFinite(exitCode) || exitCode !== 0) {
    const failure = normalizeExecutorFailure(executionResult);
    failures.push({
      file: 'agent-executor',
      args: [],
      expectedExit: 0,
      actualExit: Number.isFinite(exitCode) ? exitCode : null,
      passed: false,
      timedOut: executionResult.timedOut === true,
      spawnError: !Number.isFinite(exitCode),
      // 세 상황을 한 이름으로 부르면 원인을 프록시로 단정하게 된다. 실행 기록이 없는 것은
      // 실행자가 실패한 것이 아니라 증거가 없는 것이다(사람이 손으로 검증하면 그렇게 된다).
      // 코퍼스 identity가 kind를 담으므로, 이름을 가르면 서로 다른 원인이 한 통에 섞이지도 않는다.
      failureKind: executorFailureKind(executionResult),
      title: failure.reason || (Number.isFinite(exitCode) ? `Agent executor exited with code ${exitCode}` : 'Agent executor result is missing'),
      stdoutTail: failure.outputExcerpt,
      executorFailure: failure,
    });
  }
  const changedPaths = Array.isArray(result.changedPaths) ? result.changedPaths : [];
  if (!task.allowNoChanges && changedPaths.length === 0) {
    failures.push({
      file: 'agent-delivery',
      args: [],
      expectedExit: 0,
      actualExit: 1,
      passed: false,
      timedOut: false,
      spawnError: false,
      failureKind: 'NO_DELIVERABLE',
      title: 'Agent completed without a changed deliverable',
    });
  }
  if (!failures.length) return result;
  result.checks = [...(result.checks || []), ...failures];
  result.status = 'FAILED';
  result.passed = false;
  result.deliveryGate = {
    passed: false,
    allowNoChanges: Boolean(task.allowNoChanges),
    executorExitCode: Number.isFinite(exitCode) ? exitCode : null,
    failureKinds: failures.map((item) => item.failureKind),
  };
  return result;
}

export function normalizeExecutorFailure(executionResult = {}) {
  const output = String(executionResult.outputExcerpt || executionResult.error || '').trim();
  let structured = null;
  try {
    structured = output ? JSON.parse(output) : null;
  } catch {
    structured = null;
  }
  const reason = String(
    executionResult.reason
    || structured?.error
    || structured?.result
    || (executionResult.timedOut ? 'Agent executor timed out' : ''),
  ).trim().slice(0, 500);
  return {
    reason: reason || null,
    timedOut: executionResult.timedOut === true,
    durationMs: Math.max(0, Number(executionResult.durationMs) || 0),
    subtype: String(structured?.subtype || '').trim().slice(0, 120) || null,
    isError: structured?.is_error === true || structured?.isError === true,
    outputExcerpt: output.slice(-4000),
  };
}
