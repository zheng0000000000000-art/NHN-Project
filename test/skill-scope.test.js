import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SkillRegistry, ruleFromFailure } from '../src/skill-registry.js';
import { HarnessRegistry } from '../src/harness-registry.js';

// 한 프로젝트에서 승격된 지식이 다른 프로젝트 에이전트에게도 규칙으로 실리면 안 된다.
// 2026-07-27 관측: 경매 프로젝트의 심사 스킬 4개가 전역 스킬 목록에 섞여 있었다.
async function registryWith(skills) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'skill-scope-'));
  await writeFile(path.join(directory, 'skills.json'), JSON.stringify({ schemaVersion: 1, skills }), 'utf8');
  return { directory, registry: new SkillRegistry({ dataDirectory: directory }) };
}

const SKILLS = [
  { id: 'global-rule', label: 'g', status: 'ACTIVE', rules: [], scope: 'global' },
  { id: 'legacy-no-scope', label: 'l', status: 'ACTIVE', rules: [] },
  { id: 'auction-only', label: 'a', status: 'ACTIVE', rules: [], scope: 'unknown-auction' },
  { id: 'toolchain-only', label: 't', status: 'ACTIVE', rules: [], scope: 'team-loop-lite-ai-learning' },
];

test('a workspace sees global skills and its own, not another project\'s', async (t) => {
  const { directory, registry } = await registryWith(SKILLS);
  t.after(() => rm(directory, { recursive: true, force: true }));

  const ids = (await registry.list({ workspaceId: 'unknown-auction' })).map((item) => item.id);
  assert.deepEqual(ids, ['auction-only', 'global-rule', 'legacy-no-scope']);
  assert.ok(!ids.includes('toolchain-only'), 'another project rule must not leak in');
});

test('the other workspace gets the mirrored answer', async (t) => {
  const { directory, registry } = await registryWith(SKILLS);
  t.after(() => rm(directory, { recursive: true, force: true }));

  const ids = (await registry.list({ workspaceId: 'team-loop-lite-ai-learning' })).map((item) => item.id);
  assert.deepEqual(ids, ['global-rule', 'legacy-no-scope', 'toolchain-only']);
  assert.ok(!ids.includes('auction-only'));
});

// 소속을 안 주면 거르지 않는다. 관리 화면과 감사에는 전부 보여야 하기 때문이다.
test('omitting the workspace returns every skill, so audits still see all of them', async (t) => {
  const { directory, registry } = await registryWith(SKILLS);
  t.after(() => rm(directory, { recursive: true, force: true }));

  const ids = (await registry.list()).map((item) => item.id);
  assert.equal(ids.length, 4);
});

// 소속을 찍어놓고 기본값이 "전부"면 아무도 안 본다.
// 2026-07-27 실측: team-loop 태스크를 하나 만들었더니 unknown-auction 심사 스킬 4개가
// 자동 배정됐다. 레지스트리는 자기 workspace를 알고 있었는데 list()가 그것을 안 썼다.
test('a registry that knows its workspace filters by it without being asked', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'skill-scope-default-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'skills.json'), JSON.stringify({ schemaVersion: 1, skills: SKILLS }), 'utf8');

  const registry = new SkillRegistry({ dataDirectory: directory, workspaceId: 'team-loop-lite-ai-learning' });
  const ids = (await registry.list()).map((item) => item.id);
  assert.ok(!ids.includes('auction-only'), 'another project rule must not leak into the default listing');
  assert.deepEqual(ids, ['global-rule', 'legacy-no-scope', 'toolchain-only']);
});

// 감사와 승격 중복 판정은 전부 봐야 한다. 다만 명시해야 한다 — 기본이 "전부"면 새 호출부가 샌다.
test('allScopes is how you opt into seeing every workspace', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'skill-scope-all-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'skills.json'), JSON.stringify({ schemaVersion: 1, skills: SKILLS }), 'utf8');

  const registry = new SkillRegistry({ dataDirectory: directory, workspaceId: 'team-loop-lite-ai-learning' });
  assert.equal((await registry.list({ allScopes: true })).length, 4);
});

// 하네스도 같은 기본값이어야 한다. 한쪽만 고치면 그쪽으로 샌다.
test('the harness registry defaults to its own workspace too', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'harness-scope-default-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'harnesses.json'), JSON.stringify({
    schemaVersion: 1,
    harnesses: [
      { id: 'global-check', status: 'ACTIVE', commands: [], scope: 'global' },
      { id: 'auction-check', status: 'ACTIVE', commands: [], scope: 'unknown-auction' },
    ],
  }), 'utf8');

  const registry = new HarnessRegistry({ dataDirectory: directory, workspaceRoot: directory, workspaceId: 'team-loop-lite-ai-learning' });
  const ids = (await registry.list()).map((item) => item.id);
  assert.deepEqual(ids, ['global-check']);
  assert.equal((await registry.list({ allScopes: true })).length, 2);
});

// scope가 없는 기존 기록을 조용히 감추면 규칙이 사라진 것을 아무도 모른다.
test('a record without a scope stays visible instead of silently disappearing', () => {
  assert.equal(SkillRegistry.visibleIn({ id: 'x' }, 'unknown-auction'), true);
  assert.equal(SkillRegistry.visibleIn({ id: 'x', scope: 'global' }, 'unknown-auction'), true);
  assert.equal(SkillRegistry.visibleIn({ id: 'x', scope: 'other' }, 'unknown-auction'), false);
  assert.equal(SkillRegistry.visibleIn({ id: 'x', scope: 'other' }, null), false);
});

// 승격이 소속을 안 찍으면 다음 실패 하나로 오염이 돌아온다.
test('a skill promoted from failure is stamped with the workspace it came from', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'skill-scope-promote-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'skills.json'), JSON.stringify({ schemaVersion: 1, skills: [] }), 'utf8');

  const registry = new SkillRegistry({ dataDirectory: directory, workspaceId: 'unknown-auction' });
  const created = await registry.createFromFailures(
    { id: 'usr_test' },
    { id: 'derived-rule', label: 'Derived', rules: ['do not repeat the failure'] },
    [{ id: 'fail_1', title: 'boom' }],
  );

  assert.equal(created.scope, 'unknown-auction');
  const leaked = (await registry.list({ workspaceId: 'team-loop-lite-ai-learning' })).map((item) => item.id);
  assert.ok(!leaked.includes('derived-rule'), 'a failure from one project must not become another project\'s rule');
});

// 하네스도 같은 규칙이다 — 한 프로젝트의 실패에서 나온 검사가 다른 프로젝트에 실리면 안 된다.
test('harness scope hides another project\'s checks and stamps promoted ones', () => {
  assert.equal(HarnessRegistry.visibleIn({ id: 'h' }, 'unknown-auction'), true);
  assert.equal(HarnessRegistry.visibleIn({ id: 'h', scope: 'global' }, 'unknown-auction'), true);
  assert.equal(HarnessRegistry.visibleIn({ id: 'h', scope: 'unknown-auction' }, 'unknown-auction'), true);
  assert.equal(HarnessRegistry.visibleIn({ id: 'h', scope: 'unknown-auction' }, 'team-loop-lite-ai-learning'), false);
});

// 한 번의 위반에서 나온 파일 이름이 영구 규칙이 되면 위반마다 거의 같은 스킬이 새로 생긴다.
test('a scope violation produces a reusable rule, not a file name', () => {
  const rule = ruleFromFailure({ kind: 'SCOPE_VIOLATION', title: 't', lastEvidence: { path: 'src/cli/args.js' } });
  assert.ok(!rule.includes('src/cli/args.js'), 'the offending path must stay in the failure case, not the rule');
  assert.ok(rule.includes('allowedPaths'));
});

// 객체가 규칙으로 들어오면 String()이 "[object Object]"를 만들어 영구 규칙에 박힌다.
test('a non-string rule is dropped instead of becoming "[object Object]"', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'skill-rule-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'skills.json'), JSON.stringify({ schemaVersion: 1, skills: [] }), 'utf8');

  const registry = new SkillRegistry({ dataDirectory: directory });
  const created = await registry.createFromFailures(
    { id: 'usr_test' },
    { id: 'junk-rule', label: 'Junk', rules: [{ nested: 'object' }, 'a real rule'] },
    [{ id: 'fail_1', title: 'boom' }],
  );
  assert.ok(!created.rules.includes('[object Object]'));
  assert.ok(created.rules.includes('a real rule'));
});
