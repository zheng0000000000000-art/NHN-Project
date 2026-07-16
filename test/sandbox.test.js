import test from 'node:test';
import assert from 'node:assert/strict';
import { sandboxWrap } from '../src/verifier.js';

test('sandboxWrap is OFF by default — runs the command directly', () => {
  delete process.env.TEAM_LOOP_SANDBOX;
  const r = sandboxWrap('git', ['diff', '--check'], '/repo', '/repo');
  assert.deepEqual(r, { file: 'git', args: ['diff', '--check'], cwd: '/repo' });
});

test('sandboxWrap docker mode isolates: --network none, memory/pids limits, only root mounted, argv (no shell)', () => {
  process.env.TEAM_LOOP_SANDBOX = 'docker';
  try {
    const r = sandboxWrap('node', ['--test'], '/repo/wt', '/repo/wt');
    assert.equal(r.file, 'docker');
    const i = r.args.indexOf('--network');
    assert.ok(i !== -1 && r.args[i + 1] === 'none', 'network is isolated');
    assert.ok(r.args.includes('--memory') && r.args.includes('--pids-limit'), 'resource limits present');
    assert.ok(r.args.includes('/repo/wt:/work'), 'only the verify root is mounted');
    // the harness file+args are passed as real argv after the image (no shell string)
    assert.deepEqual(r.args.slice(-2), ['node', '--test']);
  } finally {
    delete process.env.TEAM_LOOP_SANDBOX;
  }
});

test('sandboxWrap maps a command subdir to the container workdir', () => {
  process.env.TEAM_LOOP_SANDBOX = 'docker';
  try {
    const r = sandboxWrap('node', ['--test'], '/repo', '/repo/pkg');
    const w = r.args.indexOf('-w');
    assert.equal(r.args[w + 1], '/work/pkg');
  } finally {
    delete process.env.TEAM_LOOP_SANDBOX;
  }
});

test('sandboxWrap generic mode prefixes a wrapper executable with templated args', () => {
  process.env.TEAM_LOOP_SANDBOX = 'firejail';
  process.env.TEAM_LOOP_SANDBOX_ARGS = '--net=none --private={root}';
  try {
    const r = sandboxWrap('node', ['--test'], '/r', '/r');
    assert.equal(r.file, 'firejail');
    assert.deepEqual(r.args, ['--net=none', '--private=/r', 'node', '--test']);
  } finally {
    delete process.env.TEAM_LOOP_SANDBOX;
    delete process.env.TEAM_LOOP_SANDBOX_ARGS;
  }
});

test('sandboxWrap runs trusted tools (git) on the host even when the sandbox is on', () => {
  // git worktrees reference the parent repo's .git, which a container mount cannot see,
  // so git (a trusted, fixed-operation tool) runs on the host; code interpreters are sandboxed.
  process.env.TEAM_LOOP_SANDBOX = 'docker';
  try {
    const r = sandboxWrap('git', ['diff', '--check'], '/repo/wt', '/repo/wt');
    assert.deepEqual(r, { file: 'git', args: ['diff', '--check'], cwd: '/repo/wt' });
  } finally {
    delete process.env.TEAM_LOOP_SANDBOX;
  }
});

import { sandboxPreflight } from '../src/verifier.js';

test('sandboxPreflight is a no-op when the sandbox is off', async () => {
  delete process.env.TEAM_LOOP_SANDBOX;
  await sandboxPreflight([{ file: 'node', args: ['--test'] }], async () => ({ passed: false }));
});

test('sandboxPreflight skips the docker check when only host-run tools (git) are used', async () => {
  process.env.TEAM_LOOP_SANDBOX = 'docker';
  try {
    // git runs on the host, so no sandbox backend is needed even if docker is down
    await sandboxPreflight([{ file: 'git', args: ['diff', '--check'] }], async () => ({ passed: false }));
  } finally {
    delete process.env.TEAM_LOOP_SANDBOX;
  }
});

test('sandboxPreflight fails CLOSED when a code command needs the sandbox but docker is unavailable', async () => {
  process.env.TEAM_LOOP_SANDBOX = 'docker';
  try {
    await assert.rejects(
      () => sandboxPreflight([{ file: 'node', args: ['--test'] }], async () => ({ passed: false })),
      /Docker sandbox|not available/,
    );
  } finally {
    delete process.env.TEAM_LOOP_SANDBOX;
  }
});
