import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWorkerConfig, selectExecutor } from '../src/executor-router.js';

const config = {
  routing: { allowRemote: true, remoteEscalationPriority: 80 },
  executors: [
    { id: 'ollama', tool: 'custom', model: 'qwen-coder', tier: 'local', weight: 80 },
    { id: 'strong', tool: 'codex', model: 'gpt-5', tier: 'remote', weight: 90 },
  ],
};

test('worker router prefers local execution for ordinary work', () => {
  assert.equal(selectExecutor({ priority: 30 }, config).candidate.id, 'ollama');
});

test('worker router escalates important work when remote use is allowed', () => {
  assert.equal(selectExecutor({ priority: 90 }, config).candidate.id, 'strong');
});

test('local-only policy never selects a remote executor', () => {
  assert.equal(selectExecutor({ priority: 100 }, config, { allowRemote: false }).candidate.id, 'ollama');
});

test('invalid executor records are discarded', () => {
  assert.deepEqual(normalizeWorkerConfig({ executors: [{ id: 'bad', tool: 'shell' }] }).executors, []);
});

test('an existing single executor profile remains usable as a remote fallback', () => {
  const result = selectExecutor({ priority: 20 }, { executor: { tool: 'claude-code', model: 'configured-model' } });
  assert.equal(result.candidate.id, 'legacy-default');
  assert.equal(result.executor.model, 'configured-model');
});

test('a user-selected executor overrides automatic weighting', () => {
  const result = selectExecutor({ priority: 100 }, config, { executorId: 'ollama' });
  assert.equal(result.candidate.id, 'ollama');
  assert.equal(result.reason, 'USER_SELECTED');
});
