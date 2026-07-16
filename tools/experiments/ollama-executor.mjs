#!/usr/bin/env node
// Local-model custom executor for team-loop `dispatch --executor custom`.
// Reads the work-order (task brief + team rules + allowedPaths + acceptance criteria)
// on stdin, asks a local Ollama model for a strict JSON edit plan, applies it in cwd.
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';

const BASE = (process.env.AI_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const MODEL = process.env.AI_MODEL || 'qwen2.5-coder:14b';
const order = readFileSync(0, 'utf8');

const sys = [
  'You are a coding executor running inside a git worktree; the current working directory is the repo root.',
  'Read the WORK ORDER and output ONLY the file edits needed to satisfy the acceptance criteria.',
  'Reply with a single JSON object: {"actions":[ ... ]}. Each action is exactly one of:',
  '  {"op":"delete","path":"<relative path>"}',
  '  {"op":"write","path":"<relative path>","content":"<entire new file content>"}',
  '  {"op":"replace","path":"<relative path>","find":"<exact existing substring>","replace":"<new substring>"}',
  'Only touch files permitted by the work order allowed paths. Make the smallest change that satisfies the criteria.',
  'No prose, no markdown fences, no extra keys.',
].join('\n');

const body = { model: MODEL, stream: false, format: 'json',
  messages: [{ role: 'system', content: sys }, { role: 'user', content: order }] };

const res = await fetch(`${BASE}/api/chat`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
if (!res.ok) { console.error('[ollama-executor] http', res.status, await res.text()); process.exit(3); }
const data = await res.json();
const content = data.message?.content ?? '';
let plan;
try { plan = JSON.parse(content); } catch { console.error('[ollama-executor] JSON parse failed:', content.slice(0, 600)); process.exit(4); }
const actions = Array.isArray(plan.actions) ? plan.actions : [];
console.error(`[ollama-executor] model=${MODEL} actions=${actions.length}`);

const cwd = process.cwd();
for (const a of actions) {
  const rel = String(a.path || '').replace(/^[\\/]+/, '');
  const abs = path.resolve(cwd, rel);
  if (!abs.startsWith(cwd)) { console.error('  skip out-of-cwd:', rel); continue; }
  try {
    if (a.op === 'delete') {
      if (existsSync(abs)) { rmSync(abs); console.error('  deleted:', rel); }
      else console.error('  delete (missing, skip):', rel);
    } else if (a.op === 'write') {
      writeFileSync(abs, String(a.content ?? '')); console.error('  wrote:', rel);
    } else if (a.op === 'replace') {
      const before = readFileSync(abs, 'utf8');
      const after = before.split(String(a.find)).join(String(a.replace));
      writeFileSync(abs, after);
      console.error('  replaced in:', rel, before !== after ? '(changed)' : '(NO MATCH)');
    } else console.error('  unknown op:', a.op);
  } catch (e) { console.error('  action error on', rel, String(e && e.message || e)); }
}
process.exit(0);