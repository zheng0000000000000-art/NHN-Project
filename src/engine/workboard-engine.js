const BOARD_STATUSES = ['READY', 'IN_PROGRESS', 'BLOCKED', 'REVIEW', 'DONE'];

/**
 * Pure projection from private task state to the public workboard contract.
 * This module intentionally has no HTTP, authentication, storage or UI imports.
 */
export class WorkboardEngine {
  createSnapshot({ tasks = [], users = [], title = 'Team Loop Workboard', generatedAt = new Date().toISOString(), includeArchived = false } = {}) {
    const userNames = new Map(users.map((user) => [user.id, String(user.name || '')]));
    const taskStatuses = new Map(tasks.map((task) => [task.id, task.status]));
    const visibleTasks = tasks
      .filter((task) => includeArchived || !task.archived)
      .map((task) => projectTask(task, userNames, taskStatuses))
      .sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title));

    return {
      schemaVersion: 1,
      kind: 'team-loop-workboard',
      title: cleanText(title, 120) || 'Team Loop Workboard',
      generatedAt: String(generatedAt),
      summary: Object.fromEntries(BOARD_STATUSES.map((status) => [
        status,
        visibleTasks.filter((task) => task.status === status).length,
      ])),
      tasks: visibleTasks,
    };
  }
}

export function projectTask(task, userNames = new Map(), taskStatuses = new Map()) {
  const status = BOARD_STATUSES.includes(task.status) ? task.status : 'READY';
  const dependsOnTaskIds = (Array.isArray(task.dependsOnTaskIds) ? task.dependsOnTaskIds : []).map(String).slice(0, 30);
  return {
    id: String(task.id || ''),
    title: cleanText(task.title, 120) || 'Untitled task',
    status,
    priority: finiteNumber(task.priority, 100),
    plan: task.planId ? {
      id: String(task.planId),
      title: cleanText(task.planTitle, 120),
      stepId: cleanText(task.planStepId, 80),
    } : null,
    dependencies: {
      taskIds: dependsOnTaskIds,
      pendingTaskIds: dependsOnTaskIds.filter((taskId) => taskStatuses.get(taskId) !== 'DONE'),
    },
    assignee: userNames.get(task.assigneeUserId) || '',
    schedule: {
      plannedStart: dateOnly(task.schedule?.plannedStart),
      plannedEnd: dateOnly(task.schedule?.plannedEnd),
    },
    updatedAt: String(task.updatedAt || task.createdAt || ''),
    completedAt: status === 'DONE' ? String(task.completedAt || '') : '',
    artifacts: (Array.isArray(task.artifacts) ? task.artifacts : []).slice(0, 20).map((artifact) => ({
      name: cleanText(artifact.name, 180),
      contentType: cleanText(artifact.contentType, 120),
      size: finiteNumber(artifact.size, 0),
    })),
  };
}

function cleanText(value, maxLength) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function dateOnly(value) {
  const text = String(value || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}
