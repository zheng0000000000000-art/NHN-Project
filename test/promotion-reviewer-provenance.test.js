import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// resolvePromotionReview must derive the producing profile(s) by walking
// promotion.sourceFailureCaseIds -> failureCase.taskIds -> task.executorProfileId,
// never by falling back to a configured default executor.
async function setUp(t) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'team-loop-promo-reviewer-'));
  await writeFile(path.join(dataDirectory, 'tasks.json'), JSON.stringify({
    schemaVersion: 1,
    tasks: [
      { id: 'task-other', executorProfileId: 'profile-other' },
      { id: 'task-local', executorProfileId: 'test-local' },
      { id: 'task-mixed-a', executorProfileId: 'profile-other' },
      { id: 'task-mixed-b', executorProfileId: 'test-local' },
      { id: 'task-no-executor' },
    ],
  }, null, 2));
  await writeFile(path.join(dataDirectory, 'failure-cases.json'), JSON.stringify({
    schemaVersion: 1,
    cases: [
      { id: 'fail-other', taskIds: ['task-other'] },
      { id: 'fail-local', taskIds: ['task-local'] },
      { id: 'fail-mixed', taskIds: ['task-mixed-a', 'task-mixed-b'] },
      { id: 'fail-unresolved-task', taskIds: ['task-no-executor'] },
      { id: 'fail-missing-task', taskIds: ['task-does-not-exist'] },
    ],
  }, null, 2));

  process.env.HOST = '127.0.0.1';
  process.env.PORT = '0';
  process.env.DATA_DIR = dataDirectory;
  process.env.WORKSPACE_ROOT = path.resolve('.');
  process.env.TEAM_LOOP_CLI_HOME = path.resolve('test/fixtures/cli-home');
  process.env.SIGNUP_CODE = 'test-signup-code';
  process.env.TEAM_LOOP_IDLE_VERIFY = 'off';

  const mod = await import(`../server.js?promo-reviewer-provenance=${randomToken()}`);
  await new Promise((resolve) => {
    if (mod.server.listening) resolve();
    else mod.server.once('listening', resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => mod.server.close(resolve));
    await rm(dataDirectory, { recursive: true, force: true });
  });
  return mod.resolvePromotionReview;
}

function randomToken() {
  return Math.random().toString(36).slice(2);
}

test('a producer resolved from the failure-case/task chain that differs from the reviewer is independent', async (t) => {
  const resolvePromotionReview = await setUp(t);
  const result = await resolvePromotionReview({ artifact: { sourceFailureCaseIds: ['fail-other'] } });
  assert.equal(result.independent, true);
  assert.equal(result.reason, null);
  assert.equal(result.reviewerProfileId, 'test-local');
  assert.deepEqual(result.producerProfileIds, ['profile-other']);
});

test('a producer resolved from the chain that matches the reviewer is not independent', async (t) => {
  const resolvePromotionReview = await setUp(t);
  const result = await resolvePromotionReview({ artifact: { sourceFailureCaseIds: ['fail-local'] } });
  assert.equal(result.independent, false);
  assert.equal(result.reason, 'SAME_PROFILE_FALLBACK');
  assert.equal(result.reviewerProfileId, 'test-local');
  assert.deepEqual(result.producerProfileIds, ['test-local']);
});

test('several tasks contribute distinct producers, and a reviewer matching any of them is not independent', async (t) => {
  const resolvePromotionReview = await setUp(t);
  const result = await resolvePromotionReview({ artifact: { sourceFailureCaseIds: ['fail-mixed'] } });
  assert.equal(result.independent, false);
  assert.equal(result.reason, 'SAME_PROFILE_FALLBACK');
  assert.deepEqual(new Set(result.producerProfileIds), new Set(['profile-other', 'test-local']));
});

test('an unresolvable producer is reported unknown instead of assumed independent', async (t) => {
  const resolvePromotionReview = await setUp(t);

  // No source failure cases at all (e.g. a derived artifact with nothing recorded).
  const empty = await resolvePromotionReview({ artifact: { sourceFailureCaseIds: [] } });
  assert.equal(empty.independent, false);
  assert.equal(empty.reason, 'PRODUCER_UNKNOWN');
  assert.equal(empty.reviewerProfileId, null);
  assert.deepEqual(empty.producerProfileIds, []);

  // A task with no executorProfileId cannot be used as a fixture here: initializeAiProfiles
  // backfills every such task from the configured defaults while the server boots, so the
  // unresolvable case has to come from a link that resolves to no task at all.

  // The failure case points at a task id that no longer resolves.
  const missingTask = await resolvePromotionReview({ artifact: { sourceFailureCaseIds: ['fail-missing-task'] } });
  assert.equal(missingTask.independent, false);
  assert.equal(missingTask.reason, 'PRODUCER_UNKNOWN');
  assert.deepEqual(missingTask.producerProfileIds, []);
});

test('an unresolvable producer is never reported independent via a config default, even when the config default would differ from the reviewer', async (t) => {
  // The test fixture config (test/fixtures/cli-home/config.json) has no legacy
  // `executor.id` field, only an `executors` array -- so the old
  // `config?.executor?.id` fallback always evaluated to '', which the old
  // implementation then reported as independent of the single "test-local"
  // reviewer. The fix must refuse to guess and report PRODUCER_UNKNOWN instead.
  const resolvePromotionReview = await setUp(t);
  const result = await resolvePromotionReview({ artifact: { sourceFailureCaseIds: [] } });
  assert.equal(result.independent, false);
  assert.equal(result.reason, 'PRODUCER_UNKNOWN');
});
