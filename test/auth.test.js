import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, issueSession, readSession, verifyPassword } from '../src/auth.js';

test('password hashes verify and reject wrong passwords', async () => {
  const record = await hashPassword('correct horse battery staple');
  const user = {
    passwordSalt: record.salt,
    passwordHash: record.hash,
    passwordIterations: record.iterations,
    passwordDigest: record.digest,
  };
  assert.equal(await verifyPassword('correct horse battery staple', user), true);
  assert.equal(await verifyPassword('wrong password', user), false);
});

test('signed sessions cannot be edited', () => {
  const secret = 'test-secret';
  const token = issueSession(secret, 'usr_test', 60);
  assert.equal(readSession(secret, token).userId, 'usr_test');
  assert.equal(readSession(secret, `${token}x`), null);
});
