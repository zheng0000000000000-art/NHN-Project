import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

async function startServer(t) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'team-loop-server-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      DATA_DIR: dataDirectory,
      WORKSPACE_ROOT: path.resolve('.'),
      SIGNUP_CODE: 'test-signup-code',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server startup timeout: ${stderr}`)), 10_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited during startup (${code}): ${stderr}`));
    });
    child.stdout.on('data', (chunk) => {
      const match = chunk.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve)).catch(() => {});
    await rm(dataDirectory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${port}`;
}

function post(base, pathname, body, headers = {}) {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Team-Loop-Client': 'web', ...headers },
    body: JSON.stringify(body),
  });
}

test('POST requests without the trusted client header are rejected', async (t) => {
  const base = await startServer(t);
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Alice', password: 'wrong-password' }),
  });
  assert.equal(response.status, 403);
});

test('async password verification does not block health responses and auth attempts are rate limited', async (t) => {
  const base = await startServer(t);
  const registration = await post(base, '/api/auth/register', {
    name: 'Alice', password: 'correct-password', signupCode: 'test-signup-code',
  });
  assert.equal(registration.status, 201);

  const attempts = Array.from({ length: 8 }, () => post(base, '/api/auth/login', {
    name: 'Alice', password: 'wrong-password',
  }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const started = performance.now();
  const health = await fetch(`${base}/api/health`);
  const latencyMs = performance.now() - started;
  assert.equal(health.status, 200);
  assert.ok(latencyMs < 250, `health response was blocked for ${latencyMs.toFixed(1)}ms`);
  await Promise.all(attempts);

  let finalStatus = 0;
  for (let index = 0; index < 11; index += 1) {
    const response = await post(base, '/api/auth/login', { name: 'RateLimitedUser', password: 'wrong-password' });
    finalStatus = response.status;
  }
  assert.equal(finalStatus, 429);
});

test('agent work must be queued by its human owner before it can be claimed', async (t) => {
  const base = await startServer(t);
  const registration = await post(base, '/api/auth/register', {
    name: 'QueueOwner', password: 'correct-password', signupCode: 'test-signup-code',
  });
  assert.equal(registration.status, 201);
  const cookie = registration.headers.get('set-cookie').split(';', 1)[0];
  const { user } = await registration.json();
  const headers = { Cookie: cookie };

  const creation = await post(base, '/api/tasks', {
    title: 'Agent queue contract',
    assigneeUserId: user.id,
    allowedPaths: ['src/**'],
    acceptanceCriteria: ['Agent execution keeps the human owner.'],
    verificationProfile: 'repository-basic',
  }, headers);
  assert.equal(creation.status, 201);
  const created = (await creation.json()).task;
  assert.equal(created.executionMode, 'HUMAN');
  assert.equal(created.executionState, 'IDLE');

  const prematureClaim = await post(base, `/api/tasks/${created.id}/claim`, {
    expectedVersion: created.version,
    executionMode: 'AGENT',
    executor: { tool: 'codex', model: 'test-model' },
  }, headers);
  assert.equal(prematureClaim.status, 409);

  const queuedResponse = await post(base, `/api/tasks/${created.id}/queue-agent`, {
    expectedVersion: created.version,
  }, headers);
  assert.equal(queuedResponse.status, 200);
  const queued = (await queuedResponse.json()).task;
  assert.equal(queued.assigneeUserId, user.id);
  assert.equal(queued.executionMode, 'AGENT');
  assert.equal(queued.executionState, 'QUEUED');

  const claimResponse = await post(base, `/api/tasks/${created.id}/claim`, {
    expectedVersion: queued.version,
    executionMode: 'AGENT',
    executor: { tool: 'codex', model: 'test-model' },
  }, headers);
  assert.equal(claimResponse.status, 200);
  const claimed = (await claimResponse.json()).task;
  assert.equal(claimed.status, 'IN_PROGRESS');
  assert.equal(claimed.assigneeUserId, user.id);
  assert.equal(claimed.executionState, 'RUNNING');
  assert.equal(claimed.executor.tool, 'codex');
  assert.equal(claimed.executor.model, 'test-model');
});

test('task creator can reassign a ready task and queued agent state is cancelled', async (t) => {
  const base = await startServer(t);
  const ownerRegistration = await post(base, '/api/auth/register', {
    name: 'BoardAdmin', password: 'correct-password', signupCode: 'test-signup-code',
  });
  assert.equal(ownerRegistration.status, 201);
  const ownerCookie = ownerRegistration.headers.get('set-cookie').split(';', 1)[0];
  const owner = (await ownerRegistration.json()).user;

  const memberRegistration = await post(base, '/api/auth/register', {
    name: 'NewOwner', password: 'correct-password', signupCode: 'test-signup-code',
  });
  assert.equal(memberRegistration.status, 201);
  const memberCookie = memberRegistration.headers.get('set-cookie').split(';', 1)[0];
  const member = (await memberRegistration.json()).user;

  const creation = await post(base, '/api/tasks', {
    title: 'Reassign board owner',
    assigneeUserId: owner.id,
    allowedPaths: ['public/**'],
    acceptanceCriteria: ['The card owner can be changed.'],
    verificationProfile: 'repository-basic',
  }, { Cookie: ownerCookie });
  const created = (await creation.json()).task;

  const queuedResponse = await post(base, `/api/tasks/${created.id}/queue-agent`, {
    expectedVersion: created.version,
  }, { Cookie: ownerCookie });
  const queued = (await queuedResponse.json()).task;

  const forbidden = await post(base, `/api/tasks/${created.id}/assign`, {
    expectedVersion: queued.version,
    assigneeUserId: member.id,
  }, { Cookie: memberCookie });
  assert.equal(forbidden.status, 403);

  const reassignedResponse = await post(base, `/api/tasks/${created.id}/assign`, {
    expectedVersion: queued.version,
    assigneeUserId: member.id,
  }, { Cookie: ownerCookie });
  assert.equal(reassignedResponse.status, 200);
  const reassigned = (await reassignedResponse.json()).task;
  assert.equal(reassigned.assigneeUserId, member.id);
  assert.equal(reassigned.executionMode, 'HUMAN');
  assert.equal(reassigned.executionState, 'IDLE');
});

test('assignee can upload a task artifact and participants can download the original file', async (t) => {
  const base = await startServer(t);
  const registration = await post(base, '/api/auth/register', {
    name: 'ArtifactOwner', password: 'correct-password', signupCode: 'test-signup-code',
  });
  const cookie = registration.headers.get('set-cookie').split(';', 1)[0];
  const user = (await registration.json()).user;
  const creation = await post(base, '/api/tasks', {
    title: 'Upload real result', assigneeUserId: user.id,
    allowedPaths: ['docs/**'], acceptanceCriteria: ['Result file is available.'],
    verificationProfile: 'repository-basic',
  }, { Cookie: cookie });
  const task = (await creation.json()).task;
  const original = Buffer.from('real user result\n', 'utf8');

  const upload = await post(base, `/api/tasks/${task.id}/artifact`, {
    expectedVersion: task.version,
    name: 'result.txt', contentType: 'text/plain', data: original.toString('base64'),
  }, { Cookie: cookie });
  assert.equal(upload.status, 201);
  const uploaded = await upload.json();
  assert.equal(uploaded.task.artifacts[0].name, 'result.txt');
  assert.equal(uploaded.task.artifacts[0].size, original.length);

  const download = await fetch(`${base}/api/tasks/${task.id}/artifacts/${uploaded.artifact.id}`, {
    headers: { Cookie: cookie },
  });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'text/plain');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), original);

  const unauthenticated = await fetch(`${base}/api/tasks/${task.id}/artifacts/${uploaded.artifact.id}`);
  assert.equal(unauthenticated.status, 401);
});

test('workboard export is authenticated, portable, and excludes private orchestration data', async (t) => {
  const base = await startServer(t);
  const registration = await post(base, '/api/auth/register', {
    name: 'BoardOwner', password: 'correct-password', signupCode: 'test-signup-code',
  });
  const cookie = registration.headers.get('set-cookie').split(';', 1)[0];
  const user = (await registration.json()).user;
  await post(base, '/api/tasks', {
    title: 'Public board item',
    description: 'PRIVATE PROMPT',
    assigneeUserId: user.id,
    allowedPaths: ['private/**'],
    acceptanceCriteria: ['PRIVATE CRITERION'],
    verificationProfile: 'repository-basic',
  }, { Cookie: cookie });

  const unauthenticated = await fetch(`${base}/api/workboard/export`);
  assert.equal(unauthenticated.status, 401);

  const response = await fetch(`${base}/api/workboard/export?title=Delivery%20Board`, {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(response.headers.get('content-disposition'), /team-loop-workboard\.html/);
  const html = await response.text();
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Delivery Board/);
  assert.match(html, /Public board item/);
  assert.equal(html.includes('PRIVATE PROMPT'), false);
  assert.equal(html.includes('PRIVATE CRITERION'), false);
  assert.equal(html.includes('private/**'), false);
  assert.equal(html.includes('fetch('), false);
});

test('experience API prepares context and turns reflection discoveries into wiki candidates', async (t) => {
  const base = await startServer(t);
  const registration = await post(base, '/api/auth/register', {
    name: 'ExperienceOwner', password: 'correct-password', signupCode: 'test-signup-code',
  });
  const cookie = registration.headers.get('set-cookie').split(';', 1)[0];

  const contractsResponse = await fetch(`${base}/api/contracts`, { headers: { Cookie: cookie } });
  assert.equal(contractsResponse.status, 200);
  const contracts = await contractsResponse.json();
  assert.equal(contracts.contracts.contextPack.legacyAliases.diId, 'packId');
  assert.equal(contracts.contracts.knowledgePromotion.minimumOccurrences, 2);

  const prepared = await post(base, '/api/experience/prepare', {
    goal: 'Improve the MCP experience learning loop',
    allowedPaths: ['mcp/**', 'src/experience-engine.js'],
    acceptanceCriteria: ['Agents receive a reusable experience pack.'],
  }, { Cookie: cookie });
  assert.equal(prepared.status, 200);
  const pack = (await prepared.json()).pack;
  assert.equal(pack.kind, 'team-loop-experience-pack');
  assert.equal(pack.contract.kind, 'team-loop-context-pack');
  assert.equal(Array.isArray(pack.learning.selectedSkillIds), true);

  const reflected = await post(base, '/api/experience/reflect', {
    goal: 'Improve the MCP experience learning loop',
    outcome: 'Experience tools were added and tested.',
    verdict: 'PASSED',
    discoveries: ['MCP should expose preparation and reflection as primary tools.'],
    usedHarnessIds: ['repository-basic'],
  }, { Cookie: cookie });
  assert.equal(reflected.status, 201);
  const reflection = await reflected.json();
  assert.equal(reflection.candidates.wikiCandidates[0].status, 'CANDIDATE');

  const hidden = await fetch(`${base}/api/wiki?q=preparation`, { headers: { Cookie: cookie } });
  assert.equal((await hidden.json()).entries.length, 0);
  const review = await fetch(`${base}/api/wiki?q=preparation&candidates=true`, { headers: { Cookie: cookie } });
  assert.equal((await review.json()).entries[0].sourceExperienceId, reflection.experience.id);
});
