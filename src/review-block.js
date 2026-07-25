// REJECT는 작업을 IN_PROGRESS로 되돌리면서 통과했던 검증을 무효로 만든다. 워크트리의 산출물은
// 그대로 남아 있는데, request-review는 "A passing verification is required."로 막고, 손으로 다시
// verify하면 AGENT 모드의 납품 게이트가 실행 기록 없음(EXECUTOR_RESULT_MISSING)으로 떨어뜨린다.
// 두 거절은 각각 옳지만 겹치면 막다른 길이고, 지금까지 그 막다름은 아무 데도 적히지 않았다.
// 무엇이 막았고 무엇이 풀어주는지를 작업에 적어 둔다. 적히지 않은 막다름은 새 에이전트 실행을
// 한 번 더 사는 것 말고는 빠져나갈 방법이 없다.

export const REVIEW_BLOCK_REASON = 'VERIFICATION_INVALIDATED_BY_REJECT';

// 손으로 돌린 verify에는 실행자 종료 코드가 없다. 납품 게이트는 AGENT 모드에서만 그것을 요구하므로,
// 무엇이 막힘을 풀어주는지도 실행 모드에 따라 다르다. 하나로 뭉뚱그리면 둘 중 하나는 거짓말이 된다.
export function describeReviewBlock(task, { at, byUserId = null } = {}) {
  const agentGated = task?.executionMode === 'AGENT';
  return {
    reason: REVIEW_BLOCK_REASON,
    blockedAction: 'request-review',
    at,
    byUserId,
    detail: 'The rejection invalidated the passing verification, so request-review refuses with "A passing verification is required." The worktree still holds the work.',
    // 납품 게이트가 사람 손 검증을 실행자 실패로 부르지 않게 이름을 갈라 둔 것과 같은 이유로,
    // 여기서도 "게이트가 적용된다"는 사실과 그때 나오는 실패 이름을 함께 남긴다.
    deliveryGate: agentGated
      ? { applies: true, failureKind: 'EXECUTOR_RESULT_MISSING', detail: 'This task runs in AGENT mode, so a hand-run verify fails the delivery gate: it reports no executor exit code.' }
      : { applies: false, failureKind: null, detail: 'This task runs in HUMAN mode, so the agent delivery gate does not apply to a hand-run verify.' },
    clearedBy: agentGated
      ? [
        'Re-run the task through the agent executor so the run reports an executor exit code; a passing verification from that run restores request-review.',
        'Or move the task off AGENT execution before verifying by hand — the delivery gate only inspects AGENT runs.',
      ]
      : ['Run verification again on this worktree; a passing run restores request-review.'],
  };
}
