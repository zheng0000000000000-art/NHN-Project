import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeExecutorInput, mergeCliExecutor } from '../src/executor.js';

test('sanitizeExecutorInput normalizes and stamps the executor with actor and time', () => {
  const out = sanitizeExecutorInput(
    { tool: '  claude-code ', model: 'claude-opus-4-8', harness: 'repository-basic', skills: ['scope-guard', 'scope-guard', 'no-todo'] },
    { actorUserId: 'usr_1', at: '2026-01-01T00:00:00.000Z' },
  );
  assert.deepEqual(out, {
    tool: 'claude-code',
    model: 'claude-opus-4-8',
    harness: 'repository-basic',
    skills: ['scope-guard', 'no-todo'],
    setByUserId: 'usr_1',
    setAt: '2026-01-01T00:00:00.000Z',
  });
});

test('sanitizeExecutorInput returns null when no usable fields are present', () => {
  assert.equal(sanitizeExecutorInput(null), null);
  assert.equal(sanitizeExecutorInput(undefined), null);
  assert.equal(sanitizeExecutorInput({}), null);
  assert.equal(sanitizeExecutorInput({ skills: [] }), null);
  assert.equal(sanitizeExecutorInput({ tool: '   ' }), null);
});

test('sanitizeExecutorInput clamps oversized fields and caps skill count', () => {
  const out = sanitizeExecutorInput(
    { tool: 'x'.repeat(200), skills: Array.from({ length: 50 }, (_, i) => `s${i}`) },
    { actorUserId: 'usr_2', at: '2026-01-02T00:00:00.000Z' },
  );
  assert.equal(out.tool.length, 40);
  assert.equal(out.skills.length, 20);
  assert.equal(out.model, null);
});

test('sanitizeExecutorInput rejects non-object input with a 400 error', () => {
  assert.throws(() => sanitizeExecutorInput('claude'), (error) => {
    assert.match(error.message, /executor must be an object/);
    assert.equal(error.statusCode, 400);
    return true;
  });
  assert.throws(() => sanitizeExecutorInput(['claude']), /executor must be an object/);
});

test('mergeCliExecutor combines the executor block and defaults block from config', () => {
  assert.deepEqual(
    mergeCliExecutor({ executor: { tool: 'codex', model: 'gpt-5' }, defaults: { harness: 'node-project', skills: ['s1', 's2'] } }),
    { tool: 'codex', model: 'gpt-5', harness: 'node-project', skills: ['s1', 's2'] },
  );
});

test('mergeCliExecutor returns null when config is empty or missing', () => {
  assert.equal(mergeCliExecutor(null), null);
  assert.equal(mergeCliExecutor({}), null);
  assert.equal(mergeCliExecutor({ executor: {}, defaults: {} }), null);
});

test('sanitizeExecutorInput accepts what mergeCliExecutor produces (round trip)', () => {
  const merged = mergeCliExecutor({ executor: { tool: 'claude-code', model: 'm' }, defaults: { skills: ['a'] } });
  const stored = sanitizeExecutorInput(merged, { actorUserId: 'usr_3', at: '2026-01-03T00:00:00.000Z' });
  assert.equal(stored.tool, 'claude-code');
  assert.equal(stored.model, 'm');
  assert.deepEqual(stored.skills, ['a']);
  assert.equal(stored.setByUserId, 'usr_3');
});
