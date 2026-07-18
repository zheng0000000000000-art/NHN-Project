import path from 'node:path';
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { HttpError, nowIso } from './utils.js';

export class RunLedger {
  constructor({ workspaceRoot }) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.root = path.join(this.workspaceRoot, '.team-loop', 'results');
  }

  async append(runId, result) {
    return this.#withLock(runId, async () => {
      const directory = this.#runDirectory(runId);
      await mkdir(directory, { recursive: true });
      await this.#migrateLegacy(runId, directory);
      const attempts = await this.#attemptFiles(directory);
      const attempt = attempts.length ? Math.max(...attempts.map(attemptNumber)) + 1 : 1;
      const value = { ...result, schemaVersion: 2, attempt };
      const name = attemptName(attempt);
      const absolute = path.join(directory, name);
      await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await writeFile(path.join(directory, 'latest.json'), `${JSON.stringify({ runId, attempt, resultPath: slash(path.relative(this.workspaceRoot, absolute)), verdict: value.verdict, verifiedAt: value.verifiedAt }, null, 2)}\n`, 'utf8');
      return { result: value, resultPath: slash(path.relative(this.workspaceRoot, absolute)) };
    });
  }

  async latest(runId) {
    const directory = this.#runDirectory(runId);
    try {
      const pointer = JSON.parse(await readFile(path.join(directory, 'latest.json'), 'utf8'));
      return JSON.parse(await readFile(path.join(this.workspaceRoot, pointer.resultPath), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async recordEvent(runId, event) {
    const directory = this.#runDirectory(runId);
    await mkdir(directory, { recursive: true });
    await appendFile(path.join(directory, 'events.jsonl'), `${JSON.stringify({ at: nowIso(), ...event })}\n`, 'utf8');
  }

  async events(runId) {
    try { return (await readFile(path.join(this.#runDirectory(runId), 'events.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse); }
    catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  }

  #runDirectory(runId) { return path.join(this.root, safeRunId(runId)); }
  async #attemptFiles(directory) { return (await readdir(directory)).filter((item) => /^attempt-\d{6}\.json$/.test(item)); }
  async #migrateLegacy(runId, directory) {
    const legacy = path.join(this.root, `${runId}.result.json`);
    let value;
    try { value = JSON.parse(await readFile(legacy, 'utf8')); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    if ((await this.#attemptFiles(directory)).length === 0) {
      value = { ...value, schemaVersion: 2, attempt: 1, migratedFrom: slash(path.relative(this.workspaceRoot, legacy)) };
      const target = path.join(directory, attemptName(1));
      await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await writeFile(path.join(directory, 'latest.json'), `${JSON.stringify({ runId, attempt: 1, resultPath: slash(path.relative(this.workspaceRoot, target)), verdict: value.verdict, verifiedAt: value.verifiedAt }, null, 2)}\n`, 'utf8');
    }
  }
  async #withLock(runId, action) {
    await mkdir(this.root, { recursive: true });
    const lock = path.join(this.root, `.lock-${safeRunId(runId)}`);
    let acquired = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try { await mkdir(lock); acquired = true; break; } catch (error) { if (error?.code !== 'EEXIST') throw error; await delay(25); }
    }
    if (!acquired) throw new HttpError(409, `Run ledger is busy: ${runId}`);
    try { return await action(); } finally { await rm(lock, { recursive: true, force: true }); }
  }
}

function attemptName(value) { return `attempt-${String(value).padStart(6, '0')}.json`; }
function attemptNumber(value) { return Number(value.match(/\d{6}/)?.[0] || 0); }
function safeRunId(value) { const id = String(value || ''); if (!/^[a-z0-9][a-z0-9._-]{2,79}$/.test(id)) throw new HttpError(400, 'Invalid run id.'); return id; }
function slash(value) { return String(value).replaceAll('\\', '/'); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
