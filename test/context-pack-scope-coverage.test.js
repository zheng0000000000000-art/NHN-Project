import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ContextIndex } from '../src/context-index.js';

// 실측: 기록된 컨텍스트 팩 34건 중 21건이, 작업이 고쳐야 할 파일을 빼고 이웃만 담았다.
// 검색이 질의어 관련도만 보기 때문이다. 경로가 질의에 섞여 있어도 흔한 낱말로 쪼개져
// 상위에 오르지 못한다. 실제 사례(ctx_95d2a86a6d385d3c5ce2)는 server.js를 빠뜨리고
// docs/SECURITY.md와 낡은 결과 JSON을 담았다.
async function workspace() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'team-loop-scope-'));
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'docs'));
  // 질의어와 겹치는 이웃들. 관련도만 보면 이쪽이 이긴다.
  await writeFile(path.join(dir, 'docs', 'a.md'), '세션 쿠키 인증 로그인 규칙 세션 쿠키 인증');
  await writeFile(path.join(dir, 'docs', 'b.md'), '세션 쿠키 인증 절차 문서 세션 쿠키');
  // 정작 고쳐야 할 파일. 질의어를 거의 안 담고 있다.
  await writeFile(path.join(dir, 'src', 'target.js'), 'export function untouched() { return 1; }');
  return dir;
}

const QUERY = '세션 쿠키 인증 로그인';

test('relevance alone leaves the file the work must edit out of the pack', async () => {
  const dir = await workspace();
  try {
    const index = new ContextIndex({ workspaceRoot: dir, chunkChars: 200 });
    await index.initialize();
    const result = index.search(QUERY, { maxChunks: 2, maxCharacters: 4000 });
    assert.ok(!result.sources.some((item) => item.path === 'src/target.js'),
      'this is the defect being fixed — if it stops reproducing, the fixture drifted');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a file in the write scope is carried into the pack ahead of neighbours', async () => {
  const dir = await workspace();
  try {
    const index = new ContextIndex({ workspaceRoot: dir, chunkChars: 200 });
    await index.initialize();
    const result = index.search(QUERY, { maxChunks: 2, maxCharacters: 4000, pinnedPaths: ['src/target.js'] });
    assert.ok(result.sources.some((item) => item.path === 'src/target.js'));
    assert.equal(result.sources[0].path, 'src/target.js', 'what must be edited comes first');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pinning spends the same budget rather than quietly enlarging it', async () => {
  const dir = await workspace();
  try {
    const index = new ContextIndex({ workspaceRoot: dir, chunkChars: 200 });
    await index.initialize();
    const options = { maxChunks: 2, maxCharacters: 4000 };
    const before = index.search(QUERY, options);
    const after = index.search(QUERY, { ...options, pinnedPaths: ['src/target.js'] });
    assert.equal(after.sources.length, before.sources.length, 'the chunk ceiling still holds');
    assert.ok(after.characters <= 4000);
    // 예산이 같으므로 고칠 파일이 들어온 만큼 이웃 하나가 밀려야 한다.
    assert.ok(after.sources.some((item) => item.path === 'src/target.js'));
    assert.ok(before.sources.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a glob scope pins nothing, because there is no one file to carry', async () => {
  const dir = await workspace();
  try {
    const index = new ContextIndex({ workspaceRoot: dir, chunkChars: 200 });
    await index.initialize();
    const result = index.search(QUERY, { maxChunks: 2, maxCharacters: 4000, pinnedPaths: ['**', 'src/*.js'] });
    assert.ok(!result.sources.some((item) => item.path === 'src/target.js'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a scope path that is not indexed is skipped instead of throwing', async () => {
  const dir = await workspace();
  try {
    const index = new ContextIndex({ workspaceRoot: dir, chunkChars: 200 });
    await index.initialize();
    const result = index.search(QUERY, { maxChunks: 2, maxCharacters: 4000, pinnedPaths: ['src/does-not-exist.js', ''] });
    assert.ok(result.sources.length > 0, 'the rest of the pack is still assembled');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the scope reaches the pack even when the query matches nothing', async () => {
  const dir = await workspace();
  try {
    const index = new ContextIndex({ workspaceRoot: dir, chunkChars: 200 });
    await index.initialize();
    const result = index.search('', { maxChunks: 2, maxCharacters: 4000, pinnedPaths: ['src/target.js'] });
    assert.deepEqual(result.sources.map((item) => item.path), ['src/target.js'],
      'an empty query used to return nothing at all');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the pack builder actually hands the write scope to the index', async () => {
  const source = await readFile('src/experience-engine.js', 'utf8');
  assert.match(source, /pinnedPaths: descriptor\.allowedPaths/,
    'without this the retrieval never learns which files the work must change');
});
