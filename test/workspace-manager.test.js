import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { normalizeWorkspaceId, resolveWorkspacePath, validateWorkspaceManifest } from '../src/workspace-manager.js';

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
