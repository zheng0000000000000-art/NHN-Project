import test from 'node:test';
import assert from 'node:assert/strict';
import { auditLearningArtifacts } from '../src/learning-audit.js';

test('learning audit keeps core artifacts and flags duplicate failing drafts', () => {
  const audit = auditLearningArtifacts({
    harnesses: [
      harness('node-project', { source: 'BUILTIN', status: 'ACTIVE', commands: [['node', ['--test']]] }),
      harness('duplicate-node', { source: 'FAILURE_DERIVED', status: 'DRAFT', commands: [['node', ['--test']]], passed: false }),
      harness('judging-repository-history', { source: 'IMPORTED_LOCAL_SKILL', status: 'DRAFT', commands: [['node', ['tools/judging/check-criteria.mjs', 'repo-history']]] }),
    ],
    skills: [
      skill('execution-verification', { source: 'IMPORTED_LOCAL_SKILL', status: 'ACTIVE', rules: ['Run real verification.'] }),
      skill('scope-guard', { source: 'FAILURE_DERIVED', status: 'ACTIVE', rules: ['Check allowedPaths before finishing.'] }),
      skill('scope-violation-review-a29aa3bf', { source: 'FAILURE_DERIVED', status: 'DRAFT', rules: ['Check allowedPaths before finishing.'] }),
    ],
  });

  assert.equal(find(audit.harnesses, 'node-project').category, 'KEEP');
  assert.equal(find(audit.harnesses, 'duplicate-node').action, 'ARCHIVE');
  assert.equal(find(audit.harnesses, 'judging-repository-history').category, 'CONDITIONAL');
  assert.equal(find(audit.skills, 'execution-verification').category, 'KEEP');
  assert.equal(find(audit.skills, 'scope-guard').category, 'KEEP');
  assert.equal(find(audit.skills, 'scope-guard').action, 'KEEP');
  assert.equal(find(audit.skills, 'scope-violation-review-a29aa3bf').action, 'ARCHIVE');
  assert.ok(audit.actions.some((item) => item.id === 'duplicate-node'));
  assert.ok(audit.actions.some((item) => item.id === 'scope-violation-review-a29aa3bf'));
});

function find(items, id) {
  return items.find((item) => item.id === id);
}

function harness(id, { source, status, commands, passed = true }) {
  return {
    id,
    label: id,
    description: id,
    source,
    status,
    commands: commands.map(([file, args]) => ({ file, args, cwd: '.', expectedExit: 0, timeoutMs: 120000 })),
    lastTest: { passed },
  };
}

function skill(id, { source, status, rules }) {
  return {
    id,
    label: id,
    description: id,
    source,
    status,
    rules,
  };
}
