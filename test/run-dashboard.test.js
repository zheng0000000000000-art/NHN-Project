import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunDashboardStore } from '../src/run-dashboard.js';

test('run dashboard exposes compact read-only mode summaries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-dashboard-'));
  try {
    await mkdir(path.join(root, '.team-loop', 'results'), { recursive: true });
    await mkdir(path.join(root, '.team-loop', 'runs'), { recursive: true });
    await writeFile(path.join(root, '.team-loop', 'runs', 'doc.json'), JSON.stringify({ title: '제안서 작성' }));
    await writeFile(path.join(root, '.team-loop', 'results', 'doc.result.json'), JSON.stringify({
      runId: 'doc-run', verifiedAt: '2026-07-18T00:00:00Z', verdict: 'PASSED', documentPath: '.team-loop/runs/doc.json', documentMatch: true,
      mode: { requestedMode: 'AUTO', appliedMode: 'DOCUMENT', reason: 'document paths' },
      verificationPolicy: { appliedProfile: 'document-review', strength: 'TESTED' },
      skillPolicy: { selected: [{ id: 'document-grounding', rules: ['secret detail is not returned'] }], autoDisabled: ['scope-guard'] },
      scopeLease: { state: 'RELEASED_AFTER_PASS' }, verification: { checks: [{ stdout: 'not exposed' }] },
    }));
    const [summary] = await new RunDashboardStore({ workspaceRoot: root }).recent();
    assert.equal(summary.title, '제안서 작성');
    assert.equal(summary.mode.appliedMode, 'DOCUMENT');
    assert.deepEqual(summary.enabledSkills, ['document-grounding']);
    assert.equal(JSON.stringify(summary).includes('secret detail'), false);
    assert.equal(JSON.stringify(summary).includes('not exposed'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
