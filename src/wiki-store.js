import path from 'node:path';
import { atomicWriteJson, HttpError, nowIso, randomId, readJson } from './utils.js';

const EMPTY_WIKI = { schemaVersion: 1, entries: [] };
const STATUSES = new Set(['CANDIDATE', 'ACTIVE', 'ARCHIVED']);

export class WikiStore {
  constructor(dataDirectory) {
    this.path = path.join(dataDirectory, 'wiki.json');
    this.lock = Promise.resolve();
  }

  async initialize() {
    await this.#withLock(async () => {
      const db = await readJson(this.path, EMPTY_WIKI);
      if (!Array.isArray(db.entries)) throw new Error('Invalid wiki store.');
      await atomicWriteJson(this.path, db);
    });
  }

  async list({ status, limit = 100 } = {}) {
    const db = await readJson(this.path, EMPTY_WIKI);
    return db.entries
      .filter((entry) => !status || entry.status === status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, clamp(limit, 1, 500))
      .map((entry) => structuredClone(entry));
  }

  async search(query, { includeCandidates = false, limit = 8 } = {}) {
    const tokens = tokenize(query);
    if (!tokens.size) return [];
    const entries = await this.list({ limit: 500 });
    return entries
      .filter((entry) => entry.status === 'ACTIVE' || (includeCandidates && entry.status === 'CANDIDATE'))
      .map((entry) => ({ entry, score: scoreEntry(entry, tokens) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt))
      .slice(0, clamp(limit, 1, 30))
      .map(({ entry, score }) => ({ ...entry, relevance: score }));
  }

  async propose(actor, input) {
    const entry = normalizeEntry(input, actor.id);
    return this.#withLock(async () => {
      const db = await readJson(this.path, EMPTY_WIKI);
      const duplicate = db.entries.find((item) =>
        item.status !== 'ARCHIVED' && item.title.toLowerCase() === entry.title.toLowerCase() && item.content === entry.content);
      if (duplicate) return { entry: structuredClone(duplicate), duplicate: true };
      db.entries.push(entry);
      await atomicWriteJson(this.path, db);
      return { entry: structuredClone(entry), duplicate: false };
    });
  }

  async setStatus(id, actorUserId, status) {
    const normalized = String(status || '').toUpperCase();
    if (!STATUSES.has(normalized)) throw new HttpError(400, 'Invalid wiki entry status.');
    return this.#withLock(async () => {
      const db = await readJson(this.path, EMPTY_WIKI);
      const entry = db.entries.find((item) => item.id === id);
      if (!entry) throw new HttpError(404, 'Wiki entry not found.');
      entry.status = normalized;
      entry.updatedAt = nowIso();
      entry.statusChangedByUserId = actorUserId;
      await atomicWriteJson(this.path, db);
      return structuredClone(entry);
    });
  }

  #withLock(work) {
    const result = this.lock.then(work, work);
    this.lock = result.catch(() => {});
    return result;
  }
}

function normalizeEntry(input, actorUserId) {
  const title = String(input?.title || '').trim().replace(/\s+/g, ' ').slice(0, 160);
  const content = String(input?.content || '').trim().slice(0, 12_000);
  if (title.length < 3) throw new HttpError(400, 'Wiki title must be at least 3 characters.');
  if (content.length < 3) throw new HttpError(400, 'Wiki content must be at least 3 characters.');
  const at = nowIso();
  return {
    id: randomId('wiki_'),
    title,
    content,
    tags: [...new Set((Array.isArray(input.tags) ? input.tags : []).map((item) => String(item).trim().toLowerCase()).filter(Boolean))].slice(0, 20),
    status: 'CANDIDATE',
    evidence: (Array.isArray(input.evidence) ? input.evidence : []).map((item) => String(item).trim()).filter(Boolean).slice(0, 20),
    sourceExperienceId: input.sourceExperienceId ? String(input.sourceExperienceId) : null,
    createdByUserId: actorUserId,
    createdAt: at,
    updatedAt: at,
  };
}

function scoreEntry(entry, queryTokens) {
  const titleTokens = tokenize(entry.title);
  const bodyTokens = tokenize(`${entry.content}\n${entry.tags.join(' ')}`);
  let score = 0;
  for (const token of queryTokens) {
    if (titleTokens.has(token)) score += 5;
    if (bodyTokens.has(token)) score += 2;
  }
  return score;
}

function tokenize(value) {
  return new Set(String(value || '').toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((item) => item.length >= 2));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || min));
}
