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
