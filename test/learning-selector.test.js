import test from 'node:test';
import assert from 'node:assert/strict';
import { selectLearningForTask } from '../src/learning-selector.js';

test('selectLearningForTask picks locally relevant harnesses and skills', () => {
  const selection = selectLearningForTask({
    title: 'Improve milestone timeline bars',
    description: 'Show planned start and end ranges in the milestone calendar.',
    allowedPaths: ['public/app.js', 'public/styles.css'],
    acceptanceCriteria: ['milestone range bars are visible', 'calendar still works'],
  }, {
    defaultProfile: 'repository-basic',
    activeHarnesses: [
      { id: 'repository-basic', label: 'Repository basic', description: '', commands: [] },
      { id: 'ui-milestone-check', label: 'Milestone UI check', description: 'checks public app milestone calendar', commands: [{ file: 'node', args: ['tools/check-milestone.js'], cwd: 'public' }] },
      { id: 'docs-link-check', label: 'Docs link check', description: 'checks docs links', commands: [{ file: 'node', args: ['tools/check-docs.js'], cwd: 'docs' }] },
    ],
    activeSkills: [
      { id: 'milestone-ui-skill', label: 'Milestone UI discipline', description: 'milestone calendar visual work', rules: ['When editing milestone UI, keep filters and schedule editing working.'] },
      { id: 'docs-skill', label: 'Docs style', description: 'documentation writing rules', rules: ['Keep docs concise.'] },
    ],
  });

  assert.equal(selection.verificationProfile, 'ui-milestone-check');
  assert.deepEqual(selection.skillIds, ['milestone-ui-skill']);
});

test('selectLearningForTask falls back to default harness and no unrelated skills', () => {
  const selection = selectLearningForTask({
    title: 'Update README setup notes',
    description: 'Clarify local server startup instructions.',
    allowedPaths: ['README.md'],
    acceptanceCriteria: [],
  }, {
    defaultProfile: 'repository-basic',
    activeHarnesses: [
      { id: 'repository-basic', label: 'Repository basic', description: '', commands: [] },
      { id: 'gameplay-check', label: 'Gameplay check', description: 'checks roguelike combat', commands: [{ file: 'node', args: ['tools/gameplay.js'], cwd: 'game' }] },
    ],
    activeSkills: [
      { id: 'milestone-ui-skill', label: 'Milestone UI discipline', description: 'milestone calendar visual work', rules: ['When editing milestone UI, keep filters working.'] },
    ],
  });

  assert.equal(selection.verificationProfile, 'repository-basic');
  assert.deepEqual(selection.skillIds, []);
});
