export function printValue(value, { json = false } = {}) {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (typeof value === 'string') {
    process.stdout.write(`${value}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printTasks(tasks, users, { json = false } = {}) {
  if (json) return printValue({ tasks }, { json: true });
  if (tasks.length === 0) return printValue('No tasks.');
  const names = new Map(users.map((user) => [user.id, user.name]));
  const rows = tasks.map((task) => ({
    ID: task.id,
    STATUS: task.status,
    PRI: String(task.priority),
    ASSIGNEE: names.get(task.assigneeUserId) || '-',
    REVIEWER: names.get(task.reviewerUserId) || '-',
    V: String(task.version),
    TITLE: task.title,
  }));
  printTable(rows);
}

export function printUsers(users, { json = false } = {}) {
  if (json) return printValue({ users }, { json: true });
  if (users.length === 0) return printValue('No users.');
  printTable(users.map((user) => ({ ID: user.id, NAME: user.name, ROLE: user.role })));
}

export function printTask(task, users, { json = false } = {}) {
  if (json) return printValue({ task }, { json: true });
  const names = new Map(users.map((user) => [user.id, user.name]));
  const lines = [
    `${task.id}  ${task.status}  v${task.version}`,
    task.title,
    `Priority: ${task.priority}`,
    `Assignee: ${names.get(task.assigneeUserId) || '-'}`,
    `Reviewer: ${names.get(task.reviewerUserId) || '-'}`,
    `Profile: ${task.verificationProfile}`,
    `Allowed: ${task.allowedPaths.join(', ')}`,
  ];
  if (task.description) lines.push('', task.description);
  if (task.acceptanceCriteria?.length) lines.push('', 'Acceptance:', ...task.acceptanceCriteria.map((item) => `- ${item}`));
  if (task.verification) lines.push('', `Verification: ${task.verification.status} passed=${Boolean(task.verification.passed)}`);
  if (task.review) lines.push(`Review: ${task.review.status}`);
  if (task.blocked) lines.push(`Blocked: ${task.blocked.reason}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

function printTable(rows) {
  const columns = Object.keys(rows[0]);
  const widths = Object.fromEntries(columns.map((column) => [column, Math.max(column.length, ...rows.map((row) => String(row[column] ?? '').length))]));
  const render = (row) => columns.map((column) => String(row[column] ?? '').padEnd(widths[column])).join('  ').trimEnd();
  process.stdout.write(`${render(Object.fromEntries(columns.map((column) => [column, column])))}\n`);
  process.stdout.write(`${columns.map((column) => '-'.repeat(widths[column])).join('  ')}\n`);
  for (const row of rows) process.stdout.write(`${render(row)}\n`);
}

export function printHarnesses(harnesses, { json = false } = {}) {
  if (json) return printValue({ harnesses }, { json: true });
  if (!harnesses.length) return printValue('No harnesses.');
  printTable(harnesses.map((item) => ({
    ID: item.id,
    STATUS: item.status,
    SOURCE: item.source,
    V: String(item.version),
    COMMANDS: String(item.commands?.length ?? 0),
    TEST: item.lastTest ? (item.lastTest.passed ? 'PASS' : 'FAIL') : '-',
    LABEL: item.label,
  })));
}

export function printFailures(failures, { json = false } = {}) {
  if (json) return printValue({ failures }, { json: true });
  if (!failures.length) return printValue('No failure cases.');
  printTable(failures.map((item) => ({
    ID: item.id,
    STATUS: item.status,
    KIND: item.kind,
    HARNESS: item.harnessId,
    COUNT: String(item.occurrences),
    LAST: item.lastSeenAt,
    TITLE: item.title,
  })));
}
