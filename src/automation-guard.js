export function recordAutomationResult(previous = {}, {
  passed,
  failureSignature = '',
  at = new Date().toISOString(),
  usage = {},
  budget = {},
} = {}) {
  const signature = String(failureSignature || '').trim().slice(0, 500);
  const runTokens = nonNegative(usage.totalTokens);
  const runCostUsd = nonNegative(usage.costUsd);
  const cumulativeTokens = nonNegative(previous.cumulativeTokens) + runTokens;
  const cumulativeCostUsd = roundCurrency(nonNegative(previous.cumulativeCostUsd) + runCostUsd);
  const tokenBudget = positive(budget.tokenBudget);
  const costBudgetUsd = positive(budget.costBudgetUsd);
  const tokenBudgetExceeded = tokenBudget > 0 && cumulativeTokens >= tokenBudget;
  const costBudgetExceeded = costBudgetUsd > 0 && cumulativeCostUsd >= costBudgetUsd;
  const sameFailureCount = !passed && signature && signature === previous.lastFailureSignature
    ? Number(previous.sameFailureCount || 0) + 1
    : !passed ? 1 : 0;
  const failedRuns = passed ? 0 : Number(previous.failedRuns || 0) + 1;
  const circuitOpen = tokenBudgetExceeded || costBudgetExceeded || (!passed && (sameFailureCount >= 2 || failedRuns >= 3));
  const reason = !circuitOpen
    ? ''
    : tokenBudgetExceeded
      ? `Automatic execution paused for approval: task token budget ${tokenBudget} reached (${cumulativeTokens}).`
      : costBudgetExceeded
        ? `Automatic execution paused for approval: task cost budget $${costBudgetUsd} reached ($${cumulativeCostUsd}).`
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
      cumulativeTokens,
      cumulativeCostUsd,
      tokenBudget: tokenBudget || null,
      costBudgetUsd: costBudgetUsd || null,
      budgetExceeded: tokenBudgetExceeded || costBudgetExceeded,
    },
    reason,
  };
}

export function effectiveAutomationTokens(usage = {}) {
  const input = Math.max(0, Number(usage.inputTokens) || 0);
  const cached = Math.min(input, Math.max(0, Number(usage.inputCachedTokens) || 0));
  const output = Math.max(0, Number(usage.outputTokens) || 0);
  return Math.round((input - cached) + output + (cached * 0.1));
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function positive(value) {
  return nonNegative(value);
}

function roundCurrency(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
