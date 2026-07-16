import path from 'node:path';
import { atomicWriteJson, HttpError, nowIso, randomId, readJson, sha256 } from './utils.js';

const EMPTY_DISCUSSIONS = { schemaVersion: 1, messages: [], memories: [] };

export class DiscussionStore {
  constructor(dataDirectory) {
    this.path = path.join(dataDirectory, 'discussions.json');
    this.lock = Promise.resolve();
  }

  async initialize() {
    await this.#withLock(async () => {
      const db = await readJson(this.path, EMPTY_DISCUSSIONS);
      await atomicWriteJson(this.path, normalizeDb(db));
    });
  }

  async snapshot({ messageLimit = 200, memoryLimit = 100 } = {}) {
    const db = normalizeDb(await readJson(this.path, EMPTY_DISCUSSIONS));
    return {
      messages: db.messages.slice(-Math.max(1, Math.min(1000, Number(messageLimit) || 200))),
      memories: db.memories.slice(-Math.max(1, Math.min(500, Number(memoryLimit) || 100))),
    };
  }

  async findMemoryBySourceIds(sourceMessageIds = []) {
    const signature = memorySourceSignature(sourceMessageIds);
    const db = normalizeDb(await readJson(this.path, EMPTY_DISCUSSIONS));
    const memory = db.memories.find((item) => item.sourceSignatureSha256 === signature
      || memorySourceSignature(item.sourceMessageIds || []) === signature);
    return memory ? structuredClone(memory) : null;
  }

  async addMessage(actor, input) {
    const content = String(input?.content ?? '').trim();
    if (content.length < 1 || content.length > 4000) throw new HttpError(400, 'Message must be 1-4000 characters.');
    return this.#withLock(async () => {
      const db = normalizeDb(await readJson(this.path, EMPTY_DISCUSSIONS));
      const message = {
        id: randomId('msg_'),
        authorUserId: actor.id,
        content,
        createdAt: nowIso(),
      };
      db.messages.push(message);
      await atomicWriteJson(this.path, db);
      return message;
    });
  }

  async addMemory(actor, input) {
    const title = String(input?.title ?? '').trim();
    const summary = String(input?.summary ?? '').trim();
    if (title.length < 2 || title.length > 120) throw new HttpError(400, 'Memory title must be 2-120 characters.');
    if (summary.length < 2 || summary.length > 3000) throw new HttpError(400, 'Memory summary must be 2-3000 characters.');
    return this.#withLock(async () => {
      const db = normalizeDb(await readJson(this.path, EMPTY_DISCUSSIONS));
      const sourceIds = new Set(Array.isArray(input.sourceMessageIds) ? input.sourceMessageIds.map(String) : []);
      const validSourceIds = db.messages.filter((message) => sourceIds.has(message.id)).map((message) => message.id);
      const sourceSignatureSha256 = memorySourceSignature(validSourceIds);
      const existing = db.memories.find((memory) => memory.sourceSignatureSha256 === sourceSignatureSha256
        || memorySourceSignature(memory.sourceMessageIds || []) === sourceSignatureSha256);
      if (existing) {
        existing.sourceSignatureSha256 = sourceSignatureSha256;
        await atomicWriteJson(this.path, db);
        return structuredClone(existing);
      }
      const memory = {
        id: randomId('mem_'),
        title,
        summary,
        keyPoints: normalizeStringArray(input.keyPoints, 8, 800),
        decisions: normalizeStringArray(input.decisions, 8, 800),
        followUps: normalizeStringArray(input.followUps, 8, 800),
        tags: normalizeStringArray(input.tags, 8, 40),
        sourceMessageIds: validSourceIds,
        sourceSignatureSha256,
        createdAt: nowIso(),
        createdByUserId: actor.id,
        ai: input.ai || null,
      };
      db.memories.push(memory);
      await atomicWriteJson(this.path, db);
      return memory;
    });
  }

  async #withLock(fn) {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }
}

function normalizeDb(db) {
  return {
    schemaVersion: 1,
    messages: Array.isArray(db?.messages) ? db.messages : [],
    memories: Array.isArray(db?.memories) ? db.memories : [],
  };
}

function memorySourceSignature(sourceMessageIds) {
  return sha256([...new Set((sourceMessageIds || []).map(String).filter(Boolean))].sort().join('\n'));
}

function normalizeStringArray(value, maxItems, maxLength) {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, maxItems)
    .map((item) => item.slice(0, maxLength));
}
