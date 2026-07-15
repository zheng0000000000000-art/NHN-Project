import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { captureClaudeStatusline, collectUsageSnapshots, commitUsageCursor, parseClaudeSessionLine, parseCodexSessionLine, queryCodexAppServer } from '../src/cli/usage-collector.js';
import { extractOtelUsage, startOtelReceiver } from '../src/cli/otel-receiver.js';

async function withCliHome(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'team-loop-collector-'));
  const previous = process.env.TEAM_LOOP_CLI_HOME;
  process.env.TEAM_LOOP_CLI_HOME = path.join(root, 'cli');
  t.after(async () => {
    if (previous === undefined) delete process.env.TEAM_LOOP_CLI_HOME;
    else process.env.TEAM_LOOP_CLI_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('defensive session parsers extract usage and ignore unknown records', () => {
  assert.deepEqual(parseClaudeSessionLine({ message: { model: 'claude-x', usage: { input_tokens: 10, output_tokens: 2 } } }), {
    model: 'claude-x', usage: { inputTokens: 10, inputCachedTokens: 0, outputTokens: 2, reasoningTokens: 0, totalTokens: 12 },
  });
  assert.equal(parseClaudeSessionLine({ prompt: 'private text' }), null);
  assert.deepEqual(parseCodexSessionLine({ payload: { type: 'token_count', model: 'gpt-x', info: { last_token_usage: { input_tokens: 4, cached_input_tokens: 1, output_tokens: 3, reasoning_output_tokens: 2 } } } }), {
    model: 'gpt-x', usage: { inputTokens: 4, inputCachedTokens: 1, outputTokens: 3, reasoningTokens: 2, totalTokens: 7 },
  });
  assert.equal(parseCodexSessionLine({ type: 'message', text: 'private text' }), null);
});

test('OTLP JSON extracts Claude token metrics without prompt content', () => {
  const rows = extractOtelUsage({ resourceMetrics: [{ scopeMetrics: [{ metrics: [{
    name: 'claude_code.token.usage',
    sum: { dataPoints: [
      { asInt: '10', attributes: [{ key: 'type', value: { stringValue: 'input' } }, { key: 'model', value: { stringValue: 'claude-x' } }] },
      { asInt: '4', attributes: [{ key: 'type', value: { stringValue: 'output' } }, { key: 'model', value: { stringValue: 'claude-x' } }] },
    ] },
  }] }] }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tool, 'claude-code');
  assert.equal(rows[0].usage.totalTokens, 14);
  assert.equal(JSON.stringify(rows).includes('prompt'), false);
});

test('collector baselines existing session logs on first run', async (t) => {
  const root = await withCliHome(t);
  const home = path.join(root, 'home');
  const claudeDir = path.join(home, '.claude', 'projects', 'project-a');
  await mkdir(claudeDir, { recursive: true });
  const log = path.join(claudeDir, 'session.jsonl');
  await writeFile(log, `${JSON.stringify({ message: { model: 'claude-x', usage: { input_tokens: 10, output_tokens: 2 } } })}\n{broken}\n`);
  const first = await collectUsageSnapshots({ now: new Date('2026-07-15T10:00:00.000Z'), homeDirectory: home, queryCodex: async () => null });
  assert.equal(first.snapshots.length, 0);
  assert.equal(first.diagnostics.some((item) => item.status === 'BASELINED'), true);
  await commitUsageCursor(first.cursorPath, first.nextCursor);

  await appendFile(log, `${JSON.stringify({ message: { model: 'claude-x', usage: { input_tokens: 5, output_tokens: 1 } } })}\n`);
  const second = await collectUsageSnapshots({ now: new Date('2026-07-15T11:00:00.000Z'), homeDirectory: home, queryCodex: async () => null });
  assert.equal(second.snapshots.find((item) => item.tool === 'claude-code').tokens.byModel['claude-x'].totalTokens, 6);
  assert.equal(second.snapshots.find((item) => item.tool === 'claude-code').tokens.windowStart, '2026-07-15T10:00:00.000Z');
});

test('collector can opt into initial backfill and does not reread committed lines', async (t) => {
  const root = await withCliHome(t);
  const home = path.join(root, 'home');
  const claudeDir = path.join(home, '.claude', 'projects', 'project-a');
  await mkdir(claudeDir, { recursive: true });
  const log = path.join(claudeDir, 'session.jsonl');
  await writeFile(log, `${JSON.stringify({ message: { model: 'claude-x', usage: { input_tokens: 10, output_tokens: 2 } } })}\n{broken}\n`);
  await captureClaudeStatusline(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 25, resets_at: 1784100000 } } }));
  const first = await collectUsageSnapshots({
    now: new Date('2026-07-15T10:00:00.000Z'),
    homeDirectory: home,
    queryCodex: async () => null,
    includeInitialBackfill: true,
  });
  const claude = first.snapshots.find((item) => item.tool === 'claude-code');
  assert.equal(claude.tokens.byModel['claude-x'].totalTokens, 12);
  assert.equal(claude.quota.windows[0].usedPercent, 25);
  await commitUsageCursor(first.cursorPath, first.nextCursor);

  await appendFile(log, `${JSON.stringify({ message: { model: 'claude-x', usage: { input_tokens: 5, output_tokens: 1 } } })}\n`);
  const second = await collectUsageSnapshots({ now: new Date('2026-07-15T11:00:00.000Z'), homeDirectory: home, queryCodex: async () => null });
  assert.equal(second.snapshots.find((item) => item.tool === 'claude-code').tokens.byModel['claude-x'].totalTokens, 6);
  assert.equal(second.snapshots.find((item) => item.tool === 'claude-code').tokens.windowStart, '2026-07-15T10:00:00.000Z');
});

test('local OTLP receiver writes sanitized usage spool', async (t) => {
  await withCliHome(t);
  const receiver = await startOtelReceiver({ port: 0 });
  t.after(() => new Promise((resolve) => receiver.server.close(resolve)));
  const payload = { resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'claude_code.token.usage', sum: { dataPoints: [{ asInt: 8, attributes: [{ key: 'type', value: { stringValue: 'input' } }, { key: 'model', value: { stringValue: 'claude-x' } }] }] } }] }] }] };
  const response = await fetch(`http://127.0.0.1:${receiver.port}/v1/metrics`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(response.status, 200);
  const text = await readFile(receiver.spool, 'utf8');
  assert.equal(JSON.parse(text.trim()).usage.inputTokens, 8);
});


test('Codex app-server quota response is normalized through the official JSON-RPC flow', async () => {
  const spawnImpl = () => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stdin = {
      write(line) {
        const message = JSON.parse(line);
        if (message.id === 1) queueMicrotask(() => proc.stdout.write(`${JSON.stringify({ id: 1, result: { userAgent: 'test' } })}\n`));
        if (message.id === 2) queueMicrotask(() => proc.stdout.write(`${JSON.stringify({ id: 2, result: {
          rateLimitsByLimitId: {
            codex: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 15, resetsAt: 1784100000 }, secondary: null },
          },
        } })}\n`));
        return true;
      },
    };
    proc.kill = () => {};
    queueMicrotask(() => proc.emit('spawn'));
    return proc;
  };
  const result = await queryCodexAppServer({ spawnImpl });
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].windowId, 'primary');
  assert.equal(result.windows[0].usedPercent, 25);
  assert.equal(result.windows[0].windowDurationMinutes, 15);
});
