export function taskListView(task, detail = 'brief') {
  const brief = {
    id: task.id,
    title: task.title,
    status: task.status,
  };
  if (detail !== 'work') return brief;
  return {
    ...brief,
    allowedPaths: task.allowedPaths ?? [],
    assigneeUserId: task.assigneeUserId ?? null,
    executionState: task.executionState || 'IDLE',
    version: task.version,
  };
}
