import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { DiscussionStore } from '../src/discussions.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'team-loop-discussions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const discussions = new DiscussionStore(directory);
  await discussions.initialize();
  const actor = { id: 'usr_alice' };
  return { discussions, actor };
}

test('discussion memories deduplicate the same source message set', async (t) => {
  const { discussions, actor } = await fixture(t);
  const first = await discussions.addMessage(actor, { content: '첫 번째 논의' });
  const second = await discussions.addMessage(actor, { content: '두 번째 논의' });
  const sourceMessageIds = [first.id, second.id];

  const saved = await discussions.addMemory(actor, {
    title: '회의록',
    summary: '논의 요약',
    sourceMessageIds,
  });
  const duplicate = await discussions.addMemory(actor, {
    title: '회의록',
    summary: '다시 저장',
    sourceMessageIds: [...sourceMessageIds].reverse(),
  });

  assert.equal(duplicate.id, saved.id);
  assert.equal((await discussions.snapshot()).memories.length, 1);
});

test('callers can identify messages not yet covered by a memory', async (t) => {
  const { discussions, actor } = await fixture(t);
  const first = await discussions.addMessage(actor, { content: '이미 저장한 내용' });
  const second = await discussions.addMessage(actor, { content: '새 내용' });
  await discussions.addMemory(actor, {
    title: '기존 회의록',
    summary: '이미 저장한 내용',
    sourceMessageIds: [first.id],
  });

  const snapshot = await discussions.snapshot();
  const covered = new Set(snapshot.memories.flatMap((memory) => memory.sourceMessageIds || []));
  const unsaved = snapshot.messages.filter((message) => !covered.has(message.id));

  assert.deepEqual(unsaved.map((message) => message.id), [second.id]);
});
