import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WikiStore } from '../src/wiki-store.js';
import { ExperienceJournal } from '../src/experience-journal.js';
import { ExperienceEngine } from '../src/experience-engine.js';

test('experience prepare combines wiki, source context, failures, skills, and harnesses', async () => {
  const engine = new ExperienceEngine({
    projectContext: { get: async () => ({ content: 'Prefer local-first architecture.' }) },
    contextIndex: { search: () => ({ sourceCount: 1, sources: [{ path: 'src/auth.js', text: 'session cookie' }] }) },
    wiki: { search: async () => [{ id: 'wiki_1', title: 'Authentication', content: 'Use signed sessions.' }] },
    failureCases: { list: async () => [{ id: 'fail_1', title: 'auth session regression', kind: 'EXIT_MISMATCH', status: 'OPEN', occurrences: 2, harnessId: 'auth-check', taskIds: [], lastSeenAt: '2026-07-24T00:00:00Z' }] },
    harnessRegistry: { list: async () => [{ id: 'auth-check', label: 'Auth check', description: 'auth session verification', status: 'ACTIVE', commands: [] }] },
    skillRegistry: { list: async () => [{ id: 'auth-skill', label: 'Auth discipline', description: 'auth session rules', status: 'ACTIVE', rules: ['Keep sessions signed.'] }] },
  });

  const pack = await engine.prepare({ goal: 'Fix auth session behavior', allowedPaths: ['src/auth.js'] });
  assert.equal(pack.kind, 'team-loop-experience-pack');
  assert.equal(pack.contract.kind, 'team-loop-context-pack');
  assert.deepEqual(pack.contract.writeScope, ['src/auth.js']);
  assert.equal(pack.wiki[0].id, 'wiki_1');
  assert.equal(pack.sources.sourceCount, 1);
  assert.equal(pack.learning.selectedHarnessId, 'auth-check');
  assert.deepEqual(pack.learning.selectedSkillIds, ['auth-skill']);
  assert.equal(pack.learning.relevantFailures[0].id, 'fail_1');
});

test('wiki proposals stay candidates and reflection is persisted as experience', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'team-loop-experience-'));
  try {
    const wiki = new WikiStore(directory);
    const journal = new ExperienceJournal(directory);
    await wiki.initialize();
    const actor = { id: 'usr_owner' };
    const reflection = await journal.record(actor, {
      goal: 'Improve context retrieval',
      outcome: 'Ranking was corrected.',
      verdict: 'PASSED',
      discoveries: ['Path matches should outweigh body keyword matches.'],
      usedSkillIds: ['context-skill'],
    });
    const engine = new ExperienceEngine({});
    const candidates = engine.reflectionCandidates(reflection);
    const proposal = await wiki.propose(actor, { ...candidates.wikiCandidates[0], sourceExperienceId: reflection.id });

    assert.equal(proposal.entry.status, 'CANDIDATE');
    assert.equal(proposal.entry.sourceExperienceId, reflection.id);
    assert.equal((await wiki.search('path matches')).length, 0);
    await wiki.setStatus(proposal.entry.id, actor.id, 'ACTIVE');
    assert.equal((await wiki.search('path matches'))[0].id, proposal.entry.id);
    assert.equal((await journal.recent())[0].id, reflection.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
