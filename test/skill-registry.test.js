import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { SkillRegistry } from '../src/skill-registry.js';

async function fixture(t, seed) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-skill-'));
  const data = path.join(root, 'data');
  const seedPath = path.join(root, 'learning-seeds.json');
  await writeFile(seedPath, JSON.stringify(seed));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, data, seedPath };
}

test('registry imports seeded skills as active built-ins', async (t) => {
  const { data, seedPath } = await fixture(t, {
    schemaVersion: 1,
    skills: {
      'failure-corpus-discipline': {
        label: 'Failure corpus discipline',
        description: 'Keep failure learning event-level.',
        rules: ['Record one logical failure event as one case.'],
      },
    },
  });
  const registry = new SkillRegistry({ dataDirectory: data, seedSkillPath: seedPath });
  await registry.initialize();

  const skill = await registry.get('failure-corpus-discipline');
  assert.equal(skill.status, 'ACTIVE');
  assert.equal(skill.source, 'BUILTIN');
  assert.deepEqual(await registry.activeIds(), ['failure-corpus-discipline']);
});

test('seeded skills promote matching imported local skills to built-ins', async (t) => {
  const { data, seedPath } = await fixture(t, {
    schemaVersion: 1,
    skills: {
      'failure-corpus-discipline': {
        label: 'Failure corpus discipline',
        description: 'Keep failure learning event-level.',
        rules: ['Record one logical failure event as one case.'],
      },
    },
  });
  await mkdir(data, { recursive: true });
  await writeFile(path.join(data, 'skills.json'), JSON.stringify({
    schemaVersion: 1,
    skills: [{
      id: 'failure-corpus-discipline',
      label: 'Local copy',
      description: 'Old local copy.',
      status: 'ACTIVE',
      source: 'IMPORTED_LOCAL_SKILL',
      version: 3,
      rules: ['Old rule.'],
      sourceFailureCaseIds: [],
      createdByUserId: 'codex',
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
      definitionSha256: 'old',
    }],
  }));
  const registry = new SkillRegistry({ dataDirectory: data, seedSkillPath: seedPath });
  await registry.initialize();

  const first = await registry.get('failure-corpus-discipline');
  assert.equal(first.source, 'BUILTIN');
  assert.equal(first.status, 'ACTIVE');
  assert.equal(first.version, 3);
  assert.deepEqual(first.rules, ['Record one logical failure event as one case.']);
  assert.match(first.definitionSha256, /^[a-f0-9]{64}$/);
});
