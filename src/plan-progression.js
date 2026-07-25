export function selectAutomaticNextPlanTask(tasks, completedTask) {
  if (!completedTask?.planId || completedTask.status !== 'DONE') {
    return { decision: 'NONE', reason: 'NOT_A_COMPLETED_PLAN_TASK', task: null, candidates: [] };
  }
  const byId = new Map((tasks || []).map((task) => [task.id, task]));
  const candidates = (tasks || []).filter((task) =>
    task.planId === completedTask.planId
    && task.status === 'READY'
    && !task.archived
    && !task.automationGuard?.circuitOpen
    && (task.dependsOnTaskIds || []).every((id) => byId.get(id)?.status === 'DONE'));
  if (candidates.length !== 1) {
    return {
      decision: candidates.length ? 'ASK' : 'NONE',
      reason: candidates.length ? 'MULTIPLE_READY_PLAN_TASKS' : 'NO_READY_PLAN_TASK',
      task: null,
      candidates: candidates.map((task) => task.id),
    };
  }
  return { decision: 'START', reason: 'SINGLE_READY_PLAN_TASK', task: candidates[0], candidates: [candidates[0].id] };
}
