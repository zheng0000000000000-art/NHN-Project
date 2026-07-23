#!/usr/bin/env node
// Team Loop MCP server (pure Node, zero dependencies).
//
// Exposes the team-loop coordination surface as MCP tools over stdio (JSON-RPC 2.0,
// newline-delimited). The point is AI-first: an agent claims/verifies/reviews tasks
// through these tools instead of editing files freely, so the claim-time scope lock,
// per-task worktree isolation, and the verifier's scope gate all engage automatically.
//
// Auth reuses the CLI session: run `team-loop login` first (or set TEAM_LOOP_URL +
// TEAM_LOOP_SESSION_COOKIE). Only JSON-RPC goes to stdout; logs go to stderr.

import readline from 'node:readline';
import { CliClient } from '../src/cli/client.js';
import { loadSession, normalizeServer } from '../src/cli/session.js';
import { taskListView } from '../src/mcp-task-view.js';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'team-loop', version: '0.7.0' };

function log(...args) { console.error('[team-loop-mcp]', ...args); }
function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function makeClient() {
  const saved = await loadSession();
  const server = normalizeServer(process.env.TEAM_LOOP_URL || saved?.server || 'http://localhost:4173');
  const cookie = process.env.TEAM_LOOP_SESSION_COOKIE || (saved?.server === server ? saved?.cookie || '' : '');
  if (!cookie) throw new Error('Not logged in. Run `team-loop login --name <you>` or set TEAM_LOOP_SESSION_COOKIE.');
  return new CliClient({ server, cookie });
}

async function fetchTask(client, taskId) {
  const bootstrap = await client.request('/api/bootstrap');
  const task = (bootstrap.tasks || []).find((item) => item.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found.`);
  return task;
}

// --- Tools: name -> { description, inputSchema, run(client, args) } ---
const TOOLS = {
  balance_run: {
    description: 'Evaluate or deterministically tune a combat balance baseline. Returns an immutable observation set and a candidate; it never applies the candidate.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['evaluate', 'tune'] },
        provider: { type: 'string', enum: ['combat-v1'] },
        spec: { type: 'object' },
        baseline: { type: 'object' },
        seed: { type: 'number' },
        runs: { type: 'number' },
        maxCandidates: { type: 'number' },
      },
      required: ['spec', 'baseline'],
    },
    async run(client, args) {
      return client.request('/api/balance/run', { method: 'POST', body: args });
    },
  },
  experience_contracts: {
    description: 'Read the versioned contracts for context packs, skill manifests, harnesses, gates, and knowledge promotion before producing durable experience artifacts.',
    inputSchema: { type: 'object', properties: {} },
    async run(client) {
      return client.request('/api/contracts');
    },
  },
  experience_prepare: {
    description: 'Primary start-of-work tool. Build an evidence-backed experience pack from wiki knowledge, project sources, relevant failures, skills, and a verification harness.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        description: { type: 'string' },
        allowedPaths: { type: 'array', items: { type: 'string' } },
        acceptanceCriteria: { type: 'array', items: { type: 'string' } },
        maxWikiEntries: { type: 'number' },
        maxSourceChunks: { type: 'number' },
      },
      required: ['goal'],
    },
    async run(client, args) {
      return client.request('/api/experience/prepare', { method: 'POST', body: args });
    },
  },
  experience_reflect: {
    description: 'Primary end-of-work tool. Record the outcome and create reviewable wiki and learning candidates so future agents can reuse verified experience.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        outcome: { type: 'string' },
        verdict: { type: 'string', enum: ['PASSED', 'FAILED', 'PARTIAL', 'UNKNOWN'] },
        taskId: { type: 'string' },
        usedSkillIds: { type: 'array', items: { type: 'string' } },
        usedHarnessIds: { type: 'array', items: { type: 'string' } },
        failureCaseIds: { type: 'array', items: { type: 'string' } },
        discoveries: { type: 'array', items: { type: 'string' } },
        nextActions: { type: 'array', items: { type: 'string' } },
      },
      required: ['goal', 'outcome', 'verdict'],
    },
    async run(client, args) {
      return client.request('/api/experience/reflect', { method: 'POST', body: args });
    },
  },
  wiki_search: {
    description: 'Recall durable project knowledge. Active entries are returned by default; candidates can be included for review.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        includeCandidates: { type: 'boolean' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
    async run(client, args) {
      const query = new URLSearchParams({ q: String(args.query), limit: String(args.limit || 8) });
      if (args.includeCandidates) query.set('candidates', 'true');
      return client.request(`/api/wiki?${query}`);
    },
  },
  wiki_propose: {
    description: 'Propose durable knowledge discovered during work. Proposals remain candidates until explicitly promoted.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        evidence: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'content'],
    },
    async run(client, args) {
      return client.request('/api/wiki/propose', { method: 'POST', body: args });
    },
  },
  list_tasks: {
    description: 'List board tasks. Defaults to a compact id/title/status view; use detail="work" only when scope and ownership fields are needed.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string' }, mine: { type: 'boolean' }, agentQueue: { type: 'boolean' }, includeArchived: { type: 'boolean' },
        detail: { type: 'string', enum: ['brief', 'work'], default: 'brief' },
      },
    },
    async run(client, args) {
      const b = await client.request('/api/bootstrap');
      let tasks = b.tasks || [];
      if (!args.includeArchived) tasks = tasks.filter((t) => !t.archived);
      if (args.status) tasks = tasks.filter((t) => t.status === String(args.status).toUpperCase());
      if (args.mine) tasks = tasks.filter((t) => [t.creatorUserId, t.assigneeUserId, t.reviewerUserId].includes(b.user.id));
      if (args.agentQueue) tasks = tasks.filter((t) => t.status === 'READY' && t.executionMode === 'AGENT' && t.executionState === 'QUEUED' && t.assigneeUserId === b.user.id);
      return tasks.map((task) => taskListView(task, args.detail));
    },
  },
  show_task: {
    description: 'Show one task in full (status, allowedPaths, acceptance criteria, verification, review, executor, skillIds).',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
    async run(client, args) { return fetchTask(client, args.taskId); },
  },
  create_task: {
    description: 'Create a scoped task. allowedPaths defines the ONLY files it may change (use glob like "src/cli/**").',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' }, description: { type: 'string' },
        allowedPaths: { type: 'array', items: { type: 'string' } },
        acceptanceCriteria: { type: 'array', items: { type: 'string' } },
        verificationProfile: { type: 'string' }, priority: { type: 'number' },
        supersedesTaskId: { type: 'string', description: 'Original task replaced by this reissued task.' },
      },
      required: ['title'],
    },
    async run(client, args) {
      const body = {
        title: args.title, description: args.description || '', priority: args.priority || 100,
        allowedPaths: Array.isArray(args.allowedPaths) && args.allowedPaths.length ? args.allowedPaths : ['**'],
        acceptanceCriteria: Array.isArray(args.acceptanceCriteria) ? args.acceptanceCriteria : [],
        verificationProfile: args.verificationProfile || 'repository-basic',
        supersedesTaskId: args.supersedesTaskId || null,
      };
      return (await client.request('/api/tasks', { method: 'POST', body })).task;
    },
  },
  claim_task: {
    description: 'Claim one of the current owner’s queued agent tasks. The human assignee remains responsible while the board shows only agent execution state.',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
    async run(client, args) {
      const task = await fetchTask(client, args.taskId);
      return (await client.request(`/api/tasks/${encodeURIComponent(task.id)}/claim`, { method: 'POST', body: { expectedVersion: task.version, executionMode: 'AGENT' } })).task;
    },
  },
  verify_task: {
    description: 'Run program verification (harness + scope check) on a task. The program decides pass/fail, not the agent.',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
    async run(client, args) {
      const task = await fetchTask(client, args.taskId);
      const r = await client.request(`/api/tasks/${encodeURIComponent(task.id)}/verify`, { method: 'POST', body: { expectedVersion: task.version } });
      return { status: r.task.verification?.status, passed: Boolean(r.task.verification?.passed), failureCaseIds: (r.failureCases || []).map((f) => f.id) };
    },
  },
  request_review_task: {
    description: 'Move a passing task to REVIEW so a separate reviewer (human or bot) can approve it.',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
    async run(client, args) {
      const task = await fetchTask(client, args.taskId);
      return (await client.request(`/api/tasks/${encodeURIComponent(task.id)}/request-review`, { method: 'POST', body: { expectedVersion: task.version } })).task;
    },
  },
  read_task_files: {
    description: 'Read scoped UTF-8 project files for a claimed task. Returns the server baseCommit required for submission. Server paths are never exposed.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' }, paths: { type: 'array', items: { type: 'string' }, maxItems: 50 } },
      required: ['taskId', 'paths'],
    },
    async run(client, args) {
      return client.request(`/api/tasks/${encodeURIComponent(args.taskId)}/files`, { method: 'POST', body: { paths: args.paths } });
    },
  },
  submit_task_result: {
    description: 'Submit scoped UTF-8 file results to the server. The server applies them only inside its task worktree; call verify_task afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' }, baseCommit: { type: 'string' }, summary: { type: 'string' }, learningDisposition: { type: 'string' },
        files: { type: 'array', maxItems: 50, items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, deleted: { type: 'boolean' } }, required: ['path'] } },
      },
      required: ['taskId', 'baseCommit', 'summary', 'learningDisposition', 'files'],
    },
    async run(client, args) {
      const task = await fetchTask(client, args.taskId);
      return client.request(`/api/tasks/${encodeURIComponent(task.id)}/submit`, { method: 'POST', body: { expectedVersion: task.version, baseCommit: args.baseCommit, summary: args.summary, learningDisposition: args.learningDisposition, files: args.files } });
    },
  },
  list_skills: {
    description: 'List shared skills (failure-derived rules) available to all agents.',
    inputSchema: { type: 'object', properties: {} },
    async run(client) { return (await client.request('/api/skills')).skills.map((s) => ({ id: s.id, status: s.status, label: s.label, rules: s.rules, manifest: s.manifest })); },
  },
  list_harnesses: {
    description: 'List shared verification harnesses.',
    inputSchema: { type: 'object', properties: {} },
    async run(client) { return (await client.request('/api/harnesses')).harnesses.map((h) => ({ id: h.id, status: h.status, source: h.source, commands: h.commands?.length ?? 0 })); },
  },
  get_project_context: {
    description: 'Read the shared project context pack (goals, rules) that all agents see.',
    inputSchema: { type: 'object', properties: {} },
    async run(client) { return (await client.request('/api/project-context')).projectContext; },
  },
  set_project_context: {
    description: 'Replace the shared project context pack (max ~12000 chars). Visible to every agent.',
    inputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
    async run(client, args) { return (await client.request('/api/project-context', { method: 'PUT', body: { content: String(args.content ?? '') } })).projectContext; },
  },
};

function toolList() {
  return Object.entries(TOOLS).map(([name, def]) => ({ name, description: def.description, inputSchema: def.inputSchema }));
}

async function handleToolCall(params) {
  const def = TOOLS[params?.name];
  if (!def) return { content: [{ type: 'text', text: `Unknown tool: ${params?.name}` }], isError: true };
  try {
    const client = await makeClient();
    const result = await def.run(client, params.arguments || {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
  }
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  if (method === undefined) return; // response/ack, ignore
  if (method === 'initialize') {
    reply(id, { protocolVersion: params?.protocolVersion || PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return; // notification
  if (method === 'ping') { reply(id, {}); return; }
  if (method === 'tools/list') { reply(id, { tools: toolList() }); return; }
  if (method === 'tools/call') { reply(id, await handleToolCall(params)); return; }
  if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
}

function main() {
  log(`ready; ${Object.keys(TOOLS).length} tools; server=${process.env.TEAM_LOOP_URL || 'saved session'}`);
  const rl = readline.createInterface({ input: process.stdin });
  let closed = false;
  let pending = 0;
  const maybeExit = () => { if (closed && pending === 0) process.exit(0); };
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { log('bad JSON line ignored'); return; }
    pending += 1;
    Promise.resolve(handleMessage(msg))
      .catch((error) => {
        log('handler error', error.message);
        if (msg && msg.id !== undefined) replyError(msg.id, -32603, `Internal error: ${error.message}`);
      })
      .finally(() => { pending -= 1; maybeExit(); });
  });
  rl.on('close', () => { closed = true; maybeExit(); });
}

main();
