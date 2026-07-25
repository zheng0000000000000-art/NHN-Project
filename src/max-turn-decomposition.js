export function buildMaxTurnRecoveryPlan(task = {}) {
  const criteria = Array.isArray(task.acceptanceCriteria)
    ? task.acceptanceCriteria.map((item) => String(item).trim()).filter(Boolean)
    : [];
  if (!criteria.length) return null;
  const parentDepth = Math.max(0, Number(task.recovery?.depth) || Number(task.delegation?.depth) || 0);
  if (parentDepth >= 2) return null;
  const steps = criteria.map((criterion, index) => ({
    stepId: `recovery-${index + 1}`,
    title: `${String(task.title || 'Recovery').slice(0, 85)} · ${index + 1}/${criteria.length}`,
    // 부모 지시를 버리면 자식은 무엇을 읽어야 하는지 모른 채 탐색으로 턴을 태우고,
    // 읽기 부담이 문면에서 사라져 작은 일로 오분류된다. 범위는 좁히되 맥락은 넘긴다.
    description: [
      `Bounded recovery unit for ${task.id}. Implement only this criterion: ${criterion}`,
      ...(String(task.description || '').trim()
        ? ['', 'Context inherited from the parent task (scope is still only the criterion above):', String(task.description).trim()]
        : []),
    ].join('\n'),
    acceptanceCriteria: [criterion],
    allowedPaths: task.allowedPaths || ['**'],
    verificationProfile: task.verificationProfile,
    executorProfileId: task.executorProfileId,
    reviewerProfileId: task.reviewerProfileId,
    approvalPolicy: 'AUTO',
    dependsOn: index ? [`recovery-${index}`] : [],
    delegation: {
      parentTaskId: task.id,
      rootTaskId: task.recovery?.rootTaskId || task.id,
      depth: parentDepth + 1,
      role: 'EXECUTE',
      reason: 'MAX_TURNS_RECOVERY_EXHAUSTED',
      budget: {
        tokenBudget: Math.max(10_000, Math.floor((Number(task.automationGuard?.tokenBudget) || 500_000) / criteria.length)),
        costBudgetUsd: Math.max(0.25, (Number(task.automationGuard?.costBudgetUsd) || 10) / criteria.length),
        maxCalls: 2,
      },
    },
  }));
  return {
    title: `Recovery: ${String(task.title || task.id).slice(0, 90)}`,
    objective: `Automatically decompose ${task.id} after repeated maximum-turn failures.`,
    steps,
  };
}

export function isExhaustedMaxTurnFailure(task = {}) {
  const checks = Array.isArray(task.verification?.checks) ? task.verification.checks : [];
  const executor = [...checks].reverse().find((check) => check?.executorFailure)?.executorFailure;
  return executor?.subtype === 'error_max_turns'
    && (task.verification?.changedPaths || []).length === 0
    && task.verification?.passed === false;
}

export function isRecoverablePartialMaxTurnFailure(task = {}) {
  const checks = Array.isArray(task.verification?.checks) ? task.verification.checks : [];
  const executor = [...checks].reverse().find((check) => check?.executorFailure)?.executorFailure;
  return executor?.subtype === 'error_max_turns'
    && (task.verification?.changedPaths || []).length > 0
    && task.verification?.passed === false
    && task.automationGuard?.circuitOpen !== true
    && task.automationGuard?.budgetExceeded !== true;
}

export function terminalMaxTurnDecision(task = {}) {
  const depth = Math.max(0, Number(task.delegation?.depth) || Number(task.recovery?.depth) || 0);
  const totalRuns = Math.max(0, Number(task.automationGuard?.totalRuns) || 0);
  if (depth < 2) return { action: 'DECOMPOSE', maxTurns: 12 };
  if (task.automationGuard?.circuitOpen === true || task.automationGuard?.budgetExceeded === true || totalRuns >= 2) {
    return { action: 'BLOCK_CRITICAL', maxTurns: 0 };
  }
  return { action: 'ESCALATE_ONCE', maxTurns: 24 };
}
