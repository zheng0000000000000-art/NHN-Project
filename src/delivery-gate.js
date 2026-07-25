export function applyAgentDeliveryGate(verification, task, executionResult = {}) {
  const result = structuredClone(verification);
  if (task?.executionMode !== 'AGENT') return result;
  const failures = [];
  const exitCode = Number(executionResult.exitCode);
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
      failureKind: 'EXECUTOR_FAILED',
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
