import os from 'node:os';
import path from 'node:path';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';

export function cliHome() {
  return process.env.TEAM_LOOP_CLI_HOME
    ? path.resolve(process.env.TEAM_LOOP_CLI_HOME)
    : path.join(os.homedir(), '.team-loop-lite');
}

function sessionPath() {
  const home = cliHome();
  return { directory: home, file: path.join(home, 'session.json') };
}

export async function loadSession() {
  const { file } = sessionPath();
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function saveSession(value) {
  const { directory, file } = sessionPath();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(temporary, 0o600).catch(() => {});
  await rename(temporary, file);
  await chmod(file, 0o600).catch(() => {});
}

export async function clearSession() {
  const { file } = sessionPath();
  await writeFile(file, '{}\n', { encoding: 'utf8', mode: 0o600 }).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
}

export function normalizeServer(value) {
  const server = String(value || 'http://localhost:4173').trim().replace(/\/$/, '');
  const url = new URL(server);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Server URL must use http or https.');
  return url.toString().replace(/\/$/, '');
}
