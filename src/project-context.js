import path from 'node:path';
import { atomicWriteJson, HttpError, nowIso, readJson } from './utils.js';

const EMPTY_CONTEXT = {
  schemaVersion: 1,
  content: '',
  updatedAt: null,
  updatedByUserId: null,
};

const MAX_CONTEXT_LENGTH = 12_000;

export class ProjectContextStore {
  constructor(dataDirectory) {
    this.contextPath = path.join(dataDirectory, 'project-context.json');
    this.lock = Promise.resolve();
  }

  async initialize() {
    await this.#withLock(async () => {
      const context = await readJson(this.contextPath, EMPTY_CONTEXT);
      await atomicWriteJson(this.contextPath, normalizeContext(context));
    });
  }

  async get() {
    return normalizeContext(await readJson(this.contextPath, EMPTY_CONTEXT));
  }

  async update(actor, input) {
    const content = String(input?.content ?? '').trim().slice(0, MAX_CONTEXT_LENGTH);
    return this.#withLock(async () => {
      const context = {
        schemaVersion: 1,
        content,
        updatedAt: nowIso(),
        updatedByUserId: actor.id,
      };
      await atomicWriteJson(this.contextPath, context);
      return context;
    });
  }

  #withLock(work) {
    const result = this.lock.then(work, work);
    this.lock = result.catch(() => {});
    return result;
  }
}

export function contextForAI(projectContext) {
  const content = String(projectContext?.content ?? '').trim();
  if (!content) return null;
  if (content.length > MAX_CONTEXT_LENGTH) throw new HttpError(400, 'Project context is too large.');
  return {
    content,
    updatedAt: projectContext.updatedAt ?? null,
    updatedByUserId: projectContext.updatedByUserId ?? null,
  };
}

function normalizeContext(value) {
  return {
    schemaVersion: 1,
    content: String(value?.content ?? '').slice(0, MAX_CONTEXT_LENGTH),
    updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : null,
    updatedByUserId: typeof value?.updatedByUserId === 'string' ? value.updatedByUserId : null,
  };
}
