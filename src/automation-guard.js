export function recordAutomationResult(previous = {}, { passed, failureSignature = '', at = new Date().toISOString() } = {}) {
  const signature = String(failureSignature || '').trim().slice(0, 500);
  const sameFailureCount = !passed && signature && signature === previous.lastFailureSignature
    ? Number(previous.sameFailureCount || 0) + 1
    : !passed ? 1 : 0;
  const failedRuns = passed ? 0 : Number(previous.failedRuns || 0) + 1;
  const circuitOpen = !passed && (sameFailureCount >= 2 || failedRuns >= 3);
  const reason = !circuitOpen
    ? ''
    : sameFailureCount >= 2
      ? `자동 실행 중단: 같은 실패가 ${sameFailureCount}회 반복되었습니다.`
      : `자동 실행 중단: 이 작업이 ${failedRuns}회 연속 실패했습니다.`;
  return {
    guard: {
      totalRuns: Number(previous.totalRuns || 0) + 1,
      failedRuns,
      sameFailureCount,
      lastFailureSignature: passed ? '' : signature,
      lastResultAt: at,
      circuitOpen,
    },
    reason,
  };
}
