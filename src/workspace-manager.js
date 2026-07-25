import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { sha256 } from './utils.js';

export function normalizeWorkspaceId(value) {
  const id = String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '');
  if (!id) throw new TypeError('Workspace id is required.');
  return id;
}

export function resolveWorkspacePath(teamLoopRoot, workspaceId) {
  const workspacesRoot = path.resolve(teamLoopRoot, 'workspaces');
  const target = path.resolve(workspacesRoot, normalizeWorkspaceId(workspaceId));
  if (!target.startsWith(`${workspacesRoot}${path.sep}`)) throw new TypeError('Workspace path escapes the workspace root.');
  return target;
}

export function validateWorkspaceManifest(value) {
  if (value?.schemaVersion !== 1) throw new TypeError('Unsupported workspace manifest version.');
  const id = normalizeWorkspaceId(value.id);
  if (id !== value.id) throw new TypeError('Workspace manifest id must already be normalized.');
  return {
    schemaVersion: 1,
    id,
    title: String(value.title || id),
    gameRepository: String(value.gameRepository || ''),
    projectPack: String(value.projectPack || 'project/project-pack.json'),
    context: {
      stable: String(value.context?.stable || 'context/stable'),
      current: String(value.context?.current || 'context/current'),
    },
    handoff: String(value.handoff || 'handoffs/CURRENT.md'),
  };
}

export async function readWorkspaceHandoff(teamLoopRoot, workspaceId) {
  const directory = resolveWorkspacePath(teamLoopRoot, workspaceId);
  const manifestPath = path.join(directory, 'workspace.json');
  const manifest = validateWorkspaceManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  const handoffPath = resolveWorkspaceFile(directory, manifest.handoff);
  const [content, metadata] = await Promise.all([
    readFile(handoffPath, 'utf8'),
    stat(handoffPath),
  ]);
  return {
    schemaVersion: 1,
    kind: 'PROJECT_HANDOFF',
    projectId: manifest.id,
    title: manifest.title,
    source: {
      path: slash(path.relative(teamLoopRoot, handoffPath)),
      sha256: sha256(content),
      modifiedAt: metadata.mtime.toISOString(),
      bytes: metadata.size,
    },
    content,
  };
}

function resolveWorkspaceFile(directory, candidate) {
  const resolved = path.resolve(directory, String(candidate || ''));
  const relative = path.relative(directory, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new TypeError('Workspace handoff must be a file inside its workspace.');
  }
  return resolved;
}

function slash(value) {
  return String(value).replaceAll('\\', '/');
}
