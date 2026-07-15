import test from 'node:test';
import assert from 'node:assert/strict';
import { scopePrefix, prefixCovers, scopesOverlap } from '../src/scope.js';

test('scopePrefix reduces a glob to its literal prefix', () => {
  assert.equal(scopePrefix('src/cli/**'), 'src/cli');
  assert.equal(scopePrefix('server.js'), 'server.js');
  assert.equal(scopePrefix('**'), '');
  assert.equal(scopePrefix('src/*.js'), 'src');
  assert.equal(scopePrefix('./public/index.html'), 'public/index.html');
  assert.equal(scopePrefix('a\\b\\**'), 'a/b');
});

test('prefixCovers treats empty as everything and respects path boundaries', () => {
  assert.equal(prefixCovers('', 'anything/at/all'), true);
  assert.equal(prefixCovers('src/cli', 'src/cli'), true);
  assert.equal(prefixCovers('src/cli', 'src/cli/main.js'), true);
  assert.equal(prefixCovers('src/cli', 'src/client.js'), false); // sibling-prefix, not covered
  assert.equal(prefixCovers('src/cli', 'src'), false);
});

test('scopesOverlap detects tasks that could touch a common file', () => {
  assert.equal(scopesOverlap(['src/cli/**'], ['src/cli/main.js']), true);
  assert.equal(scopesOverlap(['**'], ['server.js']), true);
  assert.equal(scopesOverlap(['server.js'], ['server.js']), true);
});

test('scopesOverlap returns false for disjoint scopes', () => {
  assert.equal(scopesOverlap(['src/ai.js'], ['server.js', 'src/cli/**', 'src/executor.js']), false);
  assert.equal(scopesOverlap(['public/index.html'], ['src/ai.js']), false);
  assert.equal(scopesOverlap(['src/cli/**'], ['src/client.js']), false); // sibling prefix must not match
});

test('scopesOverlap is safe on empty or non-array input', () => {
  assert.equal(scopesOverlap([], ['server.js']), false);
  assert.equal(scopesOverlap(undefined, undefined), false);
});
