export function filterTasksByPeople(tasks, { assigneeUserId = '', reviewerUserId = '' } = {}) {
  return tasks.filter((task) => {
    if (assigneeUserId && task.assigneeUserId !== assigneeUserId) return false;
    if (reviewerUserId && task.reviewerUserId !== reviewerUserId) return false;
    return true;
  });
}
