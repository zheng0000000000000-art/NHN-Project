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

  async createTask(actor, input, profileNames, { defaultProfile = null, autoSkillIds = [] } = {}) {
    const title = String(input.title ?? '').trim();
    if (title.length < 3 || title.length > 120) throw new HttpError(400, 'Title must be 3-120 characters.');
    const requestedProfile = input.verificationProfile == null || input.verificationProfile === ''
      ? (defaultProfile ?? 'repository-basic')
      : input.verificationProfile;
    const verificationProfile = String(requestedProfile);
    if (!profileNames.includes(verificationProfile)) throw new HttpError(400, 'Unknown verification profile.');
    const allowedPaths = this.#normalizePaths(input.allowedPaths);
    if (allowedPaths.length === 0) throw new HttpError(400, 'At least one allowed path is required. Use ** to allow the whole workspace.');
    const skillIds = this.#normalizeSkillIds(input.skillIds ?? autoSkillIds);

    return this.#withLock(async () => {
      const db = await readJson(this.tasksPath, EMPTY_TASKS);
      const task = {
        id: randomId('tsk_'),
        title,
        description: String(input.description ?? '').trim().slice(0, 4000),
        status: 'READY',
        priority: Number.isFinite(Number(input.priority)) ? Math.max(1, Math.min(999, Number(input.priority))) : 100,
        creatorUserId: actor.id,
        assigneeUserId: input.assigneeUserId || null,
        reviewerUserId: input.reviewerUserId || null,
        allowedPaths,
        acceptanceCriteria: this.#normalizeList(input.acceptanceCriteria, 10, 1000),
        verificationProfile,
        schedule: normalizeTaskSchedule(input.schedule),
        skillIds,
        learning: {
          applications: skillIds.length || defaultProfile
            ? [{
              at: nowIso(),
              appliedByUserId: actor.id,
              harnessId: input.verificationProfile == null || input.verificationProfile === '' ? verificationProfile : null,
              harnessVersion: null,
              skillIds,
              skillVersions: {},
              sourceFailureCaseIds: [],
              automatic: true,
            }]
            : [],
        },
        verification: null,
        review: null,
        blocked: null,
        executor: null,
        archived: false,
        archivedAt: null,
        archivedByUserId: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        version: 1,
      };
      db.tasks.push(task);
      await atomicWriteJson(this.tasksPath, db);
      await this.#audit(actor.id, 'TASK_CREATED', { taskId: task.id, title: task.title });
      return task;
    });
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
    return { id: user.id, name: user.name, role: user.role, createdAt: user.createdAt };
  }

  #withLock(work) {
    const result = this.lock.then(work, work);
    this.lock = result.catch(() => {});
    return result;
  }
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

function normalizeDateOnly(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00.000Z`))) {
    throw new HttpError(400, 'Schedule dates must use YYYY-MM-DD.');
  }
  return text;
}
