import path from 'node:path';
import { atomicWriteJson, HttpError, nowIso, randomId, readJson, sha256 } from './utils.js';
import { normalizeWorkspaceId } from './workspace-manager.js';

const EMPTY_REGISTRY = { schemaVersion: 1, revision: 0, projects: [] };
const EMPTY_HANDOFFS = { schemaVersion: 1, handoffs: [] };
const ACTIVE_STATUSES = new Set(['READY', 'IN_PROGRESS', 'REVIEW', 'BLOCKED']);

export class EntryService {
  constructor({ dataDirectory, workspaceRoot }) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.registryPath = path.join(dataDirectory, 'project-registry.json');
    this.handoffPath = path.join(dataDirectory, 'work-handoffs.json');
    this.lock = Promise.resolve();
  }

  async initialize() {
    await this.#withLock(async () => {
      const registry = await readJson(this.registryPath, EMPTY_REGISTRY);
      if (!Array.isArray(registry.projects)) throw new Error('Invalid project registry.');
      if (!registry.projects.some((item) => item.id === 'team-loop')) {
        registry.projects.push({
          id: 'team-loop',
          title: 'Team Loop',
          purpose: 'AI learning loops, context orchestration, and balance experiments',
          location: this.workspaceRoot,
          status: 'ACTIVE',
          createdAt: nowIso(),
          updatedAt: nowIso(),
        });
        registry.revision = Number(registry.revision || 0) + 1;
      }
      await atomicWriteJson(this.registryPath, registry);
      const handoffs = await readJson(this.handoffPath, EMPTY_HANDOFFS);
      if (!Array.isArray(handoffs.handoffs)) throw new Error('Invalid work handoff ledger.');
      await atomicWriteJson(this.handoffPath, handoffs);
    });
  }

  async portfolio(tasks = []) {
    const registry = await readJson(this.registryPath, EMPTY_REGISTRY);
    const currentStats = summarizeTasks(tasks);
    return {
      schemaVersion: 1,
      kind: 'PORTFOLIO_ENTRY',
      revision: registry.revision,
      generatedAt: nowIso(),
      projects: registry.projects.map((project) => ({
        ...project,
        ...(project.id === 'team-loop' ? currentStats : { activeWorkCount: 0, attentionCount: 0, latestActivityAt: project.updatedAt }),
        entryRef: `project://${project.id}/entry`,
      })),
    };
  }

  async register(actor, input = {}) {
    if (actor.role !== 'admin') throw new HttpError(403, 'Only an administrator can register projects.');
    const id = normalizeWorkspaceId(input.id || input.title);
    const title = String(input.title || id).trim().slice(0, 120);
    const purpose = String(input.purpose || '').trim().slice(0, 1000);
    const location = input.location ? path.resolve(String(input.location)) : '';
    return this.#withLock(async () => {
      const registry = await readJson(this.registryPath, EMPTY_REGISTRY);
      if (registry.projects.some((item) => item.id === id)) throw new HttpError(409, 'Project id already exists.');
      const project = { id, title, purpose, location, status: 'ACTIVE', createdAt: nowIso(), updatedAt: nowIso() };
      registry.projects.push(project);
      registry.revision = Number(registry.revision || 0) + 1;
      await atomicWriteJson(this.registryPath, registry);
      return { ...project, entryRef: `project://${id}/entry`, revision: registry.revision };
    });
  }

  async projectEntry(projectId, tasks = [], audits = []) {
    const project = await this.#project(projectId);
    const localTasks = project.id === 'team-loop' ? tasks : [];
    const active = localTasks.filter((task) => ACTIVE_STATUSES.has(task.status) && !task.archived);
    const latest = [...localTasks].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 8);
    const handoffs = await this.#handoffsForProject(project.id);
    const activeWorks = active.map((task) => workSummary(task, localTasks));
    const attention = buildAttention(activeWorks);
    return {
      schemaVersion: 1,
      kind: 'PROJECT_ENTRY',
      revision: entryRevision(project, localTasks, handoffs),
      generatedAt: nowIso(),
      project,
      summary: {
        ...summarizeTasks(localTasks),
        handoffCount: handoffs.length,
        auditEventCount: project.id === 'team-loop' ? audits.length : 0,
      },
      attention,
      activeWorks,
      recentWorks: latest.map((task) => workSummary(task, localTasks)),
      recommendedAction: attention[0]?.action || (activeWorks[0] ? { name: 'work_resume', workId: activeWorks[0].id } : { name: 'work_create' }),
      readPlanRef: `project://${project.id}/read-plan`,
    };
  }

  async readPlan(projectId, { intent = 'enter', workId = null, maxTokens = 12_000 } = {}) {
    const project = await this.#project(projectId);
    const required = [`project://${project.id}/entry`];
    const optional = [];
    if (project.id === 'team-loop') required.push('project://team-loop-tool-lane/handoff/current');
    if (workId) {
      required.push(`work://${workId}/contract`, `work://${workId}/handoff/latest`);
      optional.push(`work://${workId}/timeline`, `work://${workId}/evidence`);
    } else if (intent === 'new-work') {
      optional.push(`project://${project.id}/wiki`, `project://${project.id}/context/stable`);
    }
    return {
      schemaVersion: 1,
      kind: 'READ_PLAN',
      projectId: project.id,
      intent,
      required,
      optional,
      excluded: ['work://archived/*', 'logs://raw/*'],
      budget: { maxTokens: Math.max(1_000, Math.min(100_000, Number(maxTokens) || 12_000)) },
      generatedAt: nowIso(),
    };
  }

  async inspectWork(projectId, workId, task, audits = []) {
    const project = await this.#project(projectId);
    if (!task) throw new HttpError(404, 'Work not found.');
    const timeline = audits.filter((event) => event.data?.taskId === workId).map((event) => ({
      eventId: event.eventId,
      at: event.at,
      actorUserId: event.actorUserId,
      action: event.action,
      data: event.data,
    }));
    const handoffs = (await this.#handoffsForProject(project.id)).filter((item) => item.workId === workId);
    return {
      schemaVersion: 1,
      kind: 'WORK_LEDGER',
      projectId: project.id,
      work: workSummary(task),
      contract: {
        goal: task.title,
        description: task.description,
        allowedPaths: task.allowedPaths || [],
        acceptanceCriteria: task.acceptanceCriteria || [],
        verificationProfile: task.verificationProfile,
        skillIds: task.skillIds || [],
      },
      timeline,
      evidence: {
        verification: task.verification || null,
        review: task.review || null,
        changedPaths: task.verification?.changedPaths || [],
      },
      latestHandoff: handoffs[0] || null,
      checkpoints: handoffs.map((item) => ({
        id: item.id,
        status: item.status,
        trigger: item.trigger,
        createdAt: item.createdAt,
        revision: item.revision,
      })),
    };
  }

  async writeHandoff(actor, projectId, task, audits = [], input = {}) {
    const project = await this.#project(projectId);
    if (!task) throw new HttpError(404, 'Work not found.');
    const timeline = audits.filter((event) => event.data?.taskId === task.id);
    const lastEvent = timeline.at(-1) || null;
    const completed = completedFacts(task);
    const remaining = remainingFacts(task);
    const handoff = {
      schemaVersion: 1,
      kind: 'HANDOFF',
      id: randomId('hof_'),
      projectId: project.id,
      workId: task.id,
      status: handoffStatus(task),
      trigger: String(input.trigger || 'MANUAL').toUpperCase(),
      revision: task.version,
      sourceRevision: sha256(JSON.stringify({ taskVersion: task.version, lastEventId: lastEvent?.eventId || null })),
      createdAt: nowIso(),
      createdByUserId: actor.id,
      completed,
      remaining,
      decisions: cleanList(input.decisions, 20),
      failedAttempts: cleanList(input.failedAttempts, 20),
      notes: String(input.notes || '').trim().slice(0, 4000),
      nextAction: nextAction(task),
      evidence: {
        verificationStatus: task.verification?.status || null,
        verificationPassed: Boolean(task.verification?.passed),
        reviewStatus: task.review?.status || null,
        latestAuditEventId: lastEvent?.eventId || null,
        changedPaths: task.verification?.changedPaths || [],
      },
      summaryStatus: input.summaryStatus === 'COMPLETE' ? 'COMPLETE' : 'FACTS_ONLY',
    };
    return this.#withLock(async () => {
      const db = await readJson(this.handoffPath, EMPTY_HANDOFFS);
      db.handoffs.unshift(handoff);
      db.handoffs = db.handoffs.slice(0, 2_000);
      await atomicWriteJson(this.handoffPath, db);
      return handoff;
    });
  }

  async latestHandoff(projectId, workId) {
    await this.#project(projectId);
    const handoffs = await this.#handoffsForProject(projectId);
    return handoffs.find((item) => item.workId === workId) || null;
  }

  async #project(projectId) {
    const registry = await readJson(this.registryPath, EMPTY_REGISTRY);
    const project = registry.projects.find((item) => item.id === normalizeWorkspaceId(projectId));
    if (!project) throw new HttpError(404, 'Project not found.');
    return project;
  }

  async #handoffsForProject(projectId) {
    const db = await readJson(this.handoffPath, EMPTY_HANDOFFS);
    return db.handoffs.filter((item) => item.projectId === projectId);
  }

  #withLock(work) {
    const result = this.lock.then(work, work);
    this.lock = result.catch(() => {});
    return result;
  }
}

function summarizeTasks(tasks) {
  const visible = tasks.filter((item) => !item.archived);
  const active = visible.filter((item) => ACTIVE_STATUSES.has(item.status));
  return {
    activeWorkCount: active.length,
    attentionCount: active.filter((item) => item.status === 'BLOCKED' || item.verification?.status === 'FAILED' || item.verification?.status === 'ERROR').length,
    completedWorkCount: visible.filter((item) => item.status === 'DONE').length,
    latestActivityAt: [...visible].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0]?.updatedAt || null,
  };
}

function workSummary(task, allTasks = []) {
  const pendingDependencies = (task.dependsOnTaskIds || []).filter((taskId) =>
    allTasks.find((candidate) => candidate.id === taskId)?.status !== 'DONE');
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    executionMode: task.executionMode,
    executionState: task.executionState,
    updatedAt: task.updatedAt,
    version: task.version,
    priority: task.priority,
    planId: task.planId || null,
    planStepId: task.planStepId || null,
    dependsOnTaskIds: task.dependsOnTaskIds || [],
    pendingDependencyIds: pendingDependencies,
    dependencyBlocked: pendingDependencies.length > 0,
    verification: task.verification ? { status: task.verification.status, passed: Boolean(task.verification.passed), finishedAt: task.verification.finishedAt } : null,
    nextAction: nextAction(task),
    ledgerRef: `work://${task.id}/ledger`,
  };
}

function buildAttention(tasks) {
  return tasks.flatMap((task) => {
    if (task.dependencyBlocked) return [{ level: 'MEDIUM', workId: task.id, reason: `Waiting for ${task.pendingDependencyIds.length} prerequisite task(s).`, action: { name: 'work_inspect', workId: task.id } }];
    if (task.status === 'BLOCKED') return [{ level: 'HIGH', workId: task.id, reason: task.blocked?.reason || 'Work is blocked.', action: { name: 'work_inspect', workId: task.id } }];
    if (task.verification && !task.verification.passed) return [{ level: 'HIGH', workId: task.id, reason: 'Verification needs attention.', action: { name: 'work_inspect', workId: task.id } }];
    if (task.status === 'REVIEW') return [{ level: 'MEDIUM', workId: task.id, reason: 'Review is pending.', action: { name: 'work_inspect', workId: task.id } }];
    return [];
  });
}

function completedFacts(task) {
  const result = [];
  if (task.status !== 'READY') result.push('work-started');
  if (task.verification) result.push(task.verification.passed ? 'verification-passed' : 'verification-recorded');
  if (task.review?.status) result.push(`review-${task.review.status.toLowerCase()}`);
  if (task.status === 'DONE') result.push('work-completed');
  return result;
}

function remainingFacts(task) {
  if (task.status === 'DONE') return [];
  if (task.status === 'BLOCKED') return ['resolve-blocker', 'resume-work'];
  if (!task.verification?.passed) return ['complete-changes', 'run-verification'];
  if (task.status === 'IN_PROGRESS') return ['request-review'];
  if (task.status === 'REVIEW') return ['complete-review'];
  return ['start-work'];
}

function nextAction(task) {
  if (task.status === 'DONE') return { name: 'work_close', workId: task.id };
  if (task.status === 'BLOCKED') return { name: 'work_inspect', workId: task.id };
  if (task.status === 'READY') return { name: 'work_resume', workId: task.id };
  if (!task.verification?.passed) return { name: 'verify_task', workId: task.id };
  if (task.status === 'IN_PROGRESS') return { name: 'request_review', workId: task.id };
  return { name: 'work_inspect', workId: task.id };
}

function handoffStatus(task) {
  if (task.status === 'DONE') return 'COMPLETED';
  if (task.status === 'BLOCKED') return 'BLOCKED';
  return 'READY_TO_RESUME';
}

function cleanList(value, maxItems) {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values.map((item) => String(item).trim().slice(0, 1000)).filter(Boolean))].slice(0, maxItems);
}

function entryRevision(project, tasks, handoffs) {
  return sha256(JSON.stringify({
    projectUpdatedAt: project.updatedAt,
    tasks: tasks.map((item) => [item.id, item.version]),
    latestHandoff: handoffs[0]?.sourceRevision || null,
  })).slice(0, 16);
}
