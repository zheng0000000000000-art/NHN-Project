import { createHmac, pbkdf2 as pbkdf2Callback, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ensureDir, pathExists, randomId } from './utils.js';

const ITERATIONS = 210_000;
const KEY_LENGTH = 32;
const DIGEST = 'sha256';
const pbkdf2 = promisify(pbkdf2Callback);

export async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const derived = await pbkdf2(password, salt, ITERATIONS, KEY_LENGTH, DIGEST);
  return { salt, hash: derived.toString('hex'), iterations: ITERATIONS, digest: DIGEST };
}

export async function verifyPassword(password, record) {
  const candidate = await pbkdf2(
    password,
    record.passwordSalt,
    record.passwordIterations,
    KEY_LENGTH,
    record.passwordDigest,
  );
  const expected = Buffer.from(record.passwordHash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export async function loadOrCreateSecret(dataDirectory) {
  const secretPath = path.join(dataDirectory, 'app-secret.key');
  await ensureDir(dataDirectory);
  if (!(await pathExists(secretPath))) {
    await writeFile(secretPath, randomBytes(48).toString('hex'), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  }
  return (await readFile(secretPath, 'utf8')).trim();
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function sign(secret, encodedPayload) {
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

export function issueSession(secret, userId, ttlSeconds = 60 * 60 * 24 * 7) {
  const payload = {
    sessionId: randomId('ses_'),
    userId,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const encoded = base64Url(JSON.stringify(payload));
  return `${encoded}.${sign(secret, encoded)}`;
}

export function readSession(secret, token) {
  if (!token || !token.includes('.')) return null;
  const [encoded, signature] = token.split('.', 2);
  const expected = sign(secret, encoded);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload.userId || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        return index === -1
          ? [decodeURIComponent(part), '']
          : [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

export function sessionCookie(token, secure = false) {
  return [
    `team_loop_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=604800',
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

export function clearSessionCookie(secure = false) {
  return [
    'team_loop_session=',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}
