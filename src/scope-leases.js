import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { scopesOverlap } from './scope.js';
import { globMatch } from './verifier.js';
import { HttpError, nowIso, sha256 } from './utils.js';

const execFile = promisify(execFileCallback);

export class ScopeLeaseService {
  constructor({ workspaceRoot, now = () => Date.now() }) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.directory = path.join(this.workspaceRoot, '.team-loop', 'scopes');
    this.lockDirectory = path.join(this.workspaceRoot, '.team-loop', 'scope-lock');
    this.now = now;
  }

  async acquire(document, { owner, ttlMinutes = 120 } = {}) {
    return this.#withLock(async () => {
      const leases = await this.#activeLeases({ prune: true });
      const requestedOwner = String(owner || document.agent || process.env.USERNAME || process.env.USER || 'unknown').slice(0, 100);
      const documentSha256 = leaseDocumentHash(document);
      const existing = leases.find((item) => item.runId === document.id);
      if (existing) {
        if (existing.owner !== requestedOwner || existing.documentSha256 !== documentSha256) throw new HttpError(409, 'Run id is already leased by a different owner or document.', { existing });
        return { lease: existing, reused: true, conflicts: [] };
      }
      const writeScope = document.writeScope?.length ? document.writeScope : document.changes.map((item) => item.path);
      const workspaceFiles = await gitFiles(this.workspaceRoot);
      const conflicts = leases.filter((item) => scopeSetsConflict(writeScope, item.writeScope, workspaceFiles));
      if (conflicts.length) {
        throw new HttpError(409, `Write scope conflicts with active run(s): ${conflicts.map((item) => item.runId).join(', ')}`, { conflicts });
      }
      const acquiredAt = nowIso();
      const minutes = Math.max(1, Math.min(1440, Number(ttlMinutes) || 120));
      const lease = {
        schemaVersion: 1,
        runId: document.id,
        owner: requestedOwner,
        documentSha256,
        title: document.title,
        mode: document.mode,
        verificationProfile: document.verification?.profile || null,
        writeScope,
        readScope: document.readScope || [],
        interfaces: document.interfaces || [],
        baseRevision: await gitRevision(this.workspaceRoot),
        acquiredAt,
        expiresAt: new Date(this.now() + minutes * 60_000).toISOString(),
      };
      await mkdir(this.directory, { recursive: true });
      await writeFile(path.join(this.directory, `${document.id}.json`), `${JSON.stringify(lease, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      return { lease, reused: false, conflicts: [] };
    });
  }

  async list() { return this.#withLock(() => this.#activeLeases({ prune: true })); }

  async heartbeat(runId, { owner, ttlMinutes = 120 } = {}) {
    return this.#withLock(async () => {
      const file = path.join(this.directory, `${safeRunId(runId)}.json`);
      const lease = JSON.parse(await readFile(file, 'utf8'));
      if (owner && lease.owner !== owner) throw new HttpError(403, 'Only the lease owner can renew this scope.');
      const minutes = Math.max(1, Math.min(1440, Number(ttlMinutes) || 120));
      lease.heartbeatAt = new Date(this.now()).toISOString();
      lease.expiresAt = new Date(this.now() + minutes * 60_000).toISOString();
      await writeFile(file, `${JSON.stringify(lease, null, 2)}\n`, 'utf8');
      return lease;
    });
  }

  async release(runId, { reason = 'released', owner, force = false } = {}) {
    return this.#withLock(async () => {
      const file = path.join(this.directory, `${safeRunId(runId)}.json`);
      let lease = null;
      try { lease = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      if (lease && !force && (!owner || lease.owner !== owner)) throw new HttpError(403, 'Only the lease owner can release this scope.');
      if (lease) await rm(file, { force: true });
      return { released: Boolean(lease), reason, lease };
    });
  }

  async find(runId) { return (await this.list()).find((item) => item.runId === runId) || null; }

  async revisionStatus(lease) {
    const currentRevision = await gitRevision(this.workspaceRoot);
    if (!lease?.baseRevision || !currentRevision || lease.baseRevision === currentRevision) return { currentRevision, baseRevisionChanged: false, changedPaths: [] };
    const changedPaths = await gitDiffPaths(this.workspaceRoot, lease.baseRevision, currentRevision);
    return { currentRevision, baseRevisionChanged: true, changedPaths, touchesWriteScope: changedPaths.some((item) => lease.writeScope.some((pattern) => globMatch(pattern, item))) };
  }

  async #activeLeases({ prune }) {
    await mkdir(this.directory, { recursive: true });
    const files = (await readdir(this.directory)).filter((item) => item.endsWith('.json'));
    const active = [];
    for (const name of files) {
      const file = path.join(this.directory, name);
      let lease;
      try { lease = JSON.parse(await readFile(file, 'utf8')); } catch { continue; }
      if (Date.parse(lease.expiresAt) <= this.now()) { if (prune) await rm(file, { force: true }); continue; }
      active.push(lease);
    }
    return active.sort((a, b) => a.runId.localeCompare(b.runId));
  }

  async #withLock(action) {
    await mkdir(path.dirname(this.lockDirectory), { recursive: true });
    let acquired = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try { await mkdir(this.lockDirectory); acquired = true; break; }
      catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        try { if (this.now() - (await stat(this.lockDirectory)).mtimeMs > 30_000) await rm(this.lockDirectory, { recursive: true, force: true }); } catch {}
        await delay(25);
      }
    }
    if (!acquired) throw new HttpError(409, 'Scope lease registry is busy.');
    try { return await action(); } finally { await rm(this.lockDirectory, { recursive: true, force: true }); }
  }
}

async function gitRevision(root) {
  try { return (await execFile('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true })).stdout.trim(); }
  catch { return null; }
}
async function gitFiles(root) {
  try {
    const tracked = (await execFile('git', ['ls-files'], { cwd: root, windowsHide: true })).stdout.split(/\r?\n/);
    const untracked = (await execFile('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, windowsHide: true })).stdout.split(/\r?\n/);
    return [...new Set([...tracked, ...untracked].map((item) => item.trim().replaceAll('\\', '/')).filter(Boolean))];
  } catch { return []; }
}
async function gitDiffPaths(root, base, head) {
  try { return (await execFile('git', ['diff', '--name-only', base, head], { cwd: root, windowsHide: true })).stdout.split(/\r?\n/).map((item) => item.trim().replaceAll('\\', '/')).filter(Boolean); }
  catch { return []; }
}
function scopeSetsConflict(a, b, files) {
  if (!scopesOverlap(a, b)) return false;
  const exact = [...a, ...b].filter((item) => !/[?*]/.test(item));
  const candidates = [...new Set([...files, ...exact])];
  return candidates.some((file) => a.some((pattern) => globMatch(pattern, file)) && b.some((pattern) => globMatch(pattern, file)));
}
function leaseDocumentHash(document) { return sha256(JSON.stringify({ id: document.id, title: document.title, summary: document.summary, objective: document.objective, audience: document.audience, mode: document.mode, sharedContracts: document.sharedContracts, writeScope: document.writeScope, readScope: document.readScope, interfaces: document.interfaces, verification: document.verification })); }
function safeRunId(value) { const id = String(value || ''); if (!/^[a-z0-9][a-z0-9._-]{2,79}$/.test(id)) throw new HttpError(400, 'Invalid run id.'); return id; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
