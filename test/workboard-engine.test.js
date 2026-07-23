import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkboardEngine } from '../src/engine/workboard-engine.js';
import { renderStandaloneWorkboard } from '../src/engine/standalone-workboard.js';

test('workboard projection exposes board fields and keeps orchestration internals private', () => {
  const snapshot = new WorkboardEngine().createSnapshot({
    generatedAt: '2026-07-24T00:00:00.000Z',
    users: [{ id: 'usr_owner', name: 'Owner' }],
    tasks: [{
      id: 'tsk_private', title: 'Visible delivery', description: 'private prompt',
      status: 'IN_PROGRESS', priority: 10, assigneeUserId: 'usr_owner',
      allowedPaths: ['secret/**'], acceptanceCriteria: ['private criterion'],
      executor: { model: 'private-model' }, verification: { output: 'secret' },
      schedule: { plannedStart: '2026-07-24', plannedEnd: '2026-07-30' },
      artifacts: [{ name: 'result.pdf', contentType: 'application/pdf', size: 42, id: 'art_secret' }],
    }],
  });

  assert.equal(snapshot.tasks[0].assignee, 'Owner');
  assert.equal(snapshot.summary.IN_PROGRESS, 1);
  assert.deepEqual(snapshot.tasks[0].artifacts, [{ name: 'result.pdf', contentType: 'application/pdf', size: 42 }]);
  const serialized = JSON.stringify(snapshot);
  for (const secret of ['private prompt', 'secret/**', 'private criterion', 'private-model', 'art_secret']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('standalone renderer embeds escaped data and has no runtime dependency', () => {
  const snapshot = new WorkboardEngine().createSnapshot({
    title: '<Board>',
    tasks: [{ id: 'tsk_1', title: '</script><script>alert(1)</script>', status: 'READY' }],
  });
  const html = renderStandaloneWorkboard(snapshot);
  assert.match(html, /^<!doctype html>/);
  assert.equal(html.includes('</script><script>alert(1)</script>'), false);
  assert.equal(html.includes('fetch('), false);
  assert.match(html, /team-loop-workboard/);
});
