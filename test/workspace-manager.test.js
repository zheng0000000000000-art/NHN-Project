import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { normalizeWorkspaceId, readWorkspaceHandoff, resolveWorkspacePath, validateWorkspaceManifest } from '../src/workspace-manager.js';

test('workspace ids and paths stay inside the managed workspace root', () => {
  assert.equal(normalizeWorkspaceId('Unknown Auction'), 'unknown-auction');
  assert.equal(resolveWorkspacePath('C:/team-loop', '../Unknown Auction'), path.resolve('C:/team-loop/workspaces/unknown-auction'));
});

test('workspace manifest keeps external project locations and context roles', () => {
  const manifest = validateWorkspaceManifest({ schemaVersion: 1, id: 'unknown-auction', title: '미지의 경매장', gameRepository: 'C:/game' });
  assert.equal(manifest.gameRepository, 'C:/game');
  assert.equal(manifest.projectPack, 'project/project-pack.json');
  assert.equal(manifest.context.stable, 'context/stable');
  assert.equal(manifest.handoff, 'handoffs/CURRENT.md');
});

test('workspace manifest rejects an unnormalized id', () => {
  assert.throws(() => validateWorkspaceManifest({ schemaVersion: 1, id: '../bad' }), /normalized/);
});

test('workspace handoff is read from the manifest with integrity metadata', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'workspaces', 'demo');
  await mkdir(path.join(directory, 'handoffs'), { recursive: true });
  await writeFile(path.join(directory, 'workspace.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'demo',
    title: 'Demo',
    handoff: 'handoffs/CURRENT.md',
  }));
  await writeFile(path.join(directory, 'handoffs', 'CURRENT.md'), '# Resume here\n\nRun the gate.\n');

  const result = await readWorkspaceHandoff(root, 'demo');
  assert.equal(result.kind, 'PROJECT_HANDOFF');
  assert.equal(result.projectId, 'demo');
  assert.match(result.content, /Run the gate/);
  assert.match(result.source.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.source.path, 'workspaces/demo/handoffs/CURRENT.md');
});
