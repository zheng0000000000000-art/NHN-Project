import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ScopeLeaseService } from '../src/scope-leases.js';

function run(id, writeScope, readScope = [], interfaces = []) {
  return { id, agent: id, changes: writeScope.map((item) => ({ path: item })), writeScope, readScope, interfaces };
}

test('scope leases block overlapping writes but allow shared reads and interfaces', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-scopes-'));
  try {
    const service = new ScopeLeaseService({ workspaceRoot: root });
    const first = await service.acquire(run('agent-one', ['src/server/**'], [], ['GET /api/logs']));
    assert.equal(first.lease.owner, 'agent-one');
    await assert.rejects(
      service.acquire(run('agent-two', ['src/server/routes.js'], ['src/server/**'], ['GET /api/logs'])),
      /conflicts with active run/,
    );
    const parallel = await service.acquire(run('agent-ui', ['public/**'], ['src/server/**'], ['GET /api/logs']));
    assert.equal(parallel.lease.interfaces[0], 'GET /api/logs');
    assert.equal((await service.list()).length, 2);
    assert.equal((await service.release('agent-one', { owner: 'agent-one' })).released, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('expired scope leases are pruned and become acquirable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-scopes-'));
  let now = Date.parse('2026-07-18T00:00:00Z');
  try {
    const service = new ScopeLeaseService({ workspaceRoot: root, now: () => now });
    await service.acquire(run('old-run', ['src/**']), { ttlMinutes: 1 });
    now += 61_000;
    const next = await service.acquire(run('new-run', ['src/app.js']));
    assert.equal(next.lease.runId, 'new-run');
    assert.deepEqual((await service.list()).map((item) => item.runId), ['new-run']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('lease reuse requires the same owner and document and heartbeat extends expiry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-scopes-'));
  let now = Date.parse('2026-07-18T00:00:00Z');
  try {
    const service = new ScopeLeaseService({ workspaceRoot: root, now: () => now });
    const document = run('owned-run', ['src/a.js']);
    const first = await service.acquire(document, { owner: 'alice', ttlMinutes: 1 });
    await assert.rejects(service.acquire(document, { owner: 'bob' }), /different owner or document/);
    await assert.rejects(service.acquire(run('owned-run', ['src/b.js']), { owner: 'alice' }), /different owner or document/);
    now += 30_000;
    const renewed = await service.heartbeat('owned-run', { owner: 'alice', ttlMinutes: 2 });
    assert.ok(Date.parse(renewed.expiresAt) > Date.parse(first.lease.expiresAt));
    await assert.rejects(service.heartbeat('owned-run', { owner: 'bob' }), /Only the lease owner/);
    await assert.rejects(service.release('owned-run', { owner: 'bob' }), /Only the lease owner/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('file-aware overlap avoids a false conflict when current file sets are disjoint', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-scopes-'));
  try {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'app.js'), 'export {};\n');
    const service = new ScopeLeaseService({ workspaceRoot: root });
    await service.acquire(run('source-run', ['src/*.js']));
    const tests = await service.acquire(run('test-run', ['src/*.test.js']));
    assert.equal(tests.lease.runId, 'test-run');
  } finally { await rm(root, { recursive: true, force: true }); }
});
