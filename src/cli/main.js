import { parseCliArgs, option, requireOption, listOption, repeatedOption } from './args.js';
import { CliClient } from './client.js';
import { botHome, clearSession, loadConfig, loadSession, loadSessionFrom, normalizeServer, saveConfig, saveSession } from './session.js';
import { mergeCliExecutor } from '../executor.js';
import { printFailures, printHarnesses, printTask, printTasks, printUsers, printValue } from './format.js';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
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
  if (command === 'config') return runConfig(positionals.slice(1), options, json);
  if (command === 'solo') return runSolo(client, positionals.slice(1), options, json);
  if (command === 'reviewer') return runReviewer(client, positionals.slice(1), options, json);
  if (command === 'orchestrate') return runOrchestrate(client, positionals.slice(1), options, json);
  if (command === 'dispatch') return runDispatch(client, positionals.slice(1), options, json);

  throw new Error(`Unknown command: ${command}. Run "team-loop help".`);
}

// Shared: one reviewer decision on a single task -- approve when program verification
// is green and the workspace fingerprint still matches, otherwise reject.
async function reviewOneTask(client, taskId, approveComment, rejectComment) {
  const fresh = findTask((await client.request('/api/bootstrap')).tasks, taskId);
  if (!fresh || fresh.status !== 'REVIEW') return { taskId, action: 'skip', reason: 'not in REVIEW' };
  if (!fresh.verification?.passed) return rejectTask(client, fresh, `${rejectComment} (verification not green)`);
  try {
    const result = await client.request(`/api/tasks/${encodeURIComponent(fresh.id)}/review`, {
      method: 'POST', body: { expectedVersion: fresh.version, decision: 'APPROVE', comment: approveComment },
    });
    return { taskId, action: 'approved', reason: `-> ${result.task.status}` };
  } catch (error) {
    const latest = findTask((await client.request('/api/bootstrap')).tasks, taskId);
    if (latest && latest.status === 'REVIEW') return rejectTask(client, latest, `${rejectComment} (${error.message})`);
    return { taskId, action: 'skip', reason: error.message };
  }
}

function buildDispatchPrompt(task, rules, workspace) {
  const lines = [];
  lines.push(`You are an autonomous coding agent completing ONE task in the git repository at ${workspace}.`);
  lines.push('');
  lines.push(`# Task: ${task.title}`);
  if (task.description) lines.push(task.description);
  if (task.acceptanceCriteria?.length) {
    lines.push('', '# Acceptance criteria (all must hold when you finish):');
    for (const item of task.acceptanceCriteria) lines.push(`- ${item}`);
  }
  lines.push('', '# HARD scope constraint');
  lines.push(`Create or modify ONLY files matching these path patterns: ${task.allowedPaths.join(', ')}.`);
  lines.push('Do NOT touch any file outside this scope. Paths owned by other tasks/agents are off-limits.');
  if (rules.length) {
    lines.push('', '# Team rules (shared skills):');
    for (const rule of rules) lines.push(`- ${rule}`);
  }
  lines.push('', '# Finish');
  lines.push('Make the smallest change that satisfies the acceptance criteria, then stop. Do NOT run git commit, push, or any network calls.');
  return lines.join('\n');
}

function runExecutor(tool, prompt, { workspace, model, permission, inherit }) {
  return new Promise((resolve, reject) => {
    if (tool !== 'claude-code') {
      reject(new Error(`Executor "${tool}" is not supported yet (only claude-code).`));
      return;
    }
    // Deliver the prompt on STDIN, never as a CLI argument: a long multi-line prompt on
    // the command line gets mangled by the shell/OS (the exact trap the powershell-encoding
    // skill warns about), so the agent silently receives a broken prompt. `claude -p` reads
    // the prompt from stdin when no prompt argument is given.
    const args = ['-p', '--permission-mode', permission || 'acceptEdits'];
    if (model) args.push('--model', model);
    const exe = process.env.TEAM_LOOP_CLAUDE_BIN || 'claude';
    const child = spawn(exe, args, {
      cwd: workspace,
      stdio: ['pipe', inherit ? 'inherit' : 'pipe', inherit ? 'inherit' : 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let out = '';
    if (!inherit) {
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { out += chunk; });
    }
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output: out }));
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// Dispatch: hand an existing board task to a CLI executor that actually does the work,
// then verify. Dry-run by default; --execute really runs the agent in WORKSPACE_ROOT.
async function runDispatch(client, positionals, options, json) {
  const taskId = requirePositional(positionals, 0, 'Task ID is required.');
  const bootstrap = await client.request('/api/bootstrap');
  let task = findTask(bootstrap.tasks, taskId);
  if (!task) throw new Error(`Task ${taskId} not found.`);
  const workspace = bootstrap.workspace?.root || process.cwd();

  if (task.status === 'READY') {
    const executor = mergeCliExecutor(await loadConfig());
    task = (await client.request(`/api/tasks/${encodeURIComponent(task.id)}/claim`, {
      method: 'POST', body: { expectedVersion: task.version, ...(executor ? { executor } : {}) },
    })).task;
  }
  if (task.status !== 'IN_PROGRESS') throw new Error(`Task must be IN_PROGRESS to dispatch (now ${task.status}).`);

  const activeSkills = (await client.request('/api/skills')).skills
    .filter((skill) => skill.status === 'ACTIVE' && (task.skillIds || []).includes(skill.id));
  const rules = activeSkills.flatMap((skill) => skill.rules || []);
  const tool = stringOption(options, 'executor', task.executor?.tool || 'claude-code');
  const model = stringOption(options, 'model', task.executor?.model || '');
  const prompt = buildDispatchPrompt(task, rules, workspace);

  if (!options.execute) {
    const plan = {
      dryRun: true, taskId: task.id, status: task.status, executor: tool, model: model || null,
      workspace, allowedPaths: task.allowedPaths, skillRules: rules, prompt,
      wouldRun: `claude -p <prompt> --permission-mode ${stringOption(options, 'permission', 'acceptEdits')}${model ? ` --model ${model}` : ''}`,
    };
    printValue(plan, { json: true });
    if (!json) process.stdout.write('\n[dry-run] Re-run with --execute to actually run the agent in the workspace.\n');
    return 0;
  }

  if (!json) process.stdout.write(`Dispatching ${task.id} to ${tool} in ${workspace} ...\n`);
  const run = await runExecutor(tool, prompt, {
    workspace, model, permission: stringOption(options, 'permission', 'acceptEdits'), inherit: !json,
  });
  if (!json) process.stdout.write(`Executor exited with code ${run.code}. Verifying ...\n`);

  const verifyResult = await client.request(`/api/tasks/${encodeURIComponent(task.id)}/verify`, { method: 'POST', body: { expectedVersion: task.version } });
  task = verifyResult.task;
  const passed = Boolean(task.verification?.passed);

  let review = null;
  const to = stringOption(options, 'to', 'verify');
  if (passed && (to === 'review' || to === 'done')) {
    task = (await client.request(`/api/tasks/${encodeURIComponent(task.id)}/request-review`, { method: 'POST', body: { expectedVersion: task.version } })).task;
    if (to === 'done') {
      const reviewerSession = await loadSessionFrom(stringOption(options, 'reviewer-home', botHome()));
      if (!reviewerSession?.cookie) throw new Error('No reviewer session; set up the reviewer bot or use --to review.');
      const reviewerClient = new CliClient({ server: client.server, cookie: reviewerSession.cookie });
      review = await reviewOneTask(reviewerClient, task.id, 'Auto-approved after dispatch (verification green).', 'Auto-rejected after dispatch: re-verification required.');
    }
  }

  const final = findTask((await client.request('/api/bootstrap')).tasks, task.id);
  const summary = { taskId: task.id, executorExit: run.code, verification: final.verification?.status, passed, finalStatus: final.status, review };
  if (json) printValue({ ...summary, task: final }, { json: true });
  else {
    process.stdout.write(`verify=${final.verification?.status} passed=${passed} status=${final.status}${review ? ` review=${review.action}` : ''}\n`);
    if (!passed) process.stdout.write(`Failure cases: ${(verifyResult.failureCases || []).map((f) => f.id).join(', ') || 'none'}\n`);
  }
  return passed ? 0 : 2;
}

// Full loop orchestration: the current account acts as worker (create -> claim ->
// verify -> request-review); a separate reviewer bot account then approves (or rejects)
// so a task reaches DONE end to end without SOLO_MODE self-approval.
async function runOrchestrate(client, positionals, options, json) {
  const action = positionals[0] || 'run';
  if (action !== 'run') throw new Error('Orchestrate action must be run. Usage: team-loop orchestrate run --goal "..."');
  const goal = requireOption(options, 'goal');
  const steps = [];
  const log = (message) => { steps.push(message); if (!json) process.stdout.write(`${message}\n`); };

  // Reviewer bot session from a separate CLI home.
  const reviewerHome = stringOption(options, 'reviewer-home', botHome());
  const reviewerSession = await loadSessionFrom(reviewerHome);
  if (!reviewerSession?.cookie) {
    throw new Error(`No reviewer session in ${reviewerHome}. Set it up first, e.g. TEAM_LOOP_CLI_HOME="${reviewerHome}" team-loop register --name reviewer-bot`);
  }
  if (reviewerSession.server && normalizeServer(reviewerSession.server) !== client.server) {
    throw new Error(`Reviewer session server (${reviewerSession.server}) differs from ${client.server}.`);
  }
  const reviewerClient = new CliClient({ server: client.server, cookie: reviewerSession.cookie });

  const bootstrap = await client.request('/api/bootstrap');
  const worker = bootstrap.user;
  if (reviewerSession.user?.id && reviewerSession.user.id === worker.id) {
    throw new Error('Reviewer bot must be a different account than the worker.');
  }

  // WORKER: create
  const allowedPaths = listOption(options, 'allowed-path');
  const criteria = listOption(options, 'criterion');
  let task = (await client.request('/api/tasks', { method: 'POST', body: {
    title: stringOption(options, 'title', String(goal).slice(0, 120)),
    description: stringOption(options, 'description', String(goal)),
    priority: numberOption(options, 'priority', 100),
    allowedPaths: allowedPaths.length ? allowedPaths : ['**'],
    acceptanceCriteria: criteria,
    verificationProfile: stringOption(options, 'profile', 'repository-basic'),
  } })).task;
  log(`1) [worker ${worker.name}] created ${task.id}`);

  // WORKER: claim (attach personal CLI executor profile)
  const executor = mergeCliExecutor(await loadConfig());
  task = (await client.request(`/api/tasks/${encodeURIComponent(task.id)}/claim`, {
    method: 'POST', body: { expectedVersion: task.version, ...(executor ? { executor } : {}) },
  })).task;
  log(`2) [worker] claimed -> ${task.status}${task.executor?.tool ? ` as ${task.executor.tool}${task.executor.model ? `/${task.executor.model}` : ''}` : ''}`);

  // WORKER: verify (program decides pass/fail)
  const verifyResult = await client.request(`/api/tasks/${encodeURIComponent(task.id)}/verify`, { method: 'POST', body: { expectedVersion: task.version } });
  task = verifyResult.task;
  log(`3) [worker] verify -> ${task.verification?.status} passed=${Boolean(task.verification?.passed)}`);
  if (!task.verification?.passed) {
    const ids = (verifyResult.failureCases || []).map((item) => item.id);
    log(`   stopped at ${task.status}; failure cases: ${ids.length ? ids.join(', ') : 'none'}`);
    if (json) printValue({ completed: false, task, steps }, { json: true });
    return 2;
  }

  // WORKER: request review
  task = (await client.request(`/api/tasks/${encodeURIComponent(task.id)}/request-review`, { method: 'POST', body: { expectedVersion: task.version } })).task;
  log(`4) [worker] request-review -> ${task.status}`);

  // REVIEWER BOT: approve if still green + unchanged, else reject
  const outcome = await reviewOneTask(
    reviewerClient, task.id,
    stringOption(options, 'comment', 'Auto-approved by reviewer bot: verification green and workspace unchanged.'),
    stringOption(options, 'reject-comment', 'Auto-rejected by reviewer bot: re-verification required.'),
  );
  log(`5) [reviewer ${reviewerSession.user?.name || 'bot'}] ${outcome.action}${outcome.reason ? ` (${outcome.reason})` : ''}`);

  const final = findTask((await client.request('/api/bootstrap')).tasks, task.id);
  if (json) printValue({ completed: final?.status === 'DONE', task: final, steps }, { json: true });
  else printTask(final, bootstrap.users, { json: false });
  return final?.status === 'DONE' ? 0 : 2;
}

async function runReviewer(client, positionals, options, json) {
  const action = positionals[0] || 'run';
  if (action !== 'run') throw new Error('Reviewer action must be run. Usage: team-loop reviewer run [--once | --interval N]');
  const approveComment = stringOption(options, 'comment', 'Auto-approved by reviewer bot: program verification green and workspace unchanged.');
  const rejectComment = stringOption(options, 'reject-comment', 'Auto-rejected by reviewer bot: re-verification required.');
  const daemon = options.interval !== undefined && !options.once;
  const intervalSeconds = Math.max(30, numberOption(options, 'interval', 60));

  const reviewOne = (taskId) => reviewOneTask(client, taskId, approveComment, rejectComment);

  const runPass = async () => {
    const bootstrap = await client.request('/api/bootstrap');
    const me = bootstrap.user;
    const reviewable = bootstrap.tasks.filter((task) =>
      task.status === 'REVIEW' &&
      task.assigneeUserId !== me.id &&
      (!task.reviewerUserId || task.reviewerUserId === me.id));
    const results = [];
    for (const task of reviewable) {
      const outcome = await reviewOne(task.id);
      results.push(outcome);
      if (!json) process.stdout.write(`${outcome.taskId}: ${outcome.action}${outcome.reason ? ` (${outcome.reason})` : ''}\n`);
    }
    if (!reviewable.length && !json) process.stdout.write('No reviewable tasks.\n');
    return results;
  };

  if (!daemon) {
    const results = await runPass();
    if (json) printValue({ results }, { json: true });
    return 0;
  }
  if (!json) process.stdout.write(`Reviewer bot polling every ${intervalSeconds}s. Ctrl+C to stop.\n`);
  await runPass();
  await new Promise((resolve) => {
    const timer = setInterval(() => runPass().catch((error) => process.stderr.write(`reviewer pass failed: ${error.message}\n`)), intervalSeconds * 1000);
    const stop = () => { clearInterval(timer); resolve(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

async function rejectTask(client, task, comment) {
  try {
    const result = await client.request(`/api/tasks/${encodeURIComponent(task.id)}/review`, {
      method: 'POST', body: { expectedVersion: task.version, decision: 'REJECT', comment: String(comment).slice(0, 2000) },
    });
    return { taskId: task.id, action: 'rejected', reason: `-> ${result.task.status}` };
  } catch (error) {
    return { taskId: task.id, action: 'error', reason: error.message };
  }
}

async function runSolo(client, positionals, options, json) {
  const action = positionals[0] || 'run';
  if (action !== 'run') throw new Error('Solo action must be run. Usage: team-loop solo run --goal "..."');
  const goal = requireOption(options, 'goal');
  const bootstrap = await client.request('/api/bootstrap');
  const steps = [];
  const log = (message) => { steps.push(message); if (!json) process.stdout.write(`${message}\n`); };

  // 1) create task (use AI draft when the server has AI enabled, else derive from the goal)
  let draft = null;
  if (bootstrap.ai?.enabled) {
    try { draft = (await client.request('/api/ai/draft-task', { method: 'POST', body: { goal } })).draft; }
    catch (error) { log(`  AI draft skipped: ${error.message}`); }
  }
  const allowedPaths = listOption(options, 'allowed-path');
  const criteria = listOption(options, 'criterion');
  const createBody = {
    title: stringOption(options, 'title', String(draft?.title || goal).slice(0, 120)),
    description: stringOption(options, 'description', String(draft?.description || goal)),
    priority: numberOption(options, 'priority', 100),
    allowedPaths: allowedPaths.length ? allowedPaths : (Array.isArray(draft?.allowedPaths) && draft.allowedPaths.length ? draft.allowedPaths : ['**']),
    acceptanceCriteria: criteria.length ? criteria : (Array.isArray(draft?.acceptanceCriteria) ? draft.acceptanceCriteria : []),
    verificationProfile: stringOption(options, 'profile', 'repository-basic'),
  };
  let task = (await client.request('/api/tasks', { method: 'POST', body: createBody })).task;
  log(`1) created ${task.id} (${task.status})`);

  // 2) claim, attaching this machine's personal CLI executor profile
  const executor = mergeCliExecutor(await loadConfig());
  task = (await client.request(`/api/tasks/${encodeURIComponent(task.id)}/claim`, {
    method: 'POST', body: { expectedVersion: task.version, ...(executor ? { executor } : {}) },
  })).task;
  log(`2) claimed -> ${task.status}${task.executor?.tool ? ` as ${task.executor.tool}${task.executor.model ? `/${task.executor.model}` : ''}` : ''}`);

  // 3) AI brief (optional, advisory only)
  if (bootstrap.ai?.enabled) {
    try { task = (await client.request(`/api/tasks/${encodeURIComponent(task.id)}/ai-brief`, { method: 'POST', body: { expectedVersion: task.version } })).task; log('3) AI brief attached'); }
    catch (error) { log(`3) AI brief skipped: ${error.message}`); }
  } else { log('3) AI brief skipped (AI disabled on server)'); }

  // 4) program verification (harness) decides pass/fail -- AI never does
  const verifyResult = await client.request(`/api/tasks/${encodeURIComponent(task.id)}/verify`, { method: 'POST', body: { expectedVersion: task.version } });
  task = verifyResult.task;
  const passed = Boolean(task.verification?.passed);
  log(`4) verify -> ${task.verification?.status} passed=${passed}`);
  if (!passed) {
    const ids = (verifyResult.failureCases || []).map((item) => item.id);
    log(`   verification failed; task left at ${task.status}. Failure cases: ${ids.length ? ids.join(', ') : 'none'}`);
    if (json) printValue({ completed: false, task, steps }, { json: true });
    return 2;
  }

  // 5) request review
  task = (await client.request(`/api/tasks/${encodeURIComponent(task.id)}/request-review`, { method: 'POST', body: { expectedVersion: task.version } })).task;
  log(`5) request-review -> ${task.status}`);

  // 6) self-approve (requires the server to run with SOLO_MODE=true)
  try {
    task = (await client.request(`/api/tasks/${encodeURIComponent(task.id)}/review`, {
      method: 'POST', body: { expectedVersion: task.version, decision: 'APPROVE', comment: stringOption(options, 'comment', 'Solo self-approval.') },
    })).task;
    log(`6) self-approve -> ${task.status}`);
  } catch (error) {
    log(`6) self-approve blocked: ${error.message}`);
    log('   Start the server with SOLO_MODE=true to allow solo completion.');
    if (json) printValue({ completed: false, task, steps }, { json: true });
    return 2;
  }

  if (json) printValue({ completed: task.status === 'DONE', task, steps }, { json: true });
  else printTask(task, bootstrap.users, { json: false });
  return task.status === 'DONE' ? 0 : 2;
}

async function runConfig(positionals, options, json) {
  const action = positionals[0] || 'show';
  const config = (await loadConfig()) || { schemaVersion: 1, executor: {}, defaults: {} };
  config.schemaVersion = 1;
  config.executor = config.executor && typeof config.executor === 'object' ? config.executor : {};
  config.defaults = config.defaults && typeof config.defaults === 'object' ? config.defaults : {};

  if (action === 'show') {
    printValue(config, { json: true });
    return 0;
  }
  if (action === 'clear') {
    await saveConfig({ schemaVersion: 1, executor: {}, defaults: {} });
    printValue('Cleared CLI executor profile.', { json });
    return 0;
  }
  if (action === 'set') {
    if (option(options, 'tool') !== undefined) config.executor.tool = String(option(options, 'tool'));
    if (option(options, 'model') !== undefined) config.executor.model = String(option(options, 'model'));
    if (option(options, 'default-harness') !== undefined) config.defaults.harness = String(option(options, 'default-harness'));
    const skills = repeatedOption(options, 'default-skill');
    if (skills.length) config.defaults.skills = skills;
    await saveConfig(config);
    printValue(config, { json: true });
    return 0;
  }
  throw new Error(`Unknown config action: ${action}. Use show, set, or clear.`);
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
      assigneeUserId: resolveUserId(bootstrap.users, option(options, 'assignee')),
      reviewerUserId: resolveUserId(bootstrap.users, option(options, 'reviewer')),
    };
    if (option(options, 'profile') !== undefined) body.verificationProfile = stringOption(options, 'profile', 'repository-basic');
    if (option(options, 'skill') !== undefined) body.skillIds = repeatedOption(options, 'skill');
    if (options['no-auto-learning']) body.noAutoLearning = true;
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
  } else if (action === 'claim') {
    const executor = mergeCliExecutor(await loadConfig());
    if (executor) body.executor = executor;
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
  process.stdout.write(`Team Loop Lite + AI CLI\n\nUsage:\n  team-loop [--server URL] [--json] <command>\n\nServer:\n  team-loop serve --workspace /path/to/game [--port 4173]\n  team-loop health\n\nAuthentication:\n  team-loop register --name Alice [--signup-code CODE]\n  team-loop login --name Alice\n  team-loop logout\n  team-loop whoami\n\nTeam and tasks:\n  team-loop users\n  team-loop tasks [--status REVIEW] [--mine]\n  team-loop task show <task-id>\n  team-loop task create --title TEXT [--description TEXT] [--priority 100]\n      [--allowed-path PATH ...] [--criterion TEXT ...] [--profile PROFILE]\n      [--assignee NAME_OR_ID] [--reviewer NAME_OR_ID]\n  team-loop task claim <task-id>\n  team-loop task verify <task-id>\n  team-loop task request-review <task-id>\n  team-loop task approve <task-id> [--comment TEXT]\n  team-loop task reject <task-id> [--comment TEXT]\n  team-loop task block <task-id> --reason TEXT\n  team-loop task unblock <task-id>\n\nHarnesses and failures:\n  team-loop harness list\n  team-loop harness show <id>\n  team-loop harness create --id ID --label TEXT --file COMMAND [--arg ARG ...]\n      [--cwd .] [--expected-exit 0] [--timeout-ms 120000]\n  team-loop harness create --definition harness.json\n  team-loop harness update <id> --definition harness.json\n  team-loop harness test <id>\n  team-loop harness activate <id>\n  team-loop harness disable <id>\n  team-loop skill list\n  team-loop skill show|activate|disable <id>\n  team-loop learning craft --type HARNESS|SKILL --id ID --failure CASE_ID [--failure CASE_ID ...]\n      [--label TEXT] [--description TEXT] [--rule TEXT ...]\n  team-loop learning apply <task-id> [--harness ID] [--skill ID ...]\n  team-loop failures [--status OPEN] [--harness ID]\n  team-loop failure show <id>\n  team-loop failure promote <id>\n  team-loop failure craft <id> --type HARNESS|SKILL --id ID [--failure CASE_ID ...]\n  team-loop failure resolve|ignore|reopen <id> [--note TEXT]\n\nAI advisor:\n  team-loop ai draft-task --goal TEXT\n  team-loop ai next-tasks --objective TEXT\n  team-loop ai brief <task-id>\n  team-loop ai verification-summary <task-id>\n\nExternal usage:\n  team-loop usage status [--days 30]\n  team-loop usage push [--daemon --interval 300]\n  team-loop usage receiver [--host 127.0.0.1 --port 4318]\n  claude-statusline-command | team-loop usage capture-claude-statusline [--quiet]\n\nDispatch (hand a task to a CLI agent that does the work):\n  team-loop dispatch <task-id> [--execute] [--model NAME] [--permission MODE]\n      [--to verify|review|done] [--reviewer-home DIR]\n  (default is a dry-run that prints the work order; --execute runs the agent\n   headless in WORKSPACE_ROOT, then verifies. Only claude-code executor for now.)\n\nOrchestrate (full loop: worker + reviewer bot):\n  team-loop orchestrate run --goal "TEXT" [--reviewer-home DIR]\n      [--title T] [--allowed-path P ...] [--criterion C ...] [--profile HARNESS]\n  (worker: create->claim->verify->request-review; reviewer bot then approves to DONE)\n\nReviewer bot (auto-review from a separate account):\n  team-loop reviewer run [--once | --interval SECONDS]\n      [--comment TEXT] [--reject-comment TEXT]\n  (approves REVIEW tasks when verification is green and workspace is unchanged,\n   otherwise rejects for re-verification; log in as a non-assignee account)\n\nSolo mode (single-person loop):\n  team-loop solo run --goal "TEXT" [--title T] [--allowed-path P ...]\n      [--criterion C ...] [--profile HARNESS] [--comment TEXT]\n  (create -> claim -> verify -> self-approve to DONE; server needs SOLO_MODE=true)\n\nPersonal CLI profile:\n  team-loop config show\n  team-loop config set [--tool claude-code|codex|custom] [--model NAME]\n      [--default-harness ID] [--default-skill ID ...]\n  team-loop config clear\n  (task claim attaches this profile; the server records it on the task)\n\nEnvironment:\n  TEAM_LOOP_URL                 default server URL\n  TEAM_LOOP_PASSWORD            password for login/register\n  TEAM_LOOP_CLI_HOME            session storage directory\n  TEAM_LOOP_SESSION_COOKIE      non-persistent session for automation\n  TEAM_LOOP_CLI_TIMEOUT_MS      request timeout (default 300000)\n\nPasswords are prompted without echo when --password and TEAM_LOOP_PASSWORD are absent.\n`);
}
