export function applyAgentDeliveryGate(verification, task, executionResult = {}) {
  const result = structuredClone(verification);
  if (task?.executionMode !== 'AGENT') return result;
  const failures = [];
  const exitCode = Number(executionResult.exitCode);
  if (!Number.isFinite(exitCode) || exitCode !== 0) {
    failures.push({
      file: 'agent-executor',
      args: [],
      expectedExit: 0,
      actualExit: Number.isFinite(exitCode) ? exitCode : null,
      passed: false,
      timedOut: executionResult.timedOut === true,
      spawnError: !Number.isFinite(exitCode),
      failureKind: 'EXECUTOR_FAILED',
      title: Number.isFinite(exitCode) ? `Agent executor exited with code ${exitCode}` : 'Agent executor result is missing',
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
