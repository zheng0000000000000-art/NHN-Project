import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { ConstitutionCompiler, extractMachineSummary, validateSummary } from '../src/constitution.js';

test('constitution compiles one source into policy, MCP instructions, and acceptance scenarios', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'team-loop-constitution-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = path.resolve('docs/AGENT-CONSTITUTION.md');
  const compiler = new ConstitutionCompiler({ sourcePath, outputDirectory: directory });
  const status = await compiler.compile();
  assert.equal(status.constitutionVersion, '0.1.0');
  assert.deepEqual(status.decisions, ['YES', 'NO', 'ASK', 'BLOCKED']);
  assert.match(compiler.instructions(), /Begin an unexplained session with loop_enter/);
  const policy = JSON.parse(await readFile(path.join(directory, 'orchestration-policy.json'), 'utf8'));
  assert.equal(policy.kind, 'team-loop-orchestration-policy');
  assert.ok(policy.decisionTable.some((item) => item.reasonCode === 'USER_GOAL_REQUIRED'));
  await access(path.join(directory, 'mcp-instructions.txt'));
  await access(path.join(directory, 'acceptance-scenarios.json'));
});

test('constitution summary fails closed when its decision contract is incomplete', () => {
  const source = '## 16. Machine-readable summary\n\n```json\n{"schemaVersion":1}\n```';
  const summary = extractMachineSummary(source);
  assert.equal(summary.schemaVersion, 1);
  assert.throws(() => validateSummary(summary), /version/);
});
