export const EXECUTION_MODES = new Set(['HUMAN', 'AGENT']);
export const EXECUTION_STATES = new Set(['IDLE', 'QUEUED', 'RUNNING']);

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
  return '';
}
