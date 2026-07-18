import path from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { nowIso } from './utils.js';

export async function initializeProject(workspaceRoot, { force = false } = {}) {
  const root = path.resolve(workspaceRoot);
  const directory = path.join(root, '.team-loop');
  const projectPath = path.join(directory, 'project.json');
  if (!force && await exists(projectPath)) throw new Error('.team-loop/project.json already exists.');
  const detected = await detectProject(root);
  const project = {
    schemaVersion: 1, name: path.basename(root), initializedAt: nowIso(), mode: 'AUTO',
    sourceRoots: detected.sourceRoots, testRoots: detected.testRoots, documentRoots: ['docs/**', '*.md'],
    protectedPaths: ['.env', '.env.*', 'secrets/**', 'production-data/**'],
    defaultExecutor: 'codex', defaultProfile: 'project-default', autoMerge: false,
    detectedStack: detected.stack,
  };
  const profiles = { schemaVersion: 1, profiles: { 'project-default': { label: `${detected.stack} project`, description: 'Project-local commands detected by team-loop init.', commands: detected.commands } } };
  await mkdir(directory, { recursive: true });
  await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  await writeFile(path.join(directory, 'verification-profiles.json'), `${JSON.stringify(profiles, null, 2)}\n`, 'utf8');
  await ensureGitignore(root);
  return { projectPath: relative(root, projectPath), profilesPath: '.team-loop/verification-profiles.json', project, profiles };
}

export async function loadProjectConfig(workspaceRoot) {
  const file = path.join(path.resolve(workspaceRoot), '.team-loop', 'project.json');
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function detectProject(root) {
  if (await exists(path.join(root, 'package.json'))) {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const commands = [];
    if (pkg.scripts?.test) commands.push(command(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], 180000));
    if (pkg.scripts?.lint) commands.push(command(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'lint'], 180000));
    if (pkg.scripts?.build) commands.push(command(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], 180000));
    if (!commands.length) commands.push(command('node', ['--test'], 180000));
    return { stack: 'node', sourceRoots: ['src/**', 'public/**'], testRoots: ['test/**', 'tests/**'], commands };
  }
  if (await exists(path.join(root, 'pyproject.toml'))) return { stack: 'python', sourceRoots: ['src/**', '*.py'], testRoots: ['test/**', 'tests/**'], commands: [command('python', ['-m', 'pytest'], 180000)] };
  if (await exists(path.join(root, 'go.mod'))) return { stack: 'go', sourceRoots: ['**/*.go'], testRoots: ['**/*_test.go'], commands: [command('go', ['test', './...'], 180000)] };
  if (await exists(path.join(root, 'Cargo.toml'))) return { stack: 'rust', sourceRoots: ['src/**'], testRoots: ['tests/**'], commands: [command('cargo', ['test'], 180000)] };
  return { stack: 'generic', sourceRoots: ['src/**'], testRoots: ['test/**', 'tests/**'], commands: [command('git', ['diff', '--check'], 60000)] };
}
function command(file, args, timeoutMs) { return { file, args, expectedExit: 0, timeoutMs }; }
async function ensureGitignore(root) {
  const file = path.join(root, '.gitignore');
  let text = '';
  try { text = await readFile(file, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const additions = ['.team-loop/results/', '.team-loop/scopes/', '.team-loop/learning/', '.team-loop-worktrees/'].filter((item) => !text.split(/\r?\n/).includes(item));
  if (additions.length) await writeFile(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${additions.join('\n')}\n`, 'utf8');
}
function relative(root, file) { return path.relative(root, file).replaceAll('\\', '/'); }
async function exists(file) { try { await readFile(file); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } }
