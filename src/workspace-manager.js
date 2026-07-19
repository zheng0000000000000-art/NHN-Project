import path from 'node:path';

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
