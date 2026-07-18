import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializeProject } from '../src/project-setup.js';
import { runCli } from '../src/cli/main.js';

test('init detects a Node project and work creates a project-local run', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-project-'));
  const originalWrite = process.stdout.write;
  try {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    const initialized = await initializeProject(root);
    assert.equal(initialized.project.detectedStack, 'node');
    assert.equal(initialized.project.autoMerge, false);
    assert.equal(initialized.profiles.profiles['project-default'].commands[0].file, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    assert.match(await readFile(path.join(root, '.gitignore'), 'utf8'), /.team-loop\/results\//);
    await assert.rejects(initializeProject(root), /already exists/);
    process.stdout.write = () => true;
    assert.equal(await runCli(['work', 'add search', '--workspace', root, '--json']), 0);
    const date = new Date().toISOString().slice(0, 10);
    const run = JSON.parse(await readFile(path.join(root, '.team-loop', 'runs', `${date}-add-search.json`), 'utf8'));
    assert.equal(run.verification.profile, 'project-default');
    assert.equal(run.mode.appliedMode, 'CODE');
    assert.deepEqual(run.writeScope, ['src/**', 'public/**', 'test/**', 'tests/**']);
  } finally {
    process.stdout.write = originalWrite;
    await rm(root, { recursive: true, force: true });
  }
});
