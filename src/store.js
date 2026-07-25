import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicWriteJson, appendJsonLine, HttpError, nowIso, randomId, readJson } from './utils.js';
import { hashPassword, verifyPassword } from './auth.js';

const EMPTY_USERS = { schemaVersion: 1, users: [] };
const EMPTY_TASKS = { schemaVersion: 1, tasks: [] };
const DUMMY_PASSWORD_RECORD = {
  passwordSalt: '00000000000000000000000000000000',
  passwordHash: 'd4da029001f8d915f8b59f346c7a2f1d5937a484023611b41ba03e461c3b5803',
  passwordIterations: 210_000,
  passwordDigest: 'sha256',
};

function assertAcyclicDependencies(graph) {
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new HttpError(400, `Plan dependency cycle detected at ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of graph.get(id) || []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id);
}

export class Store {
  constructor(dataDirectory, { signupCode = '', serverStartedAt = Date.now(), bootstrapWindowMs = 10 * 60 * 1000 } = {}) {
    this.dataDirectory = dataDirectory;
    this.usersPath = path.join(dataDirectory, 'users.json');
    this.tasksPath = path.join(dataDirectory, 'tasks.json');
    this.auditPath = path.join(dataDirectory, 'audit.jsonl');
    this.lock = Promise.resolve();
    this.signupCode = String(signupCode || '');
    this.serverStartedAt = Number(serverStartedAt) || Date.now();
    this.bootstrapWindowMs = Number(bootstrapWindowMs) || 10 * 60 * 1000;
  }

  async initialize() {
    await this.#withLock(async () => {
      const users = await readJson(this.usersPath, EMPTY_USERS);
      const tasks = await readJson(this.tasksPath, EMPTY_TASKS);
      migrateLegacySupersessions(tasks.tasks);
      await atomicWriteJson(this.usersPath, users);
      await atomicWriteJson(this.tasksPath, tasks);
    });
  }

  async registerUser({ name, password, signupCode = '' }) {
    const cleanName = String(name ?? '').trim();
    if (cleanName.length < 2 || cleanName.length > 40) throw new HttpError(400, 'Name must be 2-40 characters.');
    if (String(password ?? '').length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');

    // PBKDF2 is deliberately outside the global state lock. Duplicate-name races are
    // still closed by the second check inside #withLock; the losing request only wastes
    // its own password derivation instead of blocking all state mutations.
    const passwordRecord = await hashPassword(String(password));
    return this.#withLock(async () => {
      const db = await readJson(this.usersPath, EMPTY_USERS);
      if (db.users.some((user) => user.name.toLowerCase() === cleanName.toLowerCase())) {
        throw new HttpError(409, 'That name is already registered.');
      }
      const isFirstUser = db.users.length === 0;
      if (this.signupCode && String(signupCode) !== this.signupCode) {
        throw new HttpError(403, 'Invalid signup code.');
      }
      if (isFirstUser && !this.signupCode && Date.now() - this.serverStartedAt > this.bootstrapWindowMs) {
        throw new HttpError(403, 'First administrator registration window expired. Set SIGNUP_CODE and restart the server.');
      }
      const user = {
        id: randomId('usr_'),
        name: cleanName,
        role: isFirstUser ? 'admin' : 'member',
        createdAt: nowIso(),
        passwordSalt: passwordRecord.salt,
        passwordHash: passwordRecord.hash,
        passwordIterations: passwordRecord.iterations,
        passwordDigest: passwordRecord.digest,
      };
      db.users.push(user);
      await atomicWriteJson(this.usersPath, db);
      await this.#audit(user.id, 'USER_REGISTERED', { role: user.role });
      return this.#publicUser(user);
    });
  }

  async authenticate(name, password) {
    const db = await readJson(this.usersPath, EMPTY_USERS);
    const user = db.users.find((entry) => entry.name.toLowerCase() === String(name ?? '').trim().toLowerCase());
    const valid = await verifyPassword(String(password ?? ''), user || DUMMY_PASSWORD_RECORD);
    if (!user || !valid) throw new HttpError(401, 'Invalid name or password.');
    if (user.disabledAt) throw new HttpError(403, 'This account is disabled.');
    return this.#publicUser(user);
  }

  async getUser(userId) {
    const db = await readJson(this.usersPath, EMPTY_USERS);
    const user = db.users.find((entry) => entry.id === userId);
    return user ? this.#publicUser(user) : null;
  }

  async listUsers() {
    const db = await readJson(this.usersPath, EMPTY_USERS);
    return db.users.map((user) => this.#publicUser(user)).sort((a, b) => a.name.localeCompare(b.name));
  }

  async setUserDisabled(actor, userId, disabled) {
    if (actor.role !== 'admin') throw new HttpError(403, 'Administrator access required.');
    return this.#withLock(async () => {
      const db = await readJson(this.usersPath, EMPTY_USERS);
      const user = db.users.find((entry) => entry.id === userId);
      if (!user) throw new HttpError(404, 'User not found.');
      if (user.id === actor.id && disabled) throw new HttpError(409, 'You cannot disable your own account.');
      user.disabledAt = disabled ? (user.disabledAt || nowIso()) : null;
      await atomicWriteJson(this.usersPath, db);
      await this.#audit(actor.id, disabled ? 'USER_DISABLED' : 'USER_ENABLED', { userId: user.id });
      return this.#publicUser(user);
    });
  }

  async listTasks() {
    const db = await readJson(this.tasksPath, EMPTY_TASKS);
    return [...db.tasks].sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
  }

  async listAuditEvents({ limit = 5000 } = {}) {
    let text = '';
    try {
      text = await readFile(this.auditPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const events = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event?.at && event?.action) events.push(event);
      } catch {
        // Ignore malformed audit rows so the dashboard can still render.
      }
    }
    return events.slice(-Math.max(1, Math.min(20_000, Number(limit) || 5000)));
  }

  async getTask(taskId) {
    const db = await readJson(this.tasksPath, EMPTY_TASKS);
    return db.tasks.find((task) => task.id === taskId) ?? null;
  }

  async createTask(actor, input, profileNames, { defaultProfile = null, autoSkillIds = [], autoLearningRationale = null } = {}) {
    const task = this.#buildTask(actor, input, profileNames, { defaultProfile, autoSkillIds, autoLearningRationale });
    return this.#withLock(async () => {
      const db = await readJson(this.tasksPath, EMPTY_TASKS);
      db.tasks.push(task);
      await atomicWriteJson(this.tasksPath, db);
      await this.#audit(actor.id, 'TASK_CREATED', { taskId: task.id, title: task.title });
      return task;
    });
  }

  async initializeAiProfiles({ executorProfileId, reviewerProfileId, approvalPolicy = 'USER_CONFIRM' }) {
    if (!executorProfileId || !reviewerProfileId) return 0;
    return this.#withLock(async () => {
      const db = await readJson(this.tasksPath, EMPTY_TASKS);
      let changed = 0;
      for (const task of db.tasks) {
        let taskChanged = false;
        if (!task.executorProfileId) {
          task.executorProfileId = executorProfileId;
          taskChanged = true;
        }
        if (!task.reviewerProfileId) {
          task.reviewerProfileId = reviewerProfileId;
          taskChanged = true;
        }
        if (!task.approvalPolicy) {
          task.approvalPolicy = normalizeApprovalPolicy(approvalPolicy);
          taskChanged = true;
        }
        if (taskChanged) changed += 1;
      }
      if (changed) await atomicWriteJson(this.tasksPath, db);
      return changed;
    });
  }

  async recoverInterruptedAgentTasks({ recoveryId = 'startup' } = {}) {
    return this.#withLock(async () => {
      const db = await readJson(this.tasksPath, EMPTY_TASKS);
      const recovered = [];
      const at = nowIso();
      for (const task of db.tasks) {
        if (task.executionRun?.recoveryId === recoveryId) continue;
        const legacyInterrupted = task.executionState === 'IDLE'
          && task.status === 'IN_PROGRESS'
          && task.agentActivity?.phase === 'interrupted';
        if (!['RUNNING', 'RECOVERING'].includes(task.executionState) && !legacyInterrupted) continue;
        task.executionState = 'RECOVERING';
        task.executionRun = {
          ...(task.executionRun || {}),
          status: 'RECOVERING',
          heartbeatAt: task.executionRun?.heartbeatAt || task.agentActivity?.updatedAt || null,
          recoveryStartedAt: at,
          recoveryReason: 'SERVER_RESTART_NO_LIVE_PROCESS',
          recoveryId,
        };
        task.agentActivity = {
          ...(task.agentActivity || {}),
          phase: 'recovering',
          label: '자동 작업 복구 중',
          detail: '서버 시작 시 살아 있는 작업자 프로세스를 찾지 못해 격리 작업물과 검증 상태를 확인하고 있습니다.',
          updatedAt: at,
          finishedAt: null,
          passed: false,
        };
        task.updatedAt = at;
        task.version = Math.max(1, Number(task.version) || 1) + 1;
        recovered.push({ taskId: task.id, ownerUserId: task.assigneeUserId || task.creatorUserId || null });
      }
      if (!recovered.length) return [];
      await atomicWriteJson(this.tasksPath, db);
      for (const item of recovered) {
        await this.#audit(item.ownerUserId || 'system', 'TASK_AGENT_INTERRUPTED', {
          taskId: item.taskId,
          reason: 'SERVER_RESTART_NO_LIVE_PROCESS',
        });
      }
      return recovered.map((item) => item.taskId);
    });
  }

  async createPlan(actor, input, profileNames) {
    const objective = String(input.objective || '').trim().slice(0, 2000);
    const title = String(input.title || objective).trim().slice(0, 120);
    const steps = Array.isArray(input.steps) ? input.steps : [];
    if (title.length < 3 || objective.length < 3) throw new HttpError(400, 'Plan needs a title and objective.');
    if (!steps.length || steps.length > 30) throw new HttpError(400, 'Plan needs 1-30 steps.');
    const stepIds = steps.map((step, index) => String(step.stepId || `step-${index + 1}`).trim());
    if (new Set(stepIds).size !== stepIds.length || stepIds.some((id) => !/^[a-zA-Z0-9_-]{1,80}$/.test(id))) {
      throw new HttpError(400, 'Plan step ids must be unique safe identifiers.');
    }
    const dependencies = new Map(steps.map((step, index) => [
      stepIds[index],
      [...new Set((Array.isArray(step.dependsOn) ? step.dependsOn : []).map(String))],
    ]));
    for (const [stepId, refs] of dependencies) {
      if (refs.includes(stepId) || refs.some((ref) => !dependencies.has(ref))) {
        throw new HttpError(400, `Plan step ${stepId} has an invalid dependency.`);
      }
    }
    assertAcyclicDependencies(dependencies);
    const planId = randomId('plan_');
    const taskIds = new Map(stepIds.map((stepId) => [stepId, randomId('tsk_')]));
    const tasks = steps.map((step, index) => this.#buildTask(actor, {
      ...step,
      id: taskIds.get(stepIds[index]),
      priority: step.priority ?? (index + 1) * 10,
      allowedPaths: step.allowedPaths || input.allowedPaths || ['**'],
      verificationProfile: step.verificationProfile || input.verificationProfile,
      assigneeUserId: step.assigneeUserId || input.assigneeUserId,
      reviewerUserId: step.reviewerUserId || input.reviewerUserId,
      executorProfileId: step.executorProfileId || input.executorProfileId,
      reviewerProfileId: step.reviewerProfileId || input.reviewerProfileId,
      approvalPolicy: step.approvalPolicy || input.approvalPolicy,
      planId,
      planStepId: stepIds[index],
      planTitle: title,
      dependsOnTaskIds: dependencies.get(stepIds[index]).map((ref) => taskIds.get(ref)),
    }, profileNames, {}));

    return this.#withLock(async () => {
      const db = await readJson(this.tasksPath, EMPTY_TASKS);
      db.tasks.push(...tasks);
      await atomicWriteJson(this.tasksPath, db);
      await this.#audit(actor.id, 'PLAN_CREATED', { planId, title, objective, taskIds: tasks.map((task) => task.id) });
      return { schemaVersion: 1, kind: 'team-loop-plan', planId, title, objective, tasks };
    });
  }

  #buildTask(actor, input, profileNames, { defaultProfile = null, autoSkillIds = [], autoLearningRationale = null } = {}) {
    const title = String(input.title ?? '').trim();
    if (title.length < 3 || title.length > 120) throw new HttpError(400, 'Title must be 3-120 characters.');
    const requestedProfile = input.verificationProfile == null || input.verificationProfile === ''
      ? (defaultProfile ?? 'repository-basic')
      : input.verificationProfile;
    const verificationProfile = String(requestedProfile);
    if (!profileNames.includes(verificationProfile)) throw new HttpError(400, 'Unknown verification profile.');
    const memberSafeProfiles = (process.env.MEMBER_SAFE_PROFILES || 'repository-basic').split(',').map((p) => p.trim()).filter(Boolean);
    if (actor.role !== 'admin' && !memberSafeProfiles.includes(verificationProfile)) {
      throw new HttpError(403, `Members may only use safe verification profiles (${memberSafeProfiles.join(', ')}); code-executing profiles like node --test require an admin.`);
    }
    const allowedPaths = this.#normalizePaths(input.allowedPaths);
    if (allowedPaths.length === 0) throw new HttpError(400, 'At least one allowed path is required. Use ** to allow the whole workspace.');
    const skillIds = this.#normalizeSkillIds(input.skillIds ?? autoSkillIds);
    const at = nowIso();
    return {
      id: input.id || randomId('tsk_'),
      title,
      description: String(input.description ?? '').trim().slice(0, 4000),
      status: 'READY',
      priority: Number.isFinite(Number(input.priority)) ? Math.max(1, Math.min(999, Number(input.priority))) : 100,
      creatorUserId: actor.id,
      assigneeUserId: input.assigneeUserId || actor.id,
      reviewerUserId: input.reviewerUserId || null,
      executorProfileId: String(input.executorProfileId || '').trim().slice(0, 80) || null,
      reviewerProfileId: String(input.reviewerProfileId || '').trim().slice(0, 80) || null,
      approvalPolicy: normalizeApprovalPolicy(input.approvalPolicy),
      allowedPaths,
      acceptanceCriteria: this.#normalizeList(input.acceptanceCriteria, 10, 1000),
      allowNoChanges: input.allowNoChanges === true,
      verificationProfile,
      schedule: normalizeTaskSchedule(input.schedule),
      skillIds,
      planId: input.planId || null,
      planStepId: input.planStepId || null,
      planTitle: input.planTitle || null,
      dependsOnTaskIds: this.#normalizeList(input.dependsOnTaskIds, 30, 160),
      learning: {
        applications: skillIds.length || defaultProfile ? [{
          at,
          appliedByUserId: actor.id,
          harnessId: input.verificationProfile == null || input.verificationProfile === '' ? verificationProfile : null,
          harnessVersion: null,
          skillIds,
          skillVersions: {},
          sourceFailureCaseIds: [],
          automatic: true,
          selectionRationale: autoLearningRationale,
        }] : [],
      },
      verification: null,
      review: null,
      blocked: null,
      executor: null,
      executionMode: 'HUMAN',
      executionState: 'IDLE',
      automationGuard: {
        totalRuns: 0,
        failedRuns: 0,
        sameFailureCount: 0,
        lastFailureSignature: '',
        lastResultAt: null,
        circuitOpen: false,
      },
      supersedesTaskId: input.supersedesTaskId || null,
      supersededByTaskId: null,
      delegation: normalizeDelegation(input.delegation),
      archived: false,
      archivedAt: null,
      archivedByUserId: null,
      createdAt: at,
      updatedAt: at,
      version: 1,
    };
  }

  async mutateTask(taskId, actor, expectedVersion, mutationName, mutate) {
    return this.#withLock(async () => {
      const db = await readJson(this.tasksPath, EMPTY_TASKS);
      const index = db.tasks.findIndex((task) => task.id === taskId);
      if (index === -1) throw new HttpError(404, 'Task not found.');
      const current = db.tasks[index];
      if (expectedVersion != null && Number(expectedVersion) !== current.version) {
        throw new HttpError(409, 'Task changed in another browser. Refresh and try again.', { currentVersion: current.version });
      }
      const next = structuredClone(current);
      await mutate(next, current);
      next.version = current.version + 1;
      next.updatedAt = nowIso();
      db.tasks[index] = next;
      await atomicWriteJson(this.tasksPath, db);
      await this.#audit(actor.id, mutationName, { taskId, from: current.status, to: next.status, version: next.version });
      return next;
    });
  }

  async finalizeSupersession(replacement, actor) {
    const originalId = replacement?.supersedesTaskId;
    if (!originalId || replacement.status !== 'DONE') return null;
    return this.#withLock(async () => {
      const db = await readJson(this.tasksPath, EMPTY_TASKS);
      const original = db.tasks.find((task) => task.id === originalId);
      if (!original) throw new HttpError(409, 'Superseded task no longer exists.');
      if (original.id === replacement.id) throw new HttpError(409, 'A task cannot supersede itself.');
      const at = nowIso();
      original.archived = true;
      original.archivedAt = at;
      original.archivedByUserId = actor.id;
      original.supersededByTaskId = replacement.id;
      original.supersededAt = at;
      original.version = (Number(original.version) || 0) + 1;
      original.updatedAt = at;
      await atomicWriteJson(this.tasksPath, db);
      await this.#audit(actor.id, 'TASK_SUPERSEDED', { taskId: original.id, replacementTaskId: replacement.id });
      return structuredClone(original);
    });
  }

  async deleteTask(taskId, actor, expectedVersion) {
    return this.#withLock(async () => {
      const db = await readJson(this.tasksPath, EMPTY_TASKS);
      const index = db.tasks.findIndex((task) => task.id === taskId);
      if (index === -1) throw new HttpError(404, 'Task not found.');
      const task = db.tasks[index];
      if (task.creatorUserId !== actor.id && actor.role !== 'admin') {
        throw new HttpError(403, 'Only the creator or an admin can delete a task.');
      }
      if (expectedVersion != null && Number(expectedVersion) !== task.version) {
        throw new HttpError(409, 'Task changed in another browser. Refresh and try again.', { currentVersion: task.version });
      }
      db.tasks.splice(index, 1);
      await atomicWriteJson(this.tasksPath, db);
      await this.#audit(actor.id, 'TASK_DELETED', { taskId, title: task.title });
      return { id: taskId, deleted: true };
    });
  }

  async recordAudit(actorUserId, action, data) {
    return this.#withLock(() => this.#audit(actorUserId, action, data));
  }

  async #audit(actorUserId, action, data) {
    await appendJsonLine(this.auditPath, {
      eventId: randomId('evt_'),
      at: nowIso(),
      actorUserId,
      action,
      data,
    });
  }

  #normalizeList(value, maxItems, maxLength) {
    const items = Array.isArray(value) ? value : String(value ?? '').split(/\r?\n/);
    return [...new Set(items.map((item) => String(item).trim().slice(0, maxLength)).filter(Boolean))].slice(0, maxItems);
  }

  #normalizePaths(value) {
    const items = Array.isArray(value) ? value : String(value ?? '').split(/\r?\n|,/);
    return [...new Set(items.map((item) => String(item).trim().replaceAll('\\', '/').replace(/^\.\//, '')).filter(Boolean))];
  }

  #normalizeSkillIds(value) {
    const items = Array.isArray(value) ? value : String(value ?? '').split(/\r?\n|,/);
    return [...new Set(items.map((item) => String(item).trim()).filter(Boolean))].sort();
  }

  #publicUser(user) {
    return {
      id: user.id,
      name: user.name,
      role: user.role,
      createdAt: user.createdAt,
      disabledAt: user.disabledAt || null,
      active: !user.disabledAt,
    };
  }

  #withLock(work) {
    const result = this.lock.then(work, work);
    this.lock = result.catch(() => {});
    return result;
  }
}

function normalizeDelegation(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    parentTaskId: String(value.parentTaskId || '').trim().slice(0, 160) || null,
    rootTaskId: String(value.rootTaskId || '').trim().slice(0, 160) || null,
    depth: Math.max(1, Math.min(2, Number(value.depth) || 1)),
    role: String(value.role || 'EXECUTE').toUpperCase() === 'REVIEW' ? 'REVIEW' : 'EXECUTE',
    reason: String(value.reason || '').trim().slice(0, 1000),
    fingerprint: String(value.fingerprint || '').trim().slice(0, 64),
    requestedByProfileId: String(value.requestedByProfileId || '').trim().slice(0, 80) || null,
    targetProfileId: String(value.targetProfileId || '').trim().slice(0, 80) || null,
    budget: {
      tokenBudget: Math.max(1_000, Math.min(2_000_000, Number(value.budget?.tokenBudget) || 500_000)),
      costBudgetUsd: Math.max(0.01, Math.min(100, Number(value.budget?.costBudgetUsd) || 10)),
      maxCalls: Math.max(1, Math.min(5, Number(value.budget?.maxCalls) || 2)),
    },
  };
}

function normalizeTaskSchedule(input = {}) {
  const plannedStart = normalizeDateOnly(input?.plannedStart);
  const plannedEnd = normalizeDateOnly(input?.plannedEnd);
  if (plannedStart && plannedEnd && plannedStart > plannedEnd) {
    throw new HttpError(400, 'Schedule start must be on or before the deadline.');
  }
  return {
    plannedStart,
    plannedEnd,
    note: String(input?.note ?? '').trim().slice(0, 1000),
  };
}

function normalizeApprovalPolicy(value) {
  const policy = String(value || 'USER_CONFIRM').trim().toUpperCase();
  return ['USER_CONFIRM', 'AUTO_LOW_RISK', 'AUTO'].includes(policy) ? policy : 'USER_CONFIRM';
}

function normalizeDateOnly(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00.000Z`))) {
    throw new HttpError(400, 'Schedule dates must use YYYY-MM-DD.');
  }
  return text;
}

function migrateLegacySupersessions(tasks = []) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const replacement of tasks) {
    if (!replacement.supersedesTaskId) {
      const match = String(replacement.description || '').match(/\b(tsk_[a-z0-9]+)\b[^\n]{0,80}재발행/i);
      if (match && byId.has(match[1]) && match[1] !== replacement.id) replacement.supersedesTaskId = match[1];
    }
    if (!replacement.supersedesTaskId || replacement.status !== 'DONE') continue;
    const original = byId.get(replacement.supersedesTaskId);
    if (!original || original.id === replacement.id) continue;
    original.archived = true;
    original.archivedAt ||= replacement.completedAt || replacement.archivedAt || replacement.updatedAt || nowIso();
    original.archivedByUserId ||= replacement.review?.reviewerUserId || replacement.creatorUserId || null;
    original.supersededByTaskId = replacement.id;
    original.supersededAt ||= original.archivedAt;
  }
}
