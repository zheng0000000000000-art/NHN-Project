const TASK_FIELDS = [
  'title', 'description', 'priority', 'allowedPaths', 'acceptanceCriteria',
  'verificationProfile', 'schedule', 'skillIds',
  'supersedesTaskId',
];

function cleanId(value) {
  const id = String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '');
  if (!id) throw new TypeError('Project id is required.');
  return id;
}

function publicDefinition(item, fields) {
  return Object.fromEntries(fields.filter((field) => item?.[field] !== undefined).map((field) => [field, structuredClone(item[field])]));
}

export function createProjectPack({ project, tasks = [], users = [], harnesses = [], skills = [], exportedAt = new Date().toISOString(), includeArchived = false }) {
  const id = cleanId(project?.id);
  const names = new Map(users.map((user) => [user.id, user.name]));
  const selectedTasks = tasks.filter((task) => includeArchived || !task.archived);
  const profileIds = new Set(selectedTasks.map((task) => task.verificationProfile).filter(Boolean));
  const skillIds = new Set(selectedTasks.flatMap((task) => task.skillIds || []));

  return {
    schemaVersion: 1,
    project: {
      id,
      title: String(project.title || id),
      repository: String(project.repository || ''),
    },
    exportedAt: String(exportedAt),
    members: [...new Set(selectedTasks.flatMap((task) => [names.get(task.assigneeUserId), names.get(task.reviewerUserId)]).filter(Boolean))].sort(),
    tasks: selectedTasks.map((task) => ({
      key: String(task.id),
      ...Object.fromEntries(TASK_FIELDS.map((field) => [field, structuredClone(task[field])])),
      assignee: names.get(task.assigneeUserId) || null,
      reviewer: names.get(task.reviewerUserId) || null,
    })),
    harnesses: harnesses.filter((item) => profileIds.has(item.id)).map((item) => publicDefinition(item, ['id', 'label', 'description', 'commands', 'status', 'source', 'version'])),
    skills: skills.filter((item) => skillIds.has(item.id)).map((item) => publicDefinition(item, ['id', 'label', 'description', 'rules', 'status', 'source', 'version'])),
  };
}

export function materializeProjectPack(pack, users = [], { now = new Date().toISOString() } = {}) {
  if (pack?.schemaVersion !== 1 || !pack?.project?.id || !Array.isArray(pack.tasks)) throw new TypeError('Invalid project pack.');
  const userIds = new Map(users.map((user) => [String(user.name).toLowerCase(), user.id]));
  const admin = users.find((user) => user.role === 'admin') || users[0];

  return pack.tasks.map((source) => {
    const assigneeUserId = source.assignee ? userIds.get(String(source.assignee).toLowerCase()) : null;
    const reviewerUserId = source.reviewer ? userIds.get(String(source.reviewer).toLowerCase()) : null;
    if (source.assignee && !assigneeUserId) throw new TypeError(`Missing local user: ${source.assignee}`);
    if (source.reviewer && !reviewerUserId) throw new TypeError(`Missing local user: ${source.reviewer}`);
    return {
      id: String(source.key),
      title: String(source.title || ''),
      description: String(source.description || ''),
      status: 'READY',
      priority: Number(source.priority) || 100,
      creatorUserId: admin?.id || assigneeUserId || null,
      assigneeUserId,
      reviewerUserId,
      allowedPaths: structuredClone(source.allowedPaths || ['**']),
      acceptanceCriteria: structuredClone(source.acceptanceCriteria || []),
      verificationProfile: String(source.verificationProfile || 'repository-basic'),
      schedule: structuredClone(source.schedule || { plannedStart: '', plannedEnd: '', note: '' }),
      skillIds: structuredClone(source.skillIds || []),
      projectPackId: String(pack.project.id),
      learning: { applications: [] },
      verification: null,
      review: null,
      blocked: null,
      executor: null,
      executionMode: 'HUMAN',
      executionState: 'IDLE',
      supersedesTaskId: source.supersedesTaskId || null,
      supersededByTaskId: null,
      archived: false,
      archivedAt: null,
      archivedByUserId: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
  });
}

export function mergeProjectPackTasks(existingTasks, importedTasks, projectId) {
  const importedIds = new Set(importedTasks.map((task) => task.id));
  return [
    ...existingTasks.filter((task) => task.projectPackId !== projectId && !importedIds.has(task.id)),
    ...importedTasks,
  ];
}
