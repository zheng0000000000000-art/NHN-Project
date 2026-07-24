import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

test('MCP exposes remote file exchange and no client-side worktree tools', async () => {
  const child = spawn(process.execPath, [path.resolve('mcp/team-loop-mcp.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const output = new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('MCP response timeout')), 3000);
    child.stdout.on('data', (chunk) => {
      text += chunk;
      const line = text.split('\n').find((item) => item.trim());
      if (!line) return;
      clearTimeout(timer);
      resolve(JSON.parse(line));
    });
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })}\n`);
  const response = await output;
  child.stdin.end();
  const names = response.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('read_task_files'));
  assert.ok(names.includes('submit_task_result'));
  assert.ok(names.includes('experience_prepare'));
  assert.ok(names.includes('experience_contracts'));
  assert.ok(names.includes('experience_reflect'));
  assert.ok(names.includes('context_pack_prepare'));
  assert.ok(names.includes('context_pack_list'));
  assert.ok(names.includes('context_pack_get'));
  assert.ok(names.includes('context_pack_lock'));
  assert.ok(names.includes('promotion_status'));
  assert.ok(names.includes('promotion_scan'));
  assert.ok(names.includes('promotion_audit'));
  assert.ok(names.includes('portfolio_enter'));
  assert.ok(names.includes('project_enter'));
  assert.ok(names.includes('project_read_plan'));
  assert.ok(names.includes('work_inspect'));
  assert.ok(names.includes('handoff_read'));
  assert.ok(names.includes('handoff_write'));
  assert.ok(names.includes('context_archive_search'));
  assert.ok(names.includes('balance_run'));
  assert.ok(names.includes('wiki_search'));
  assert.ok(names.includes('wiki_propose'));
  assert.ok(!names.includes('create_worktree'));
  assert.ok(!names.includes('remove_worktree'));
});
