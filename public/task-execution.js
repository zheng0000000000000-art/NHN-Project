export const EXECUTION_MODES = new Set(['HUMAN', 'AGENT']);
export const EXECUTION_STATES = new Set(['IDLE', 'QUEUED', 'RUNNING', 'RECOVERING']);

export function executionMode(value, fallback = 'HUMAN') {
  const normalized = String(value || fallback).toUpperCase();
  return EXECUTION_MODES.has(normalized) ? normalized : fallback;
}

export function executionState(value, fallback = 'IDLE') {
  const normalized = String(value || fallback).toUpperCase();
  return EXECUTION_STATES.has(normalized) ? normalized : fallback;
}

export function publicExecutionLabel(task) {
  if (task?.executionMode !== 'AGENT') return '';
  if (task.executionState === 'QUEUED') return '에이전트 대기';
  if (task.executionState === 'RUNNING') return '에이전트 실행 중';
  if (task.executionState === 'RECOVERING') return '자동 작업 복구 중';
  return '';
}

export function workflowPhase(task) {
  if (!task) return 'READY';
  if (task.status === 'DONE') return 'APPROVED';
  if (task.status === 'BLOCKED') return 'BLOCKED';
  if (task.status === 'REVIEW') return 'AWAITING_APPROVAL';
  if (task.executionState === 'RECOVERING') return 'RECOVERING';
  if (task.executionState === 'RUNNING') return 'RUNNING';
  if (task.executionState === 'QUEUED') return 'QUEUED';
  if (task.status === 'IN_PROGRESS' && task.verification?.passed) return 'READY_FOR_REVIEW';
  if (task.status === 'IN_PROGRESS') return 'WORKING';
  return 'READY';
}

export function publicWorkflowLabel(task) {
  return ({
    APPROVED: '승인 완료',
    BLOCKED: '차단됨',
    AWAITING_APPROVAL: '승인 대기',
    RECOVERING: '자동 작업 복구 중',
    RUNNING: '에이전트 실행 중',
    QUEUED: '에이전트 대기',
    READY_FOR_REVIEW: '리뷰 요청 필요',
    WORKING: '작업 진행 중',
    READY: '준비',
  })[workflowPhase(task)];
}
