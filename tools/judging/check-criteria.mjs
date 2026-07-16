#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const mode = process.argv[2] || 'all';
const root = path.resolve(process.env.SUBMISSION_ROOT || process.cwd());
const strict = process.argv.includes('--strict') || process.env.JUDGING_STRICT === 'true';

const checks = [];

if (mode === 'all' || mode === 'integrity') checkSubmissionIntegrity();
if (mode === 'all' || mode === 'repo-history') checkRepositoryHistory();
if (mode === 'all' || mode === 'ops-stability') checkOperationalStability();

const failed = checks.filter((check) => check.status === 'FAIL');
for (const check of checks) {
  const detail = check.detail ? ` - ${check.detail}` : '';
  process.stdout.write(`${check.status} ${check.id}: ${check.message}${detail}\n`);
}
process.exitCode = failed.length ? 1 : 0;

function checkSubmissionIntegrity() {
  const required = listFromEnv('SUBMISSION_REQUIRED_FILES', [
    'README.md',
    'package.json',
  ]);
  for (const relative of required) {
    const target = path.join(root, relative);
    add(existsSync(target), 'T0-FILE', `required file exists: ${relative}`);
  }

  const forbidden = listFromEnv('SUBMISSION_FORBIDDEN_EXTENSIONS', ['.exe']);
  for (const file of gitFiles()) {
    if (forbidden.includes(path.extname(file).toLowerCase())) {
      add(false, 'T0-FORBIDDEN', `forbidden artifact extension found`, file);
    }
  }

  const video = process.env.SUBMISSION_VIDEO;
  if (video) {
    const target = path.resolve(root, video);
    add(existsSync(target), 'T0-VIDEO', `video file exists: ${video}`);
    if (existsSync(target)) add(statSync(target).size > 0, 'T0-VIDEO-NONEMPTY', 'video file is non-empty', `${statSync(target).size} bytes`);
  } else {
    add(!strict, 'T0-VIDEO', 'video path not configured; set SUBMISSION_VIDEO for strict check');
  }

  const runUrl = process.env.SUBMISSION_RUN_URL;
  if (runUrl) {
    add(/^https?:\/\//.test(runUrl), 'T0-RUN-LINK', 'run link is an HTTP(S) URL', runUrl);
  } else {
    add(!strict, 'T0-RUN-LINK', 'run link not configured; set SUBMISSION_RUN_URL for strict check');
  }
}

function checkRepositoryHistory() {
  const count = numberFromGit(['rev-list', '--count', 'HEAD']);
  add(count >= numberEnv('JUDGING_MIN_COMMITS', 5), 'T4-COMMITS', 'repository has enough commits', `${count}`);

  const contributors = textFromGit(['shortlog', '-sn', 'HEAD']).split(/\r?\n/).filter(Boolean).length;
  add(contributors >= numberEnv('JUDGING_MIN_CONTRIBUTORS', 1), 'T4-CONTRIBUTORS', 'repository has contributor evidence', `${contributors}`);

  const latestBatch = numberFromGit(['diff', '--stat', 'HEAD~1..HEAD'], { fallback: 0 });
  add(true, 'T4-LATEST-DIFF', 'latest commit diff stat is readable', `${latestBatch} chars`);

  const docs = gitFiles().filter((file) => /(^|\/)(README|docs\/|.*\.md$)/i.test(file));
  add(docs.length >= numberEnv('JUDGING_MIN_DOC_FILES', 2), 'T4-DOCS', 'repository contains documentation files', `${docs.length}`);

  const secretHits = grepSecrets();
  add(secretHits.length === 0, 'T4-SECRETS', 'repository does not expose obvious API keys', secretHits.slice(0, 3).join('; '));
}

function checkOperationalStability() {
  const packageJson = readJson(path.join(root, 'package.json'));
  add(Boolean(packageJson), 'T5-PACKAGE', 'package.json is readable');
  if (packageJson) {
    add(Boolean(packageJson.scripts?.test || packageJson.scripts?.check), 'T5-TEST-SCRIPT', 'test or check script exists');
  }

  const text = readTextFiles(['README.md', ...gitFiles().filter((file) => file.startsWith('docs/') && file.endsWith('.md'))]).toLowerCase();
  add(/fallback|degrad|offline|api key|quota|rate limit|cache|cost|token/.test(text), 'T5-OPS-DOC', 'docs mention cost, quota, cache, fallback, or API-key behavior');

  const healthUrl = process.env.SUBMISSION_HEALTH_URL;
  if (healthUrl) {
    try {
      const result = execFileSync(process.execPath, ['-e', `const r=await fetch(${JSON.stringify(healthUrl)}); process.exit(r.ok?0:1)`], { timeout: 15000 });
      add(result !== null, 'T5-HEALTH', 'health URL responds successfully', healthUrl);
    } catch {
      add(false, 'T5-HEALTH', 'health URL failed', healthUrl);
    }
  } else {
    add(!strict, 'T5-HEALTH', 'health URL not configured; set SUBMISSION_HEALTH_URL for strict check');
  }
}

function add(condition, id, message, detail = '') {
  checks.push({ status: condition ? 'PASS' : 'FAIL', id, message, detail });
}

function listFromEnv(name, fallback) {
  return process.env[name] ? process.env[name].split(';').map((item) => item.trim()).filter(Boolean) : fallback;
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function gitFiles() {
  try {
    return textFromGit(['ls-files']).split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function textFromGit(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30000 });
}

function numberFromGit(args, { fallback = Number.NaN } = {}) {
  try {
    const value = Number(textFromGit(args).trim());
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function grepSecrets() {
  const patterns = [
    /sk-[a-zA-Z0-9_-]{20,}/,
    /api[_-]?key\s*[:=]\s*['"][^'"]{12,}/i,
    /secret\s*[:=]\s*['"][^'"]{12,}/i,
  ];
  const hits = [];
  for (const file of gitFiles()) {
    if (!/\.(js|mjs|ts|tsx|json|md|env|txt|yaml|yml)$/i.test(file)) continue;
    const text = safeRead(path.join(root, file));
    if (!text) continue;
    if (patterns.some((pattern) => pattern.test(text))) hits.push(file);
  }
  return hits;
}

function readTextFiles(files) {
  return files.map((file) => safeRead(path.join(root, file))).join('\n');
}

function safeRead(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
