import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';

export class RunDashboardStore {
  constructor({ workspaceRoot }) { this.workspaceRoot = path.resolve(workspaceRoot); }

  async recent({ limit = 8 } = {}) {
    const directory = path.join(this.workspaceRoot, '.team-loop', 'results');
    let names;
    try { names = await readdir(directory); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
    const results = [];
    for (const name of names) {
      try {
        let result;
        if (name.endsWith('.result.json')) result = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
        else {
          const pointer = JSON.parse(await readFile(path.join(directory, name, 'latest.json'), 'utf8'));
          result = JSON.parse(await readFile(path.join(this.workspaceRoot, pointer.resultPath), 'utf8'));
        }
        let lifecycle = null;
        try { lifecycle = (await readFile(path.join(directory, result.runId, 'events.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse).at(-1) || null; } catch {}
        let title = result.runId;
        try { title = JSON.parse(await readFile(path.join(this.workspaceRoot, result.documentPath), 'utf8')).title || title; } catch {}
        results.push({
          runId: result.runId, attempt: result.attempt || 1, title, verifiedAt: result.verifiedAt, verdict: result.verdict,
          mode: result.mode || { requestedMode: 'AUTO', appliedMode: 'CODE', reason: 'legacy result without mode metadata' },
          profile: result.verificationPolicy?.appliedProfile || result.verification?.profile || null,
          strength: result.verificationPolicy?.strength || null,
          enabledSkills: (result.skillPolicy?.selected || []).map((item) => item.id),
          autoDisabledSkills: result.skillPolicy?.autoDisabled || [],
          scopeState: lifecycle?.type || result.scopeLease?.state || 'UNKNOWN',
          landedCommit: lifecycle?.type === 'LANDED' ? lifecycle.commit : null,
          documentMatch: Boolean(result.documentMatch),
        });
      } catch {}
    }
    const latestByRun = new Map(results.sort((a, b) => String(a.verifiedAt).localeCompare(String(b.verifiedAt))).map((item) => [item.runId, item]));
    return [...latestByRun.values()].sort((a, b) => String(b.verifiedAt).localeCompare(String(a.verifiedAt))).slice(0, Math.max(1, Math.min(30, Number(limit) || 8)));
  }
}
