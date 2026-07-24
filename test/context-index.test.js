import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ContextIndex } from '../src/context-index.js';

test('context index retrieves relevant chunks within a fixed budget', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'team-loop-index-'));
  try {
    await mkdir(path.join(directory, 'docs'));
    await mkdir(path.join(directory, 'src'));
    await writeFile(path.join(directory, 'docs', 'AUTH.md'), '세션 쿠키와 로그인 인증 규칙입니다. secure cookie 설정을 확인합니다.');
    await writeFile(path.join(directory, 'src', 'billing.js'), 'export function calculateInvoice() { return "billing"; }');
    await mkdir(path.join(directory, 'data'));
    await writeFile(path.join(directory, 'data', 'secret.json'), '{"token":"private"}');

    const index = new ContextIndex({ workspaceRoot: directory, chunkChars: 80 });
    const status = await index.initialize();
    assert.equal(status.indexedFiles, 2);
    assert.equal(status.chunks >= 2, true);

    const result = index.search('로그인 세션 쿠키 인증', { maxChunks: 2, maxCharacters: 120 });
    assert.equal(result.sourceCount, 1);
    assert.equal(result.sources[0].path, 'docs/AUTH.md');
    assert.match(result.sources[0].text, /세션 쿠키/);
    assert.equal(result.characters <= 120, true);
    assert.equal(JSON.stringify(result).includes('private'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('context index returns an empty pack for a query with no useful tokens', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'team-loop-index-empty-'));
  try {
    await writeFile(path.join(directory, 'README.md'), 'project overview');
    const index = new ContextIndex({ workspaceRoot: directory });
    await index.initialize();
    assert.equal(index.search('the and for').sourceCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('documentation archive is excluded by default and available only as marked historical context', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'team-loop-index-archive-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'docs', 'archive', 'legacy-guides'), { recursive: true });
  await writeFile(path.join(directory, 'docs', 'CURRENT.md'), 'promotion policy uses probation and rollback');
  await writeFile(path.join(directory, 'docs', 'archive', 'legacy-guides', 'OLD.md'), 'promotion policy required external manual approval');
  const index = new ContextIndex({ workspaceRoot: directory });
  const status = await index.initialize();
  assert.equal(status.indexedFiles, 1);
  assert.equal(status.archive.indexedFiles, 1);
  assert.equal(status.archive.defaultExcluded, true);

  const current = index.search('promotion policy');
  assert.deepEqual(current.sources.map((item) => item.path), ['docs/CURRENT.md']);
  assert.equal(current.historical, false);
  assert.equal(current.warning, null);

  const historical = index.search('promotion policy', { historical: true });
  assert.deepEqual(historical.sources.map((item) => item.path), ['docs/archive/legacy-guides/OLD.md']);
  assert.equal(historical.sources[0].historical, true);
  assert.equal(historical.historical, true);
  assert.match(historical.warning, /superseded/);
});
