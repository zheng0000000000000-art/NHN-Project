import { parseCliArgs, option, requireOption, listOption, repeatedOption } from './args.js';
import { CliClient } from './client.js';
import { botHome, clearSession, loadConfig, loadSession, loadSessionFrom, normalizeServer, saveConfig, saveSession } from './session.js';
import { mergeCliExecutor } from '../executor.js';
import { commitTaskWorktree, createTaskWorktree, mergePreparedWorktree, mergeTaskWorktree, removeTaskWorktree, listTaskWorktrees, worktreePath } from '../worktree.js';
import { printFailures, printHarnesses, printTask, printTasks, printUsers, printValue } from './format.js';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { readPassword } from './password.js';
import { captureClaudeStatusline, collectUsageSnapshots, commitUsageCursor } from './usage-collector.js';
import { startOtelReceiver } from './otel-receiver.js';
import { Verifier, globMatch } from '../verifier.js';
import { RunArtifactService, normalizeRunDocument } from '../run-artifacts.js';
import { auditSkills, buildSkillPolicy } from '../skill-policy.js';
import { ScopeLeaseService } from '../scope-leases.js';
import { RunLedger } from '../run-ledger.js';
import { initializeProject, loadProjectConfig } from '../project-setup.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEAM_LOOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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
  if (command === 'init') return initProject(options, json);
  if (command === 'work') return workProject(positionals.slice(1), options, json);
  if (command === 'run') return runArtifact(positionals.slice(1), options, json);

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
    if (options.archived) tasks = tasks.filter((task) => task.archived);
    else if (!options.all) tasks = tasks.filter((task) => !task.archived);
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
  if (command === 'worktree') return runWorktree(client, positionals.slice(1), options, json);

  throw new Error(`Unknown command: ${command}. Run "team-loop help".`);
}

async function runArtifact(args, options, json) {
  const action = args[0];
  const workspaceRoot = path.resolve(option(options, 'workspace', process.cwd()));
  const scopeLeases = new ScopeLeaseService({ workspaceRoot });
  const runLedger = new RunLedger({ workspaceRoot });
  if (action === 'draft') {
    const id = args[1];
    if (!id) throw new Error('Run id is required.');
    const verifier = createRunVerifier(workspaceRoot);
    const hinted = listOption(options, 'allowed-path');
    const actual = (await verifier.changedPaths()).filter((item) => !item.startsWith('.team-loop/') && !item.startsWith('.team-loop-worktrees/'));
    const writeScope = hinted.length ? hinted : actual;
    const paths = hinted.length ? actual.filter((item) => hinted.some((pattern) => globMatch(pattern, item))) : actual;
    if (!writeScope.length) throw new Error('No changed paths found. Provide --allowed-path.');
    const document = normalizeRunDocument({
      id, title: option(options, 'title', id), summary: option(options, 'summary', ''), objective: option(options, 'objective', ''), audience: option(options, 'audience', ''), mode: option(options, 'mode', 'AUTO'), agent: option(options, 'owner', ''),
      changes: paths.map((item) => ({ path: item, summary: '' })), writeScope,
      readScope: listOption(options, 'read-scope'), interfaces: listOption(options, 'interfaces'),
      sharedContracts: { terms: listOption(options, 'terms'), assumptions: listOption(options, 'assumptions'), requiredClaims: listOption(options, 'required-claims'), openQuestions: listOption(options, 'open-questions') },
      verification: { profile: option(options, 'profile', 'repository-basic') },
    });
    const file = path.join(workspaceRoot, '.team-loop', 'runs', `${document.id}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    printValue({ documentPath: slash(path.relative(workspaceRoot, file)), document }, { json });
    return 0;
  }
  if (action === 'sync') {
    const file = args[1];
    if (!file) throw new Error('Run document path is required.');
    const absolute = path.resolve(workspaceRoot, file);
    const document = normalizeRunDocument(JSON.parse(await readFile(absolute, 'utf8')));
    const verifier = createRunVerifier(workspaceRoot);
    const actual = (await verifier.changedPaths()).filter((item) => !item.startsWith('.team-loop/') && !item.startsWith('.team-loop-worktrees/'));
    const inScope = actual.filter((item) => document.writeScope.some((pattern) => globMatch(pattern, item)));
    const previous = new Map(document.changes.map((item) => [item.path, item.summary]));
    document.changes = inScope.map((item) => ({ path: item, summary: previous.get(item) || 'Automatically synchronized from Git changes' }));
    await writeFile(absolute, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    printValue({ runId: document.id, synchronizedPaths: inScope, outsideWriteScope: actual.filter((item) => !inScope.includes(item)) }, { json });
    return 0;
  }
  if (action === 'skill-stats') {
    const file = path.join(workspaceRoot, '.team-loop', 'learning', 'skill-outcomes.jsonl');
    let lines = [];
    try { lines = (await readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const latestByRun = new Map(lines.map((event) => [event.runId, event]));
    const runs = [...latestByRun.values()];
    const rate = (items) => items.length ? items.filter((item) => item.verdict === 'PASSED').length / items.length : null;
    const stats = {};
    for (const event of runs) for (const id of event.skillIds || []) {
      stats[id] ||= { runs: 0, passed: 0, failed: 0 };
      stats[id].runs += 1; stats[id][event.verdict === 'PASSED' ? 'passed' : 'failed'] += 1;
    }
    printValue({ note: 'Observed correlation, not causal proof.', overallPassRate: rate(runs), skills: Object.entries(stats).map(([id, value]) => {
      const without = runs.filter((event) => !(event.skillIds || []).includes(id));
      const passRate = value.runs ? value.passed / value.runs : null;
      const withoutSkillPassRate = rate(without);
      return { id, ...value, passRate, withoutSkillRuns: without.length, withoutSkillPassRate, observedUplift: withoutSkillPassRate == null ? null : passRate - withoutSkillPassRate };
    }).sort((a, b) => b.runs - a.runs) }, { json });
    return 0;
  }
  if (action === 'execute') {
    const file = args[1];
    if (!file) throw new Error('Run document path is required.');
    const document = normalizeRunDocument(JSON.parse(await readFile(path.resolve(workspaceRoot, file), 'utf8')));
    const policy = await buildSkillPolicy({ workspaceRoot, document });
    const tool = String(option(options, 'executor', 'codex'));
    const model = String(option(options, 'model', ''));
    const permission = String(option(options, 'permission', 'acceptEdits'));
    const sandbox = String(option(options, 'sandbox', 'workspace-write'));
    if (!options.execute) {
      printValue({ dryRun: true, runId: document.id, isolatedWorkspace: worktreePath(workspaceRoot, document.id), writeScope: document.writeScope, interfaces: document.interfaces, enabledSkills: policy.selected.map((item) => item.id), wouldRun: executorPreview(tool, model, { workspace: worktreePath(workspaceRoot, document.id), permission, sandbox }) }, { json: true });
      return 0;
    }
    const owner = String(option(options, 'owner', document.agent || process.env.USERNAME || process.env.USER || 'unknown'));
    const scope = await scopeLeases.acquire(document, { owner, ttlMinutes: option(options, 'ttl-minutes', 120) });
    const workspace = worktreePath(workspaceRoot, document.id);
    try { await access(workspace); } catch { await createTaskWorktree(workspaceRoot, document.id, { base: scope.lease.baseRevision || 'HEAD' }); }
    const prompt = buildRunPrompt(document, policy, workspace);
    const heartbeat = setInterval(() => { scopeLeases.heartbeat(document.id, { owner, ttlMinutes: option(options, 'ttl-minutes', 120) }).catch(() => {}); }, 60_000);
    heartbeat.unref();
    let execution;
    try { execution = await runExecutor(tool, prompt, { workspace, model, permission, sandbox, inherit: !json }); }
    finally { clearInterval(heartbeat); }
    const verifier = createRunVerifier(workspaceRoot);
    const actualPaths = await verifier.changedPaths(workspace);
    const inScopePaths = actualPaths.filter((item) => document.writeScope.some((pattern) => globMatch(pattern, item)));
    if (inScopePaths.length) {
      const summaryByPath = new Map(document.changes.map((item) => [item.path, item.summary]));
      document.changes = inScopePaths.map((item) => ({ path: item, summary: summaryByPath.get(item) || 'Automatically recorded from isolated worktree' }));
      await writeFile(path.resolve(workspaceRoot, file), `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    }
    const autoMerge = Boolean(options['auto-merge']);
    const output = await new RunArtifactService({ workspaceRoot, verifier }).verifyFile(file, { force: Boolean(options.force), root: workspace, releaseOnPass: false, passedScopeState: autoMerge ? 'VERIFIED_PENDING_AUTO_MERGE' : 'VERIFIED_AWAITING_APPROVAL' });
    let merge = null;
    let prepared = null;
    if (output.result.verdict === 'PASSED') {
      if (autoMerge) {
        merge = await mergeTaskWorktree(workspaceRoot, document.id, { message: `team-loop: ${document.title}`, trailers: { 'Run-Id': document.id } });
        await runLedger.recordEvent(document.id, { type: 'LANDED', attempt: output.result.attempt, commit: merge.commit, automatic: true });
      } else {
        prepared = await commitTaskWorktree(workspaceRoot, document.id, { message: `team-loop: ${document.title}`, trailers: { 'Run-Id': document.id }, remove: true });
        await runLedger.recordEvent(document.id, { type: 'VERIFIED_AWAITING_APPROVAL', attempt: output.result.attempt, commit: prepared.commit, branch: prepared.branch });
      }
      await scopeLeases.release(document.id, { reason: autoMerge ? 'verified worktree merged' : 'verified commit awaiting approval', owner });
    }
    printValue({ runId: document.id, taskId: document.taskId, attempt: output.result.attempt, executorExit: execution.code, verdict: output.result.verdict, state: merge ? 'LANDED' : prepared ? 'VERIFIED_AWAITING_APPROVAL' : 'FAILED', prepared, worktree: output.result.verdict === 'PASSED' ? null : workspace, merge, resultPath: output.resultPath }, { json });
    return output.result.verdict === 'PASSED' ? 0 : 2;
  }
  if (action === 'land') {
    const runId = args[1];
    if (!runId) throw new Error('Run id is required.');
    const latest = await runLedger.latest(runId);
    if (!latest || latest.verdict !== 'PASSED') throw new Error('Only a verified run can be landed.');
    const events = await runLedger.events(runId);
    if (events.some((item) => item.type === 'LANDED' && item.attempt === latest.attempt)) throw new Error(`Run ${runId} attempt ${latest.attempt} is already landed.`);
    const prepared = [...events].reverse().find((item) => item.type === 'VERIFIED_AWAITING_APPROVAL' && item.attempt === latest.attempt);
    if (!prepared) throw new Error('Verified branch metadata is missing.');
    const merge = await mergePreparedWorktree(workspaceRoot, runId, { trailers: { 'Run-Id': runId, 'Run-Attempt': latest.attempt } });
    await runLedger.recordEvent(runId, { type: 'LANDED', attempt: latest.attempt, commit: merge.commit, automatic: false });
    printValue({ runId, attempt: latest.attempt, state: 'LANDED', merge }, { json });
    return 0;
  }
  if (action === 'scopes') {
    printValue({ scopes: await scopeLeases.list() }, { json });
    return 0;
  }
  if (action === 'release') {
    const runId = args[1];
    if (!runId) throw new Error('Run id is required.');
    printValue(await scopeLeases.release(runId, { reason: 'manual release', owner: option(options, 'owner', process.env.USERNAME || process.env.USER || 'unknown') }), { json });
    return 0;
  }
  if (action === 'heartbeat') {
    const runId = args[1];
    if (!runId) throw new Error('Run id is required.');
    printValue(await scopeLeases.heartbeat(runId, { owner: option(options, 'owner'), ttlMinutes: option(options, 'ttl-minutes', 120) }), { json });
    return 0;
  }
  if (action === 'audit-skills') {
    const data = JSON.parse(await readFile(path.join(workspaceRoot, 'data', 'skills.json'), 'utf8'));
    const audits = auditSkills(Array.isArray(data.skills) ? data.skills : []);
    const gradeCounts = audits.reduce((counts, item) => ({ ...counts, [item.grade]: (counts[item.grade] || 0) + 1 }), {});
    printValue({ total: audits.length, gradeCounts, audits }, { json });
    return 0;
  }
  const file = args[1];
  if (!file) throw new Error('Run document path is required.');
  if (action === 'context' || action === 'begin') {
    const document = normalizeRunDocument(JSON.parse(await readFile(path.resolve(workspaceRoot, file), 'utf8')));
    const scope = await scopeLeases.acquire(document, { owner: option(options, 'owner'), ttlMinutes: option(options, 'ttl-minutes', 120) });
    const policy = await buildSkillPolicy({ workspaceRoot, document });
    const value = options.detail
      ? { runId: document.id, scope, skillPolicy: policy }
      : { runId: document.id, mode: document.mode, scope: scope.lease, reused: scope.reused, enabledSkills: policy.selected.map((item) => item.id), disabledDeclaredSkills: policy.autoDisabled, estimatedTokens: policy.estimatedTokens };
    printValue(value, { json });
    return 0;
  }
  if (action !== 'verify') throw new Error('Usage: team-loop run begin|context|verify <run.json>, run scopes, run heartbeat|release <run-id>, or run audit-skills');
  const verifier = createRunVerifier(workspaceRoot);
  const output = await new RunArtifactService({ workspaceRoot, verifier }).verifyFile(file, { force: Boolean(options.force) });
  printValue({ runId: output.result.runId, verdict: output.result.verdict, mode: output.result.mode, documentMatch: output.result.documentMatch, scopeLease: output.result.scopeLease, skillPolicy: output.result.skillPolicy, verificationStrength: output.result.verificationPolicy.strength, requestedProfile: output.result.verificationPolicy.requestedProfile, appliedProfile: output.result.verificationPolicy.appliedProfile, autoEscalated: output.result.verificationPolicy.autoEscalated, escalationReason: output.result.verificationPolicy.reason, checks: output.result.verification.checks.map((check) => ({ file: check.file, args: check.args, passed: check.passed, actualExit: check.actualExit })), undeclaredPaths: output.result.undeclaredPaths, missingDeclaredPaths: output.result.missingDeclaredPaths, resultPath: output.resultPath }, { json });
  return output.result.verdict === 'PASSED' ? 0 : 2;
}

function slash(value) { return String(value).replaceAll('\\', '/'); }

function createRunVerifier(workspaceRoot) {
  return new Verifier({
    workspaceRoot,
    runtimeRoot: TEAM_LOOP_ROOT,
    profilePaths: [
      path.join(TEAM_LOOP_ROOT, 'config', 'verification-profiles.json'),
      path.join(workspaceRoot, 'config', 'verification-profiles.json'),
      path.join(workspaceRoot, '.team-loop', 'verification-profiles.json'),
    ],
  });
}

async function initProject(options, json) {
  const workspaceRoot = path.resolve(option(options, 'workspace', process.cwd()));
  const initialized = await initializeProject(workspaceRoot, { force: Boolean(options.force) });
  printValue({ workspaceRoot, ...initialized }, { json });
  return 0;
}

async function workProject(args, options, json) {
  const workspaceRoot = path.resolve(option(options, 'workspace', process.cwd()));
  const project = await loadProjectConfig(workspaceRoot);
  if (!project) throw new Error('This project is not initialized. Run "team-loop init" first.');
  const goal = String(option(options, 'goal', args.join(' '))).trim();
  if (!goal) throw new Error('A work goal is required. Example: team-loop work "add search"');
  const mode = inferWorkMode(goal);
  const scope = mode === 'CODE'
    ? [...(project.sourceRoots || []), ...(project.testRoots || [])]
    : (project.documentRoots || ['docs/**', '*.md']);
  const id = `${new Date().toISOString().slice(0, 10)}-${slug(goal)}`.slice(0, 80).replace(/[-_.]+$/, '');
  const document = normalizeRunDocument({
    id, title: goal.slice(0, 160), objective: goal, mode,
    changes: [], writeScope: scope,
    verification: { profile: project.defaultProfile || 'project-default' },
    agent: option(options, 'owner', ''),
  });
  const relativeFile = `.team-loop/runs/${id}.json`;
  const absoluteFile = path.join(workspaceRoot, relativeFile);
  await mkdir(path.dirname(absoluteFile), { recursive: true });
  await writeFile(absoluteFile, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: options.force ? 'w' : 'wx' });
  if (options.execute) return runArtifact(['execute', relativeFile], { ...options, workspace: workspaceRoot, executor: option(options, 'executor', project.defaultExecutor || 'codex') }, json);
  printValue({ runId: id, mode: document.mode, writeScope: scope, documentPath: relativeFile, next: `team-loop run execute ${relativeFile} --execute` }, { json });
  return 0;
}

function inferWorkMode(goal) {
  if (/brainstorm|브레인스토밍|아이디어|대안/.test(goal.toLowerCase())) return 'BRAINSTORM';
  if (/document|docs?|readme|문서|정리|기획/.test(goal.toLowerCase())) return 'DOCUMENT';
  return 'CODE';
}

function slug(value) {
  const ascii = String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return ascii || `work-${Date.now().toString(36)}`;
}

function buildRunPrompt(document, policy, workspace) {
  const rules = policy.selected.flatMap((skill) => skill.rules.map((rule) => `- [${skill.id}] ${rule}`));
  const contracts = document.sharedContracts;
  const modeInstruction = document.mode.appliedMode === 'BRAINSTORM'
    ? 'First diverge into independent idea categories, then add counterarguments and a separate synthesis. Preserve rejected and deferred options with reasons.'
    : document.mode.appliedMode === 'DOCUMENT'
      ? 'Produce a reader-ready document. Separate claims, evidence or assumptions, decisions, and open questions. Keep shared terminology consistent.'
      : 'Implement the requested code change with relevant tests and runtime verification.';
  return [`# Verified ${document.mode.appliedMode} run: ${document.title}`, document.summary, `Objective: ${document.objective || '(not specified)'}`, `Audience: ${document.audience || '(not specified)'}`, `Workspace: ${workspace}`, `Write only: ${document.writeScope.join(', ')}`, `Read context: ${document.readScope.join(', ') || '(none)'}`, `Shared interfaces: ${document.interfaces.join(', ') || '(none)'}`, `Terms: ${contracts.terms.join(', ') || '(none)'}`, `Assumptions: ${contracts.assumptions.join(', ') || '(none)'}`, `Required claims: ${contracts.requiredClaims.join(', ') || '(none)'}`, `Open questions: ${contracts.openQuestions.join(', ') || '(none)'}`, '', '# Mode instruction', modeInstruction, '', '# Required rules', ...rules, '', 'Do not edit outside Write only. Run relevant checks, but do not commit or merge; the orchestrator handles verification and landing.'].join('\n');
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

function buildRetryPrompt(task, rules, workspace, verifyResult, attempt, maxAttempts) {
  const lines = [buildDispatchPrompt(task, rules, workspace)];
  lines.push('', '# Previous verification failed');
  lines.push(`This is repair attempt ${attempt} of ${maxAttempts}. Fix the cause, then stop.`);
  if (verifyResult?.task?.verification) {
    lines.push('', '## Verification evidence');
    lines.push(JSON.stringify(compactVerificationForPrompt(verifyResult.task.verification), null, 2));
  }
  const cases = verifyResult?.failureCases || [];
  if (cases.length) {
    lines.push('', '## Failure cases');
    for (const failure of cases) {
      lines.push(`- ${failure.id}: ${failure.kind} / ${failure.title}`);
    }
  }
  return lines.join('\n');
}

function compactVerificationForPrompt(verification) {
  return {
    status: verification.status,
    passed: verification.passed,
    finishedAt: verification.finishedAt,
    checks: (verification.checks || []).map((check) => ({
      file: check.file,
      args: check.args,
      cwd: check.cwd,
      expectedExit: check.expectedExit,
      actualExit: check.actualExit,
      timedOut: check.timedOut,
      spawnError: check.spawnError,
      passed: check.passed,
      stdoutTail: String(check.stdoutTail || '').slice(-1200),
      stderrTail: String(check.stderrTail || '').slice(-1200),
    })),
    scope: verification.scope,
  };
}

function runExecutor(tool, prompt, { workspace, model, permission, sandbox, inherit }) {
  return new Promise((resolve, reject) => {
    const normalized = String(tool || 'claude-code');
    let exe;
    let args;
    if (normalized === 'claude-code') {
      args = ['-p', '--permission-mode', permission || 'acceptEdits'];
      if (model) args.push('--model', model);
      exe = process.env.TEAM_LOOP_CLAUDE_BIN || 'claude';
    } else if (normalized === 'codex') {
      args = ['exec', '-C', workspace, '--sandbox', sandbox || 'workspace-write'];
      if (model) args.push('--model', model);
      args.push('-');
      exe = process.env.TEAM_LOOP_CODEX_BIN || (process.platform === 'win32' ? 'codex.cmd' : 'codex');
    } else if (normalized === 'custom') {
      exe = process.env.TEAM_LOOP_CUSTOM_EXECUTOR_BIN;
      if (!exe) {
        reject(new Error('TEAM_LOOP_CUSTOM_EXECUTOR_BIN is required for custom executor.'));
        return;
      }
      args = customExecutorArgs();
    } else {
      reject(new Error(`Executor "${tool}" is not supported. Use claude-code, codex, or custom.`));
      return;
    }
    // Deliver the prompt on STDIN, never as a CLI argument: long multi-line
    // work orders are fragile as command-line arguments on Windows shells.
    const command = windowsCommand(exe, args);
    const child = spawn(command.exe, command.args, {
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

function windowsCommand(exe, args) {
  if (process.platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(String(exe))) return { exe, args };
  return { exe: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', exe, ...args] };
}

function customExecutorArgs() {
  const raw = process.env.TEAM_LOOP_CUSTOM_EXECUTOR_ARGS || '[]';
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item));
  } catch {
    // Fall through to the safer empty argument list.
  }
  return [];
}

function executorPreview(tool, model, { workspace, permission, sandbox }) {
  if (tool === 'codex') {
    return `codex exec -C ${workspace} --sandbox ${sandbox || 'workspace-write'}${model ? ` --model ${model}` : ''} - <prompt>`;
  }
  if (tool === 'custom') return `${process.env.TEAM_LOOP_CUSTOM_EXECUTOR_BIN || 'custom-executor'} <prompt>`;
  return `claude -p <prompt> --permission-mode ${permission || 'acceptEdits'}${model ? ` --model ${model}` : ''}`;
}

async function autoLearnFromFailures(client, taskId, failureCases, { json }) {
  const failureCaseIds = (failureCases || []).map((failure) => failure.id).filter(Boolean);
  if (!failureCaseIds.length) return null;
  try {
    const crafted = await client.request('/api/learning/auto-craft', {
      method: 'POST',
      body: { taskId, failureCaseIds },
    });
    if (crafted.type === 'SKILL' && crafted.skill?.id) {
      const current = await client.request(`/api/skills/${encodeURIComponent(crafted.skill.id)}`);
      const activated = await client.request(`/api/skills/${encodeURIComponent(crafted.skill.id)}/activate`, {
        method: 'POST',
        body: { expectedVersion: current.skill.version },
      });
      const task = findTask((await client.request('/api/bootstrap')).tasks, taskId);
      await client.request(`/api/tasks/${encodeURIComponent(task.id)}/apply-learning`, {
        method: 'POST',
        body: { expectedVersion: task.version, skillIds: [activated.skill.id] },
      });
      if (!json) process.stdout.write(`Auto-learned skill ${activated.skill.id} and applied it to ${task.id}.\n`);
      return { type: 'SKILL', id: activated.skill.id, status: 'ACTIVE_APPLIED', sourceFailureCaseIds: failureCaseIds };
    }
    if (crafted.type === 'HARNESS' && crafted.harness?.id) {
      if (!json) process.stdout.write(`Auto-learned draft harness ${crafted.harness.id}; it will be tested after the task passes.\n`);
      return { type: 'HARNESS', id: crafted.harness.id, status: 'DRAFT', sourceFailureCaseIds: failureCaseIds };
    }
  } catch (error) {
    if (!json) process.stdout.write(`Auto-learning skipped: ${error.message}\n`);
  }
  return null;
}

async function activatePassingHarnesses(client, taskId, learnedArtifacts, { json }) {
  for (const artifact of learnedArtifacts) {
    if (artifact.type !== 'HARNESS' || artifact.status !== 'DRAFT') continue;
    try {
      const test = await client.request(`/api/harnesses/${encodeURIComponent(artifact.id)}/test`, {
        method: 'POST',
        body: {},
      });
      if (!test.test?.passed) {
        if (!json) process.stdout.write(`Auto-learned harness ${artifact.id} did not pass its own test; leaving it as draft.\n`);
        artifact.status = 'DRAFT_TEST_FAILED';
        continue;
      }
      const activated = await client.request(`/api/harnesses/${encodeURIComponent(artifact.id)}/activate`, {
        method: 'POST',
        body: { expectedVersion: test.harness.version },
      });
      artifact.status = 'ACTIVE';
      const task = findTask((await client.request('/api/bootstrap')).tasks, taskId);
      await client.request(`/api/tasks/${encodeURIComponent(task.id)}/apply-learning`, {
        method: 'POST',
        body: { expectedVersion: task.version, harnessId: activated.harness.id },
      });
      const applied = findTask((await client.request('/api/bootstrap')).tasks, taskId);
      const verifyResult = await client.request(`/api/tasks/${encodeURIComponent(applied.id)}/verify`, {
        method: 'POST',
        body: { expectedVersion: applied.version },
      });
      artifact.status = verifyResult.task.verification?.passed ? 'ACTIVE_APPLIED' : 'ACTIVE_APPLIED_VERIFY_FAILED';
      if (!json) process.stdout.write(`Auto-learned harness ${artifact.id} activated, applied, and re-verified.\n`);
      return { reverified: true, verifyResult };
    } catch (error) {
      artifact.status = 'ACTIVATION_SKIPPED';
      artifact.error = error.message;
      if (!json) process.stdout.write(`Auto-learned harness ${artifact.id} activation skipped: ${error.message}\n`);
    }
  }
  return { reverified: false, verifyResult: null };
}

async function reportTaskActivity(client, task, activity) {
  const result = await client.request(`/api/tasks/${encodeURIComponent(task.id)}/activity`, {
    method: 'POST',
    body: {
      activity: {
        startedAt: task.agentActivity?.startedAt,
        ...activity,
      },
    },
  });
  return result.task;
}

// Dispatch: hand an existing board task to a CLI executor that actually does the work,
// then verify. Dry-run by default; --execute really runs the agent in WORKSPACE_ROOT.
async function runWorktree(client, positionals, options, json) {
  const action = positionals[0] || 'list';
  const bootstrap = await client.request('/api/bootstrap');
  const repoRoot = bootstrap.workspace?.root || process.cwd();
  if (action === 'list') { printValue(await listTaskWorktrees(repoRoot), { json: true }); return 0; }
  const taskId = requirePositional(positionals, 1, 'Task ID is required.');
  if (action === 'create') { printValue(await createTaskWorktree(repoRoot, taskId, { base: stringOption(options, 'base', 'HEAD') }), { json: true }); return 0; }
  if (action === 'remove') { printValue(await removeTaskWorktree(repoRoot, taskId), { json: true }); return 0; }
  throw new Error('Worktree action must be create, remove, or list.');
}

async function runDispatch(client, positionals, options, json) {
  const taskId = requirePositional(positionals, 0, 'Task ID is required.');
  const bootstrap = await client.request('/api/bootstrap');
  let task = findTask(bootstrap.tasks, taskId);
  if (!task) throw new Error(`Task ${taskId} not found.`);
  let workspace = bootstrap.workspace?.root || process.cwd();

  if (task.status === 'READY') {
    const executor = mergeCliExecutor(await loadConfig());
    task = (await client.request(`/api/tasks/${encodeURIComponent(task.id)}/claim`, {
      method: 'POST', body: { expectedVersion: task.version, ...(executor ? { executor } : {}) },
    })).task;
  }
  if (task.status !== 'IN_PROGRESS') throw new Error(`Task must be IN_PROGRESS to dispatch (now ${task.status}).`);

  let worktree = null;
  if (options.execute && options.isolate) {
    worktree = await createTaskWorktree(bootstrap.workspace?.root || process.cwd(), task.id);
    workspace = worktree.dir;
    if (!json) process.stdout.write(`Isolated worktree: ${worktree.dir} (branch ${worktree.branch})\n`);
  }
  const activeSkills = (await client.request('/api/skills')).skills
    .filter((skill) => skill.status === 'ACTIVE' && (task.skillIds || []).includes(skill.id));
  const rules = activeSkills.flatMap((skill) => skill.rules || []);
  const tool = stringOption(options, 'executor', task.executor?.tool || 'claude-code');
  const model = stringOption(options, 'model', task.executor?.model || '');
  const permission = stringOption(options, 'permission', 'acceptEdits');
  const sandbox = stringOption(options, 'sandbox', 'workspace-write');
  const dangerousPermission = ['bypassPermissions', 'dangerously-skip-permissions'].includes(permission);
  const dangerousSandbox = ['danger-full-access'].includes(sandbox);
  if (options.execute && (dangerousPermission || dangerousSandbox) && !options.trust) {
    throw new Error(`Refusing to run the agent with ${dangerousPermission ? `permission "${permission}"` : `sandbox "${sandbox}"`} and no safeguards. Pass --trust to confirm you trust this task, or use a safer mode.`);
  }
  const maxAttempts = Math.max(1, Math.min(10, numberOption(options, 'retry', 1)));
  const autoLearn = Boolean(options['auto-learn']);
  const prompt = buildDispatchPrompt(task, rules, workspace);

  if (!options.execute) {
    const plan = {
      dryRun: true, taskId: task.id, status: task.status, executor: tool, model: model || null,
      workspace, allowedPaths: task.allowedPaths, skillRules: rules, prompt,
      wouldRun: executorPreview(tool, model, { workspace, permission, sandbox }),
    };
    printValue(plan, { json: true });
    if (!json) process.stdout.write('\n[dry-run] Re-run with --execute to actually run the agent in the workspace.\n');
    return 0;
  }

  let run = null;
  let verifyResult = null;
  let passed = false;
  const attempts = [];
  const learnedArtifacts = [];
  task = await reportTaskActivity(client, task, {
    phase: 'dispatch-started',
    label: 'CLI 작업 시작',
    detail: `${tool} executor가 작업 지시서를 받고 있습니다.`,
    tool,
    model,
    workspace,
    worktreeBranch: worktree?.branch || '',
    attempt: 0,
    maxAttempts,
  });
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptPrompt = attempt === 1 ? prompt : buildRetryPrompt(task, rules, workspace, verifyResult, attempt, maxAttempts);
    if (!json) process.stdout.write(`Dispatching ${task.id} to ${tool} in ${workspace} (attempt ${attempt}/${maxAttempts}) ...\n`);
    task = await reportTaskActivity(client, task, {
      phase: 'executor-running',
      label: 'AI/CLI 작업 중',
      detail: `${tool} 실행 중 · 시도 ${attempt}/${maxAttempts}`,
      tool,
      model,
      workspace,
      worktreeBranch: worktree?.branch || '',
      attempt,
      maxAttempts,
    });
    run = await runExecutor(tool, attemptPrompt, {
      workspace, model, permission, sandbox, inherit: !json,
    });
    if (!json) process.stdout.write(`Executor exited with code ${run.code}. Verifying ...\n`);
    task = await reportTaskActivity(client, task, {
      phase: 'verifying',
      label: '검증 중',
      detail: `executor exit ${run.code}; 프로그램 검증 실행 중`,
      tool,
      model,
      workspace,
      worktreeBranch: worktree?.branch || '',
      attempt,
      maxAttempts,
      exitCode: run.code,
    });
    verifyResult = await client.request(`/api/tasks/${encodeURIComponent(task.id)}/verify`, { method: 'POST', body: { expectedVersion: task.version } });
    task = verifyResult.task;
    passed = Boolean(task.verification?.passed);
    attempts.push({
      attempt,
      executorExit: run.code,
      verification: task.verification?.status,
      passed,
      failureCaseIds: (verifyResult.failureCases || []).map((failure) => failure.id),
    });
    if (passed) break;
    if (autoLearn && verifyResult.failureCases?.length) {
      task = await reportTaskActivity(client, task, {
        phase: 'auto-learning',
        label: '실패 학습 중',
        detail: '검증 실패 사례로 하네스/스킬 후보를 만들고 있습니다.',
        tool,
        model,
        workspace,
        worktreeBranch: worktree?.branch || '',
        attempt,
        maxAttempts,
        exitCode: run.code,
        passed,
        failureCaseIds: (verifyResult.failureCases || []).map((failure) => failure.id),
      });
      const learned = await autoLearnFromFailures(client, task.id, verifyResult.failureCases, { json });
      if (learned) learnedArtifacts.push(learned);
      const refreshed = findTask((await client.request('/api/bootstrap')).tasks, task.id);
      if (refreshed) task = refreshed;
    }
    task = await reportTaskActivity(client, task, {
      phase: attempt < maxAttempts ? 'repair-needed' : 'failed',
      label: attempt < maxAttempts ? '수정 재시도 대기' : '검증 실패',
      detail: attempt < maxAttempts ? '검증 실패 증거를 다시 executor에게 넘길 예정입니다.' : '재시도 한도 안에서 검증을 통과하지 못했습니다.',
      tool,
      model,
      workspace,
      worktreeBranch: worktree?.branch || '',
      attempt,
      maxAttempts,
      exitCode: run.code,
      passed,
      failureCaseIds: (verifyResult.failureCases || []).map((failure) => failure.id),
      learnedArtifacts,
    });
    if (!json && attempt < maxAttempts) {
      process.stdout.write(`Verification failed; handing the failure evidence back to ${tool} for repair.\n`);
    }
  }
  if (passed && autoLearn && learnedArtifacts.some((item) => item.type === 'HARNESS' && item.status === 'DRAFT')) {
    task = await reportTaskActivity(client, task, {
      phase: 'activating-harness',
      label: '하네스 활성화 중',
      detail: '통과 후 DRAFT 하네스를 시험하고 작업에 적용합니다.',
      tool,
      model,
      workspace,
      worktreeBranch: worktree?.branch || '',
      maxAttempts,
      passed,
      learnedArtifacts,
    });
    const activation = await activatePassingHarnesses(client, task.id, learnedArtifacts, { json });
    if (activation.reverified) {
      verifyResult = activation.verifyResult;
      task = verifyResult.task;
      passed = Boolean(task.verification?.passed);
      attempts.push({
        attempt: 'auto-learn-harness',
        executorExit: null,
        verification: task.verification?.status,
        passed,
        failureCaseIds: (verifyResult.failureCases || []).map((failure) => failure.id),
      });
    }
  }

  let review = null;
  const to = stringOption(options, 'to', 'verify');
  if (passed && (to === 'review' || to === 'done')) {
    task = await reportTaskActivity(client, task, {
      phase: 'requesting-review',
      label: '리뷰 요청 중',
      detail: '검증 통과 후 리뷰 단계로 넘기고 있습니다.',
      tool,
      model,
      workspace,
      worktreeBranch: worktree?.branch || '',
      maxAttempts,
      passed,
      learnedArtifacts,
    });
    task = (await client.request(`/api/tasks/${encodeURIComponent(task.id)}/request-review`, { method: 'POST', body: { expectedVersion: task.version } })).task;
    if (to === 'done') {
      const reviewerSession = await loadSessionFrom(stringOption(options, 'reviewer-home', botHome()));
      if (!reviewerSession?.cookie) throw new Error('No reviewer session; set up the reviewer bot or use --to review.');
      const reviewerClient = new CliClient({ server: client.server, cookie: reviewerSession.cookie });
      review = await reviewOneTask(reviewerClient, task.id, 'Auto-approved after dispatch (verification green).', 'Auto-rejected after dispatch: re-verification required.');
    }
  }

  const final = findTask((await client.request('/api/bootstrap')).tasks, task.id);
  await reportTaskActivity(client, final, {
    phase: passed ? 'finished' : 'failed',
    label: passed ? '작업 루프 완료' : '작업 루프 실패',
    detail: passed ? `검증 통과 · 현재 상태 ${final.status}` : '검증을 통과하지 못했습니다.',
    tool,
    model,
    workspace,
    worktreeBranch: worktree?.branch || '',
    maxAttempts,
    exitCode: run?.code,
    passed,
    failureCaseIds: (verifyResult?.failureCases || []).map((failure) => failure.id),
    learnedArtifacts,
    finished: true,
  });
  const summary = { taskId: task.id, attempts, learnedArtifacts, executorExit: run?.code, verification: final.verification?.status, passed, finalStatus: final.status, review };
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
  if (action === 'delete') {
    await client.request(`/api/tasks/${encodeURIComponent(task.id)}/delete`, { method: 'POST', body: { expectedVersion: task.version } });
    printValue(`Deleted ${task.id}.`, { json });
    return 0;
  }
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
  } else if (!['claim', 'verify', 'request-review', 'unblock', 'archive', 'unarchive', 'delete'].includes(action)) {
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
  if (['test', 'activate', 'disable', 'archive'].includes(action)) {
    const id = requirePositional(positionals, 1, 'Harness ID is required.');
    const current = await client.request(`/api/harnesses/${encodeURIComponent(id)}`);
    const result = await client.request(`/api/harnesses/${encodeURIComponent(id)}/${action}`, {
      method: 'POST', body: { expectedVersion: current.harness.version },
    });
    printValue(result, { json: true });
    if (action === 'test' && !result.test.passed) return 2;
    return 0;
  }
  throw new Error('Harness action must be list, show, create, update, test, activate, disable, or archive.');
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
  if (action === 'activate' || action === 'disable' || action === 'archive') {
    const current = await client.request(`/api/skills/${encodeURIComponent(id)}`);
    const result = await client.request(`/api/skills/${encodeURIComponent(id)}/${action}`, {
      method: 'POST', body: { expectedVersion: current.skill.version },
    });
    printValue(result.skill, { json: true });
    return 0;
  }
  throw new Error('Skill action must be list, show, activate, disable, or archive.');
}

async function runLearning(client, positionals, options, json) {
  const action = positionals[0];
  if (action === 'audit') {
    const result = await client.request('/api/learning/audit');
    if (json) printValue(result, { json: true });
    else printLearningAudit(result.audit);
    return 0;
  }
  if (action === 'apply-cleanup') {
    const result = await client.request('/api/learning/audit/apply-cleanup', { method: 'POST', body: {} });
    if (json) printValue(result, { json: true });
    else {
      printValue(`Applied ${result.applied.length} cleanup action(s).`);
      printLearningAudit(result.audit);
    }
    return 0;
  }
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
  throw new Error('Learning action must be audit, apply-cleanup, craft, or apply.');
}

function printLearningAudit(audit) {
  const rows = [...(audit.harnesses || []), ...(audit.skills || [])];
  printValue(`Learning audit: keep ${audit.summary.keep}, conditional ${audit.summary.conditional}, cleanup ${audit.summary.cleanup}, archive actions ${audit.summary.archiveActions || 0}`);
  for (const item of rows.filter((row) => row.category !== 'KEEP')) {
    printValue(`- ${item.category} ${item.type} ${item.id}: ${item.action} (${item.reasons[0]})`);
  }
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
  process.stdout.write(`Project loop (recommended):
  team-loop init [--workspace /path/to/project]
  team-loop work "goal" [--execute] [--executor codex|claude-code|custom]
  team-loop run land <run-id>  (approve and merge verified work)
  Passing work waits for explicit land.

`);
  process.stdout.write(`Team Loop Lite + AI CLI\n\nUsage:\n  team-loop [--server URL] [--json] <command>\n\nServer:\n  team-loop serve --workspace /path/to/game [--port 4173]\n  team-loop health\n\nAuthentication:\n  team-loop register --name Alice [--signup-code CODE]\n  team-loop login --name Alice\n  team-loop logout\n  team-loop whoami\n\nTeam and tasks:\n  team-loop users\n  team-loop tasks [--status REVIEW] [--mine] [--archived] [--all]\n  team-loop task show <task-id>\n  team-loop task create --title TEXT [--description TEXT] [--priority 100]\n      [--allowed-path PATH ...] [--criterion TEXT ...] [--profile PROFILE]\n      [--assignee NAME_OR_ID] [--reviewer NAME_OR_ID]\n  team-loop task claim <task-id>\n  team-loop task verify <task-id>\n  team-loop task request-review <task-id>\n  team-loop task approve <task-id> [--comment TEXT]\n  team-loop task reject <task-id> [--comment TEXT]\n  team-loop task block <task-id> --reason TEXT\n  team-loop task unblock <task-id>\n  team-loop task archive <task-id>\n  team-loop task unarchive <task-id>\n  team-loop task delete <task-id>\n  team-loop worktree create|remove|list <task-id>   (per-task isolated git worktree)\n\nHarnesses and failures:\n  team-loop harness list\n  team-loop harness show <id>\n  team-loop harness create --id ID --label TEXT --file COMMAND [--arg ARG ...]\n      [--cwd .] [--expected-exit 0] [--timeout-ms 120000]\n  team-loop harness create --definition harness.json\n  team-loop harness update <id> --definition harness.json\n  team-loop harness test <id>\n  team-loop harness activate <id>\n  team-loop harness disable <id>\n  team-loop skill list\n  team-loop skill show|activate|disable <id>\n  team-loop learning craft --type HARNESS|SKILL --id ID --failure CASE_ID [--failure CASE_ID ...]\n      [--label TEXT] [--description TEXT] [--rule TEXT ...]\n  team-loop learning apply <task-id> [--harness ID] [--skill ID ...]\n  team-loop failures [--status OPEN] [--harness ID]\n  team-loop failure show <id>\n  team-loop failure promote <id>\n  team-loop failure craft <id> --type HARNESS|SKILL --id ID [--failure CASE_ID ...]\n  team-loop failure resolve|ignore|reopen <id> [--note TEXT]\n\nAI advisor:\n  team-loop ai draft-task --goal TEXT\n  team-loop ai next-tasks --objective TEXT\n  team-loop ai brief <task-id>\n  team-loop ai verification-summary <task-id>\n\nExternal usage:\n  team-loop usage status [--days 30]\n  team-loop usage push [--daemon --interval 300]\n  team-loop usage receiver [--host 127.0.0.1 --port 4318]\n  claude-statusline-command | team-loop usage capture-claude-statusline [--quiet]\n\nDispatch (hand a task to a CLI agent that does the work):\n  team-loop dispatch <task-id> [--executor claude-code|codex|custom]\n      [--execute] [--isolate] [--model NAME] [--permission MODE] [--sandbox workspace-write]\n      [--to verify|review|done] [--reviewer-home DIR]\n  (default is a dry-run that prints the work order; --execute runs the agent\n   headless in WORKSPACE_ROOT, then verifies. claude-code and codex are supported.)\n\nOrchestrate (full loop: worker + reviewer bot):\n  team-loop orchestrate run --goal "TEXT" [--reviewer-home DIR]\n      [--title T] [--allowed-path P ...] [--criterion C ...] [--profile HARNESS]\n  (worker: create->claim->verify->request-review; reviewer bot then approves to DONE)\n\nReviewer bot (auto-review from a separate account):\n  team-loop reviewer run [--once | --interval SECONDS]\n      [--comment TEXT] [--reject-comment TEXT]\n  (approves REVIEW tasks when verification is green and workspace is unchanged,\n   otherwise rejects for re-verification; log in as a non-assignee account)\n\nSolo mode (single-person loop):\n  team-loop solo run --goal "TEXT" [--title T] [--allowed-path P ...]\n      [--criterion C ...] [--profile HARNESS] [--comment TEXT]\n  (create -> claim -> verify -> self-approve to DONE; server needs SOLO_MODE=true)\n\nPersonal CLI profile:\n  team-loop config show\n  team-loop config set [--tool claude-code|codex|custom] [--model NAME]\n      [--default-harness ID] [--default-skill ID ...]\n  team-loop config clear\n  (task claim attaches this profile; the server records it on the task)\n\nEnvironment:\n  TEAM_LOOP_URL                 default server URL\n  TEAM_LOOP_PASSWORD            password for login/register\n  TEAM_LOOP_CLI_HOME            session storage directory\n  TEAM_LOOP_SESSION_COOKIE      non-persistent session for automation\n  TEAM_LOOP_CLI_TIMEOUT_MS      request timeout (default 300000)\n  TEAM_LOOP_CODEX_BIN           Codex executable override, defaults to codex.cmd on Windows\n  TEAM_LOOP_CLAUDE_BIN          Claude executable override, defaults to claude\n  TEAM_LOOP_CUSTOM_EXECUTOR_BIN Custom executor that reads the work order from stdin\n\nPasswords are prompted without echo when --password and TEAM_LOOP_PASSWORD are absent.\n`);
}
