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
import { compileConstitutionInMemory } from '../src/constitution.js';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'team-loop', version: '0.7.0' };
const constitutionPromise = compileConstitutionInMemory(new URL('../docs/AGENT-CONSTITUTION.md', import.meta.url));

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
  constitution_status: {
    description: 'Inspect the compiled top-level agent constitution and its probation observations, decision distribution, blocked outcomes, and entry-latency budget.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    async run(client, args) {
      const [constitution, audit] = await Promise.all([
        client.request('/api/constitution'),
        client.request(`/api/constitution/audit?limit=${encodeURIComponent(args.limit || 20)}`),
      ]);
      return { constitution: constitution.constitution, audit: audit.audit };
    },
  },
  loop_enter: {
    description: 'Default zero-manual entry point. Let the constitution-derived decision engine select the project, active work, bounded read plan, and one next action. Call this first unless a more specific active tool flow is already known.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        intent: { type: 'string', description: 'The user desired outcome in their own words. Tool and menu names are not required.' },
        currentPath: { type: 'string', description: 'Optional current local project path used only for project matching.' },
      },
    },
    async run(client, args) {
      return client.request('/api/orchestration/enter', { method: 'POST', body: args });
    },
  },
  portfolio_enter: {
    description: 'Lowest-cost entry point for a new agent session. Lists registered projects, active-work counts, attention counts, entry references, and a portfolio revision without loading project internals.',
    inputSchema: { type: 'object', properties: {} },
    async run(client) {
      return client.request('/api/entry');
    },
  },
  project_enter: {
    description: 'Enter one project and receive its compact status, active work, attention queue, recommended next action, and read-plan reference.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', default: 'team-loop' } },
    },
    async run(client, args) {
      return client.request(`/api/projects/${encodeURIComponent(args.projectId || 'team-loop')}/entry`);
    },
  },
  project_read_plan: {
    description: 'Return the required, optional, and excluded resources for an intent under a bounded context budget. Use this before reading broad project context.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', default: 'team-loop' },
        intent: { type: 'string', enum: ['enter', 'resume', 'new-work'], default: 'enter' },
        workId: { type: 'string' },
        maxTokens: { type: 'number' },
      },
    },
    async run(client, args) {
      const query = new URLSearchParams({ intent: args.intent || 'enter' });
      if (args.workId) query.set('workId', args.workId);
      if (args.maxTokens) query.set('maxTokens', String(args.maxTokens));
      return client.request(`/api/projects/${encodeURIComponent(args.projectId || 'team-loop')}/read-plan?${query}`);
    },
  },
  work_inspect: {
    description: 'Inspect one work ledger: execution contract, compact event timeline, verification evidence, checkpoints, and latest handoff.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', default: 'team-loop' },
        workId: { type: 'string' },
      },
      required: ['workId'],
    },
    async run(client, args) {
      return client.request(`/api/projects/${encodeURIComponent(args.projectId || 'team-loop')}/works/${encodeURIComponent(args.workId)}`);
    },
  },
  handoff_read: {
    description: 'Read only the latest structured handoff for a work item. This is the fastest resume path after project entry.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', default: 'team-loop' },
        workId: { type: 'string' },
      },
      required: ['workId'],
    },
    async run(client, args) {
      return client.request(`/api/projects/${encodeURIComponent(args.projectId || 'team-loop')}/works/${encodeURIComponent(args.workId)}/handoff`);
    },
  },
  handoff_write: {
    description: 'Write a structured end-of-command handoff. Runtime facts and evidence are filled from the work ledger; provide only decisions, failed attempts, and concise notes.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', default: 'team-loop' },
        workId: { type: 'string' },
        trigger: { type: 'string' },
        decisions: { type: 'array', items: { type: 'string' } },
        failedAttempts: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
      },
      required: ['workId'],
    },
    async run(client, args) {
      return client.request(`/api/projects/${encodeURIComponent(args.projectId || 'team-loop')}/works/${encodeURIComponent(args.workId)}/handoff`, {
        method: 'POST',
        body: {
          trigger: args.trigger || 'AGENT_COMMAND_COMPLETED',
          decisions: args.decisions || [],
          failedAttempts: args.failedAttempts || [],
          notes: args.notes || '',
        },
      });
    },
  },
  balance_run: {
    description: 'Start a non-blocking stochastic balance job. Returns a job id immediately; poll balance_job_read and then use balance_result_read for evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['evaluate', 'tune'] },
        provider: { type: 'string', enum: ['combat-v1', 'auction-economy-v1'] },
        spec: { type: 'object' },
        baseline: { type: 'object' },
        seed: { type: 'number' },
        seeds: { type: 'array', items: { type: 'number' }, maxItems: 50 },
        runs: { type: 'number' },
        maxCandidates: { type: 'number' },
        priorParameters: { type: 'object', description: 'Optional parameters from a previous experiment to evaluate first.' },
      },
      required: ['spec', 'baseline'],
    },
    async run(client, args) {
      return client.request('/api/balance/jobs', { method: 'POST', body: args });
    },
  },
  balance_job_read: {
    description: 'Read progress and terminal state for a balance job. A completed job includes the saved experiment id.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
    async run(client, args) {
      return client.request(`/api/balance/jobs/${encodeURIComponent(args.jobId)}`);
    },
  },
  balance_job_cancel: {
    description: 'Cancel a queued or running balance job. The saved baseline and prior experiments are unchanged.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
    async run(client, args) {
      return client.request(`/api/balance/jobs/${encodeURIComponent(args.jobId)}/cancel`, { method: 'POST', body: {} });
    },
  },
  balance_job_resume: {
    description: 'Resume an interrupted, failed, or cancelled balance job from its saved request.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
    async run(client, args) {
      return client.request(`/api/balance/jobs/${encodeURIComponent(args.jobId)}/resume`, { method: 'POST', body: {} });
    },
  },
  balance_result_read: {
    description: 'Read a saved balance result progressively. Start with summary, request diagnostics for one metric or policy, and use raw only when exact full evidence is necessary.',
    inputSchema: {
      type: 'object',
      properties: {
        experimentId: { type: 'string' },
        view: { type: 'string', enum: ['summary', 'diagnostics', 'raw'], default: 'summary' },
        metricId: { type: 'string', description: 'For diagnostics, return only this metric when provided.' },
        policyId: { type: 'string', description: 'For diagnostics, include timelines and failure causes only for this policy.' },
      },
      required: ['experimentId'],
    },
    async run(client, args) {
      const query = new URLSearchParams({ view: args.view || 'summary' });
      if (args.metricId) query.set('metricId', args.metricId);
      if (args.policyId) query.set('policyId', args.policyId);
      return client.request(`/api/balance/experiments/${encodeURIComponent(args.experimentId)}?${query}`);
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
        historicalContext: { type: 'boolean', description: 'Search only archived historical documents. Archived sources never override current contracts.' },
      },
      required: ['goal'],
    },
    async run(client, args) {
      return client.request('/api/experience/prepare', { method: 'POST', body: args });
    },
  },
  context_archive_search: {
    description: 'Explicitly search the historical documentation archive. Results are marked historical and may describe superseded behavior; do not use them to override current contracts.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        maxChunks: { type: 'number' },
        maxCharacters: { type: 'number' },
      },
      required: ['query'],
    },
    async run(client, args) {
      const query = new URLSearchParams({ q: String(args.query), historical: 'true' });
      if (args.maxChunks) query.set('maxChunks', String(args.maxChunks));
      if (args.maxCharacters) query.set('maxCharacters', String(args.maxCharacters));
      return client.request(`/api/context-index/search?${query}`);
    },
  },
  context_pack_prepare: {
    description: 'Prepare and persist a private, seed-driven context pack. Returns selected wiki, sources, failures, skills, harness, budgets, and an immutable context contract.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        description: { type: 'string' },
        seedId: { type: 'string' },
        allowedPaths: { type: 'array', items: { type: 'string' } },
        acceptanceCriteria: { type: 'array', items: { type: 'string' } },
        maxSourceChunks: { type: 'number' },
        maxSourceCharacters: { type: 'number' },
        maxWikiEntries: { type: 'number' },
        historicalContext: { type: 'boolean', description: 'Build from archived historical sources only.' },
      },
      required: ['goal', 'seedId'],
    },
    async run(client, args) {
      return client.request('/api/context-packs/prepare', { method: 'POST', body: args });
    },
  },
  context_pack_list: {
    description: 'List the current user’s private persisted context packs and their lock, integrity, source, and token status.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    async run(client, args) {
      const query = new URLSearchParams();
      if (args.limit) query.set('limit', String(args.limit));
      return client.request(`/api/context-packs?${query}`);
    },
  },
  context_pack_get: {
    description: 'Read one private persisted context pack with selected evidence and its deterministic context receipt.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    async run(client, args) {
      return client.request(`/api/context-packs/${encodeURIComponent(args.id)}`);
    },
  },
  context_pack_lock: {
    description: 'Verify input hashes, create a deterministic serialization receipt, and lock a context pack before an agent run. Fails closed on missing or stale inputs.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    async run(client, args) {
      return client.request(`/api/context-packs/${encodeURIComponent(args.id)}/lock`, { method: 'POST', body: {} });
    },
  },
  promotion_status: {
    description: 'Inspect the private optimistic-promotion policy, unhandled failure candidates, promotion receipts, probation, stability, quarantine, and automatic rollbacks.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    async run(client, args) {
      const query = new URLSearchParams();
      if (args.limit) query.set('limit', String(args.limit));
      return client.request(`/api/promotions?${query}`);
    },
  },
  promotion_scan: {
    description: 'Scan accumulated private failures, score candidates, snapshot artifacts, and optimistically activate reversible skill or harness candidates. Irreversible or external effects remain awaiting approval.',
    inputSchema: { type: 'object', properties: {} },
    async run(client) {
      return client.request('/api/promotions/scan', { method: 'POST', body: {} });
    },
  },
  promotion_audit: {
    description: 'Compare probation artifacts with later failures. Clean audits move artifacts toward STABLE; recurrence automatically disables and rolls back the artifact.',
    inputSchema: { type: 'object', properties: {} },
    async run(client) {
      return client.request('/api/promotions/audit', { method: 'POST', body: {} });
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
    const constitution = await constitutionPromise;
    reply(id, {
      protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions: constitution.instructions,
    });
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
