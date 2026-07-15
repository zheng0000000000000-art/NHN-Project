import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, appendFile, access } from 'node:fs/promises';
import path from 'node:path';

export const nowIso = () => new Date().toISOString();

export function sha256(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return createHash('sha256').update(buffer).digest('hex');
}

export function randomId(prefix = '') {
  return `${prefix}${randomBytes(10).toString('hex')}`;
}

export async function ensureDir(directory) {
  await mkdir(directory, { recursive: true });
}

export async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return structuredClone(fallback);
    throw error;
  }
}

export async function atomicWriteJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(tempPath, filePath);
}

export async function appendJsonLine(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

export function normalizeRelativePath(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

export function assertPlainObject(value, message = 'Expected an object') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, message);
  }
}

export class HttpError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
