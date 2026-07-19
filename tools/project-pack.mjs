import path from 'node:path';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createProjectPack, materializeProjectPack, mergeProjectPackTasks } from '../src/project-pack.js';

const args = process.argv.slice(2);
const command = args.shift();
const option = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);
const root = process.cwd();
const readJson = async (file, fallback) => {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
};
const writeJson = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

if (command === 'export') {
  const id = option('id');
  const output = path.resolve(root, option('output', `project-packs/${id || 'project'}.json`));
  const [taskDb, userDb, harnessDb, skillDb] = await Promise.all([
    readJson(path.join(root, 'data/tasks.json'), { tasks: [] }),
    readJson(path.join(root, 'data/users.json'), { users: [] }),
    readJson(path.join(root, 'data/harnesses.json'), { harnesses: [] }),
    readJson(path.join(root, 'data/skills.json'), { skills: [] }),
  ]);
  const pack = createProjectPack({
    project: { id, title: option('title', id), repository: option('repository') },
    tasks: taskDb.tasks, users: userDb.users, harnesses: harnessDb.harnesses, skills: skillDb.skills,
    includeArchived: has('include-archived'),
  });
  await writeJson(output, pack);
  process.stdout.write(`Exported ${pack.tasks.length} tasks to ${output}\n`);
} else if (command === 'import') {
  const input = path.resolve(root, option('input'));
  if (!option('input')) throw new Error('--input is required.');
  const tasksPath = path.join(root, 'data/tasks.json');
  const [pack, taskDb, userDb] = await Promise.all([
    readJson(input, null), readJson(tasksPath, { schemaVersion: 1, tasks: [] }), readJson(path.join(root, 'data/users.json'), { users: [] }),
  ]);
  const imported = materializeProjectPack(pack, userDb.users);
  const merged = mergeProjectPackTasks(taskDb.tasks, imported, pack.project.id);
  process.stdout.write(`Project ${pack.project.id}: ${imported.length} tasks; total after import ${merged.length}.\n`);
  if (!has('apply')) {
    process.stdout.write('Preview only. Re-run with --apply to update data/tasks.json.\n');
  } else {
    const backup = `${tasksPath}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await copyFile(tasksPath, backup);
    await writeJson(tasksPath, { schemaVersion: 1, tasks: merged });
    process.stdout.write(`Applied. Backup: ${backup}\n`);
  }
} else {
  process.stdout.write('Usage:\n  node tools/project-pack.mjs export --id ID --title TITLE --repository PATH --output FILE\n  node tools/project-pack.mjs import --input FILE [--apply]\n');
  process.exitCode = command ? 1 : 0;
}
