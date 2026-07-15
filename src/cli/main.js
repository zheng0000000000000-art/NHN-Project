import { parseCliArgs, option, requireOption, listOption, repeatedOption } from './args.js';
import { CliClient } from './client.js';
import { clearSession, loadSession, normalizeServer, saveSession } from './session.js';
import { printFailures, printHarnesses, printTask, printTasks, printUsers, printValue } from './format.js';
import { readFile } from 'node:fs/promises';
import { readPassword } from './password.js';
import { captureClaudeStatusline, collectUsageSnapshots, commitUsageCursor } from './usage-collector.js';
import { startOtelReceiver } from './otel-receiver.js';

export async function runCli(argv) {
  const { positionals, options } = parseCliArgs(argv);
  const command = positionals[0] || 'help';
  const json = Boolean(options.json);

  if (options.version || command === 'version') {
    printValue('team-loop-lite-ai 0.7.0');
    return 0;
  }
  if (options.help || command === 'help') {
    printHelp();
    return 0;
  }
  if (command === 'serve') return serve(options);

  const saved = await loadSession();
  const server = normalizeServer(option(options, 'server', process.env.TEAM_LOOP_URL || saved?.server));
  const environmentCookie = process.env.TEAM_LOOP_SESSION_COOKIE || '';
  const cookie = environmentCookie || (saved?.server === server ? saved?.cookie || '' : '');
  const client = new CliClient({ server, cookie });

  if (command === 'health') {
    const result = await client.request('/api/health', { authenticated: false });
    printValue({ server, ...result }, { json });
    return 0;
  }

  if (command === 'dashboard') {
    printValue({ dashboard: `${server}/`, note: 'Open this URL in a browser and log in.' }, { json });
    return 0;
  }

  if (command === 'register' || command === 'login') {
    const name = requireOption(options, 'name');
    const password = await passwordFrom(options);
    const endpoint = command === 'register' ? '/api/auth/register' : '/api/auth/login';
    const body = { name, password };
    if (command === 'register' && option(options, 'signup-code') !== undefined) body.signupCode = String(option(options, 'signup-code'));
    const result = await client.request(endpoint, { method: 'POST', body, authenticated: false });
    if (!options['no-save']) await saveSession({ server, cookie: client.cookie, user: result.user });
    printValue({ server, user: result.user, sessionSaved: !options['no-save'] }, { json });
    return 0;
  }

  if (command === 'logout') {
    await client.request('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    await clearSession();
    printValue('Logged out.');
    return 0;
  }

  if (command === 'whoami') {
    const bootstrap = await client.request('/api/bootstrap');
    printValue({ server, user: bootstrap.user, ai: bootstrap.ai, workspace: bootstrap.workspace }, { json });
    return 0;
  }

  if (command === 'users') {
    const result = await client.request('/api/users');
    printUsers(result.users, { json });
    return 0;
  }

  if (command === 'tasks') {
    const bootstrap = await client.request('/api/bootstrap');
    let tasks = bootstrap.tasks;
    const status = option(options, 'status');
    if (status && status !== true) tasks = tasks.filter((task) => task.status === String(status).toUpperCase());
    if (options.mine) tasks = tasks.filter((task) => [task.creatorUserId, task.assigneeUserId, task.reviewerUserId].includes(bootstrap.user.id));
    printTasks(tasks, bootstrap.users, { json });
    return 0;
  }

  if (command === 'task') return runTask(client, positionals.slice(1), options, json);
  if (command === 'ai') return runAi(client, positionals.slice(1), options, json);
  if (command === 'harness') return runHarness(client, positionals.slice(1), options, json);
  if (command === 'skill') return runSkill(client, positionals.slice(1), options, json);
  if (command === 'learning') return runLearning(client, positionals.slice(1), options, json);
  if (command === 'failures') return listFailures(client, options, json);
  if (command === 'failure') return runFailure(client, positionals.slice(1), options, json);
  if (command === 'usage') return runUsage(client, positionals.slice(1), options, json);

  throw new Error(`Unknown command: ${command}. Run "team-loop help".`);
}

async function runUsage(client, positionals, options, json) {
  const action = positionals[0] || 'status';
  if (action === 'status') {
    const days = numberOption(options, 'days', 30);
    const result = await client.request(`/api/usage?days=${encodeURIComponent(days)}`);
    printValue(result.usage.external, { json: true });
    return 0;
  }
  if (action === 'capture-claude-statusline') {
    const input = await readStdin();
    const result = await captureClaudeStatusline(input);
    if (!options.quiet) printValue(result, { json: true });
    return 0;
  }
  if (action === 'receiver') {
    const receiver = await startOtelReceiver({
      host: stringOption(options, 'host', '127.0.0.1'),
      port: numberOption(options, 'port', 4318),
    });
    printValue({ listening: `http://${receiver.host}:${receiver.port}`, spool: receiver.spool }, { json: true });
    await new Promise((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
    await new Promise((resolve) => receiver.server.close(resolve));
    return 0;
  }
  if (action === 'push') {
    const execute = async () => {
      const collected = await collectUsageSnapshots({ includeInitialBackfill: Boolean(options['include-initial-backfill']) });
      const results = [];
      const collectorClient = new CliClient({ server: client.server, cookie: client.cookie, clientType: 'collector' });
      for (const snapshot of collected.snapshots) {
        results.push(await collectorClient.request('/api/usage/external', { method: 'POST', body: snapshot }));
      }
      await commitUsageCursor(collected.cursorPath, collected.nextCursor);
      printValue({ collectedAt: collected.nextCursor.lastPushAt, snapshots: collected.snapshots, results, diagnostics: collected.diagnostics }, { json: true });
    };
    if (!options.daemon) {
      await execute();
      return 0;
    }
    const intervalSeconds = Math.max(60, numberOption(options, 'interval', 300));
    await execute();
    await new Promise((resolve) => {
      const timer = setInterval(() => execute().catch((error) => console.error(`Usage push failed: ${error.message}`)), intervalSeconds * 1000);
      const stop = () => { clearInterval(timer); resolve(); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    return 0;
  }
  throw new Error('Usage action must be status, push, receiver, or capture-claude-statusline.');
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function runTask(client, positionals, options, json) {
  const action = positionals[0];
  if (!action) throw new Error('Task action is required.');

  if (action === 'show') {
    const taskId = requirePositional(positionals, 1, 'Task ID is required.');
    const bootstrap = await client.request('/api/bootstrap');
    const task = findTask(bootstrap.tasks, taskId);
    printTask(task, bootstrap.users, { json });
    return 0;
  }

  if (action === 'create') {
    const bootstrap = await client.request('/api/bootstrap');
    const allowedPaths = listOption(options, 'allowed-path');
    const body = {
      title: requireOption(options, 'title'),
      description: stringOption(options, 'description', ''),
      priority: numberOption(options, 'priority', 100),
      allowedPaths: allowedPaths.length ? allowedPaths : ['**'],
      acceptanceCriteria: listOption(options, 'criterion'),
      verificationProfile: stringOption(options, 'profile', 'repository-basic'),
      assigneeUserId: resolveUserId(bootstrap.users, option(options, 'assignee')),
      reviewerUserId: resolveUserId(bootstrap.users, option(options, 'reviewer')),
    };
    const result = await client.request('/api/tasks', { method: 'POST', body });
    printTask(result.task, bootstrap.users, { json });
    return 0;
  }

  const taskId = requirePositional(positionals, 1, 'Task ID is required.');
  const { task, users } = await currentTask(client, taskId);
  let endpoint = action;
  let body = { expectedVersion: task.version };

  if (action === 'approve' || action === 'reject') {
    endpoint = 'review';
    body.decision = action.toUpperCase();
    body.comment = stringOption(options, 'comment', '');
  } else if (action === 'block') {
    body.reason = requireOption(options, 'reason');
  } else if (!['claim', 'verify', 'request-review', 'unblock'].includes(action)) {
    throw new Error(`Unknown task action: ${action}.`);
  }

  const result = await client.request(`/api/tasks/${encodeURIComponent(task.id)}/${endpoint}`, { method: 'POST', body });
  printTask(result.task, users, { json });
  return result.task.verification && endpoint === 'verify' && !result.task.verification.passed ? 2 : 0;
}

async function runHarness(client, positionals, options, json) {
  const action = positionals[0] || 'list';
  if (action === 'list') {
    const result = await client.request('/api/harnesses');
    printHarnesses(result.harnesses, { json });
    return 0;
  }
  if (action === 'show') {
    const id = requirePositional(positionals, 1, 'Harness ID is required.');
    const result = await client.request(`/api/harnesses/${encodeURIComponent(id)}`);
    printValue(result.harness, { json: true });
    return 0;
  }
  if (action === 'create') {
    const definitionPath = option(options, 'definition');
    let body;
    if (definitionPath && definitionPath !== true) {
      body = JSON.parse(await readFile(String(definitionPath), 'utf8'));
    } else {
      body = {
        id: requireOption(options, 'id'),
        label: stringOption(options, 'label', requireOption(options, 'id')),
        description: stringOption(options, 'description', ''),
        commands: [{
          file: requireOption(options, 'file'),
          args: repeatedOption(options, 'arg'),
          cwd: stringOption(options, 'cwd', '.'),
          expectedExit: numberOption(options, 'expected-exit', 0),
          timeoutMs: numberOption(options, 'timeout-ms', 120000),
        }],
      };
    }
    const result = await client.request('/api/harnesses', { method: 'POST', body });
    printValue(result.harness, { json: true });
    return 0;
  }
  if (action === 'update') {
    const id = requirePositional(positionals, 1, 'Harness ID is required.');
    const definitionPath = requireOption(options, 'definition');
    const current = await client.request(`/api/harnesses/${encodeURIComponent(id)}`);
    const definition = JSON.parse(await readFile(String(definitionPath), 'utf8'));
    const result = await client.request(`/api/harnesses/${encodeURIComponent(id)}/update`, {
      method: 'POST', body: { ...definition, expectedVersion: current.harness.version },
    });
    printValue(result.harness, { json: true });
    return 0;
  }
  if (['test', 'activate', 'disable'].includes(action)) {
    const id = requirePositional(positionals, 1, 'Harness ID is required.');
    const current = await client.request(`/api/harnesses/${encodeURIComponent(id)}`);
    const result = await client.request(`/api/harnesses/${encodeURIComponent(id)}/${action}`, {
      method: 'POST', body: { expectedVersion: current.harness.version },
    });
    printValue(result, { json: true });
    if (action === 'test' && !result.test.passed) return 2;
    return 0;
  }
  throw new Error('Harness action must be list, show, create, update, test, activate, or disable.');
}

async function runSkill(client, positionals, options, json) {
  const action = positionals[0] || 'list';
  if (action === 'list') {
    const result = await client.request('/api/skills');
    printValue(result.skills, { json: true });
    return 0;
  }
  const id = requirePositional(positionals, 1, 'Skill ID is required.');
  if (action === 'show') {
    const result = await client.request(`/api/skills/${encodeURIComponent(id)}`);
    printValue(result.skill, { json: true });
    return 0;
  }
  if (action === 'activate' || action === 'disable') {
    const current = await client.request(`/api/skills/${encodeURIComponent(id)}`);
    const result = await client.request(`/api/skills/${encodeURIComponent(id)}/${action}`, {
      method: 'POST', body: { expectedVersion: current.skill.version },
    });
    printValue(result.skill, { json: true });
    return 0;
  }
  throw new Error('Skill action must be list, show, activate, or disable.');
}

async function runLearning(client, positionals, options, json) {
  const action = positionals[0];
  if (action === 'craft') {
    const type = String(requireOption(options, 'type')).toUpperCase();
    const failureCaseIds = repeatedOption(options, 'failure');
    if (failureCaseIds.length === 0) throw new Error('At least one --failure ID is required.');
    const body = {
      type,
      id: requireOption(options, 'id'),
      label: stringOption(options, 'label', requireOption(options, 'id')),
      description: stringOption(options, 'description', ''),
      failureCaseIds,
      rules: repeatedOption(options, 'rule'),
    };
    const result = await client.request('/api/learning/craft', { method: 'POST', body });
    printValue(result, { json: true });
    return 0;
  }
  if (action === 'apply') {
    const taskId = requirePositional(positionals, 1, 'Task ID is required.');
    const { task, users } = await currentTask(client, taskId);
    const body = {
      expectedVersion: task.version,
      harnessId: stringOption(options, 'harness', ''),
      skillIds: repeatedOption(options, 'skill'),
    };
    const result = await client.request(`/api/tasks/${encodeURIComponent(task.id)}/apply-learning`, { method: 'POST', body });
    if (json) printValue(result, { json: true });
    else printTask(result.task, users, { json: false });
    return 0;
  }
  throw new Error('Learning action must be craft or apply.');
}

async function listFailures(client, options, json) {
  const params = new URLSearchParams();
  const status = option(options, 'status');
  const harness = option(options, 'harness');
  if (status && status !== true) params.set('status', String(status).toUpperCase());
  if (harness && harness !== true) params.set('harnessId', String(harness));
  const suffix = params.size ? `?${params}` : '';
  const result = await client.request(`/api/failures${suffix}`);
  if (json) printValue(result, { json: true });
  else {
    printFailures(result.failures);
    printValue(`\nOpen ${result.summary.open} · Fixture candidates ${result.summary.fixtureCandidates} · Occurrences ${result.summary.occurrences}`);
  }
  return 0;
}

async function runFailure(client, positionals, options, json) {
  const action = positionals[0];
  const id = requirePositional(positionals, 1, 'Failure case ID is required.');
  if (action === 'show') {
    const result = await client.request(`/api/failures/${encodeURIComponent(id)}`);
    printValue(result.failure, { json: true });
    return 0;
  }
  if (action === 'promote') {
    const result = await client.request(`/api/failures/${encodeURIComponent(id)}/promote`, { method: 'POST', body: {} });
    printValue(result, { json: true });
    return 0;
  }
  if (action === 'craft') {
    const type = String(requireOption(options, 'type')).toUpperCase();
    const body = {
      type,
      id: requireOption(options, 'id'),
      label: stringOption(options, 'label', requireOption(options, 'id')),
      description: stringOption(options, 'description', ''),
      failureCaseIds: [id, ...repeatedOption(options, 'failure')],
      rules: repeatedOption(options, 'rule'),
    };
    const result = await client.request('/api/learning/craft', { method: 'POST', body });
    printValue(result, { json: true });
    return 0;
  }
  const statuses = { resolve: 'RESOLVED', ignore: 'IGNORED', reopen: 'OPEN' };
  if (statuses[action]) {
    const result = await client.request(`/api/failures/${encodeURIComponent(id)}/status`, {
      method: 'POST', body: { status: statuses[action], note: stringOption(options, 'note', '') },
    });
    printValue(result.failure, { json: true });
    return 0;
  }
  throw new Error('Failure action must be show, resolve, ignore, reopen, promote, or craft.');
}

async function runAi(client, positionals, options, json) {
  const action = positionals[0];
  if (action === 'draft-task') {
    const result = await client.request('/api/ai/draft-task', {
      method: 'POST',
      body: { goal: requireOption(options, 'goal') },
    });
    printValue(result.draft, { json: true });
    return 0;
  }
  if (action === 'next-tasks') {
    const result = await client.request('/api/ai/next-tasks', {
      method: 'POST',
      body: { objective: requireOption(options, 'objective') },
    });
    printValue(result.result, { json: true });
    return 0;
  }
  if (action === 'brief' || action === 'verification-summary') {
    const taskId = requirePositional(positionals, 1, 'Task ID is required.');
    const { task, users } = await currentTask(client, taskId);
    const result = await client.request(`/api/tasks/${encodeURIComponent(task.id)}/ai-${action}`, {
      method: 'POST',
      body: { expectedVersion: task.version },
    });
    if (json) printValue({ task: result.task }, { json: true });
    else {
      const field = action === 'brief' ? result.task.ai?.brief : result.task.ai?.verificationSummary;
      printValue(field ?? result.task, { json: true });
      process.stdout.write(`\nSaved to ${result.task.id} v${result.task.version}.\n`);
    }
    return 0;
  }
  throw new Error('AI action must be draft-task, next-tasks, brief, or verification-summary.');
}

async function currentTask(client, taskId) {
  const bootstrap = await client.request('/api/bootstrap');
  return { task: findTask(bootstrap.tasks, taskId), users: bootstrap.users, bootstrap };
}

function findTask(tasks, taskId) {
  const exact = tasks.find((task) => task.id === taskId);
  if (exact) return exact;
  const prefix = tasks.filter((task) => task.id.startsWith(taskId));
  if (prefix.length === 1) return prefix[0];
  if (prefix.length > 1) throw new Error(`Task ID prefix is ambiguous: ${taskId}`);
  throw new Error(`Task not found: ${taskId}`);
}

function resolveUserId(users, selector) {
  if (selector == null || selector === true || String(selector).trim() === '') return null;
  const value = String(selector).trim();
  const matches = users.filter((user) => user.id === value || user.id.startsWith(value) || user.name.toLowerCase() === value.toLowerCase());
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) throw new Error(`User selector is ambiguous: ${value}`);
  throw new Error(`User not found: ${value}`);
}

async function passwordFrom(options) {
  const direct = option(options, 'password', process.env.TEAM_LOOP_PASSWORD);
  if (direct !== undefined && direct !== true && String(direct).length > 0) return String(direct);
  return readPassword();
}

async function serve(options) {
  if (option(options, 'workspace') && option(options, 'workspace') !== true) process.env.WORKSPACE_ROOT = String(option(options, 'workspace'));
  if (option(options, 'data-dir') && option(options, 'data-dir') !== true) process.env.DATA_DIR = String(option(options, 'data-dir'));
  if (option(options, 'port') && option(options, 'port') !== true) process.env.PORT = String(option(options, 'port'));
  if (option(options, 'host') && option(options, 'host') !== true) process.env.HOST = String(option(options, 'host'));
  if (option(options, 'signup-code') && option(options, 'signup-code') !== true) process.env.SIGNUP_CODE = String(option(options, 'signup-code'));
  await import('../../server.js');
  return 0;
}

function stringOption(options, name, fallback) {
  const value = option(options, name, fallback);
  return value === true ? fallback : String(value);
}

function numberOption(options, name, fallback) {
  const value = Number(option(options, name, fallback));
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number.`);
  return value;
}

function requirePositional(positionals, index, message) {
  const value = positionals[index];
  if (!value) throw new Error(message);
  return value;
}

function printHelp() {
  process.stdout.write(`Team Loop Lite + AI CLI\n\nUsage:\n  team-loop [--server URL] [--json] <command>\n\nServer:\n  team-loop serve --workspace /path/to/game [--port 4173]\n  team-loop health\n\nAuthentication:\n  team-loop register --name Alice [--signup-code CODE]\n  team-loop login --name Alice\n  team-loop logout\n  team-loop whoami\n\nTeam and tasks:\n  team-loop users\n  team-loop tasks [--status REVIEW] [--mine]\n  team-loop task show <task-id>\n  team-loop task create --title TEXT [--description TEXT] [--priority 100]\n      [--allowed-path PATH ...] [--criterion TEXT ...] [--profile PROFILE]\n      [--assignee NAME_OR_ID] [--reviewer NAME_OR_ID]\n  team-loop task claim <task-id>\n  team-loop task verify <task-id>\n  team-loop task request-review <task-id>\n  team-loop task approve <task-id> [--comment TEXT]\n  team-loop task reject <task-id> [--comment TEXT]\n  team-loop task block <task-id> --reason TEXT\n  team-loop task unblock <task-id>\n\nHarnesses and failures:\n  team-loop harness list\n  team-loop harness show <id>\n  team-loop harness create --id ID --label TEXT --file COMMAND [--arg ARG ...]\n      [--cwd .] [--expected-exit 0] [--timeout-ms 120000]\n  team-loop harness create --definition harness.json\n  team-loop harness update <id> --definition harness.json\n  team-loop harness test <id>\n  team-loop harness activate <id>\n  team-loop harness disable <id>\n  team-loop skill list\n  team-loop skill show|activate|disable <id>\n  team-loop learning craft --type HARNESS|SKILL --id ID --failure CASE_ID [--failure CASE_ID ...]\n      [--label TEXT] [--description TEXT] [--rule TEXT ...]\n  team-loop learning apply <task-id> [--harness ID] [--skill ID ...]\n  team-loop failures [--status OPEN] [--harness ID]\n  team-loop failure show <id>\n  team-loop failure promote <id>\n  team-loop failure craft <id> --type HARNESS|SKILL --id ID [--failure CASE_ID ...]\n  team-loop failure resolve|ignore|reopen <id> [--note TEXT]\n\nAI advisor:\n  team-loop ai draft-task --goal TEXT\n  team-loop ai next-tasks --objective TEXT\n  team-loop ai brief <task-id>\n  team-loop ai verification-summary <task-id>\n\nExternal usage:\n  team-loop usage status [--days 30]\n  team-loop usage push [--daemon --interval 300]\n  team-loop usage receiver [--host 127.0.0.1 --port 4318]\n  claude-statusline-command | team-loop usage capture-claude-statusline [--quiet]\n\nEnvironment:\n  TEAM_LOOP_URL                 default server URL\n  TEAM_LOOP_PASSWORD            password for login/register\n  TEAM_LOOP_CLI_HOME            session storage directory\n  TEAM_LOOP_SESSION_COOKIE      non-persistent session for automation\n  TEAM_LOOP_CLI_TIMEOUT_MS      request timeout (default 300000)\n\nPasswords are prompted without echo when --password and TEAM_LOOP_PASSWORD are absent.\n`);
}
