import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DiscussionStore } from '../src/discussions.js';

// 읽었는지 안 보이면 이 채널을 믿고 쓸 수 없다. 사용자가 요청한 기능이다.
async function storeWith(messages) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'discussion-read-'));
  await writeFile(path.join(directory, 'discussions.json'),
    JSON.stringify({ schemaVersion: 1, messages, memories: [] }), 'utf8');
  return { directory, store: new DiscussionStore(directory) };
}

const MESSAGES = [
  { id: 'msg_a', authorUserId: 'usr_human', content: 'hello', createdAt: '2026-07-27T00:00:00.000Z' },
  { id: 'msg_b', authorUserId: 'usr_claude_coordinator', content: 'reply', createdAt: '2026-07-27T00:01:00.000Z' },
];

test('reading marks the other side\'s messages and records who and when', async (t) => {
  const { directory, store } = await storeWith(structuredClone(MESSAGES));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = await store.markRead('usr_claude_coordinator');
  assert.deepEqual(result.marked, ['msg_a']);

  const snapshot = await store.snapshot();
  const read = snapshot.messages.find((item) => item.id === 'msg_a');
  assert.equal(read.readBy.length, 1);
  assert.equal(read.readBy[0].userId, 'usr_claude_coordinator');
  assert.ok(read.readBy[0].at, 'the time it was read must be recorded');
});

// 자기 글을 읽음으로 찍으면 표시가 무의미해진다.
test('a reader never marks their own message as read', async (t) => {
  const { directory, store } = await storeWith(structuredClone(MESSAGES));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await store.markRead('usr_claude_coordinator');
  const snapshot = await store.snapshot();
  const own = snapshot.messages.find((item) => item.id === 'msg_b');
  assert.ok(!Array.isArray(own.readBy) || own.readBy.length === 0);
});

// 처음 읽은 시각이 의미 있는 값이라 다시 읽어도 덮어쓰지 않는다.
test('reading twice keeps the first timestamp instead of duplicating', async (t) => {
  const { directory, store } = await storeWith(structuredClone(MESSAGES));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await store.markRead('usr_claude_coordinator');
  const first = (await store.snapshot()).messages.find((item) => item.id === 'msg_a').readBy[0].at;
  const again = await store.markRead('usr_claude_coordinator');
  assert.deepEqual(again.marked, []);
  const after = (await store.snapshot()).messages.find((item) => item.id === 'msg_a').readBy;
  assert.equal(after.length, 1);
  assert.equal(after[0].at, first);
});

// 특정 메시지만 지정해 읽을 수 있어야 부분 확인이 가능하다.
test('a reader can mark only the messages they name', async (t) => {
  const { directory, store } = await storeWith([
    ...structuredClone(MESSAGES),
    { id: 'msg_c', authorUserId: 'usr_human', content: 'later', createdAt: '2026-07-27T00:02:00.000Z' },
  ]);
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = await store.markRead('usr_claude_coordinator', ['msg_c']);
  assert.deepEqual(result.marked, ['msg_c']);
  const snapshot = await store.snapshot();
  assert.ok(!snapshot.messages.find((item) => item.id === 'msg_a').readBy?.length);
});
