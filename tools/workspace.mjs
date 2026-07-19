import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { normalizeWorkspaceId, resolveWorkspacePath, validateWorkspaceManifest } from '../src/workspace-manager.js';

const run = promisify(execFile);
const args = process.argv.slice(2);
const command = args.shift();
const option = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const root = process.cwd();
const workspacesRoot = path.join(root, 'workspaces');
const writeJson = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

async function load(id) {
  const directory = resolveWorkspacePath(root, id);
  const manifest = validateWorkspaceManifest(JSON.parse(await readFile(path.join(directory, 'workspace.json'), 'utf8')));
  return { directory, manifest };
}

if (command === 'init') {
  const id = normalizeWorkspaceId(option('id'));
  const directory = resolveWorkspacePath(root, id);
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length) throw new Error(`Workspace directory is not empty: ${directory}`);
  const manifest = validateWorkspaceManifest({
    schemaVersion: 1,
    id,
    title: option('title', id),
    gameRepository: option('game-repository'),
    projectPack: 'project/project-pack.json',
    context: { stable: 'context/stable', current: 'context/current' },
    handoff: 'handoffs/CURRENT.md',
  });
  await Promise.all(['project', 'context/stable', 'context/current', 'handoffs', 'plans', 'verification', 'skills'].map((item) => mkdir(path.join(directory, item), { recursive: true })));
  await writeJson(path.join(directory, 'workspace.json'), manifest);
  await writeFile(path.join(directory, '.gitignore'), '.cache/\n*.local\n', 'utf8');
  await writeFile(path.join(directory, 'README.md'), `# ${manifest.title} workspace\n\nTeam Loop project context, plans, and handoff state. Game source lives in \`${manifest.gameRepository || 'a separate repository'}\`.\n`, 'utf8');
  await run('git', ['init', '-b', 'main'], { cwd: directory });
  process.stdout.write(`Initialized external workspace: ${directory}\n`);
} else if (command === 'list') {
  await mkdir(workspacesRoot, { recursive: true });
  for (const entry of await readdir(workspacesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const { manifest } = await load(entry.name);
      process.stdout.write(`${manifest.id}\t${manifest.title}\t${manifest.gameRepository}\n`);
    } catch {
      process.stdout.write(`${entry.name}\tINVALID\n`);
    }
  }
} else if (['status', 'pull', 'push'].includes(command)) {
  const { directory, manifest } = await load(option('id'));
  const gitArgs = command === 'status' ? ['status', '--short', '--branch'] : command === 'pull' ? ['pull', '--ff-only'] : ['push'];
  const result = await run('git', gitArgs, { cwd: directory });
  process.stdout.write(`${manifest.title} (${directory})\n${result.stdout || ''}${result.stderr || ''}`);
} else {
  process.stdout.write('Usage:\n  npm run workspace -- init --id ID --title TITLE --game-repository PATH\n  npm run workspace -- list\n  npm run workspace -- status|pull|push --id ID\n');
  process.exitCode = command ? 1 : 0;
}
