export function canReviewTask(task, actor, { soloMode = false } = {}) {
  if (!task || !actor || task.status !== 'REVIEW') return false;
  if (actor.role === 'admin') return true;
  if (task.assigneeUserId === actor.id && !soloMode) return false;
  return !task.reviewerUserId || task.reviewerUserId === actor.id;
}
