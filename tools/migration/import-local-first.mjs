#!/usr/bin/env node
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [, , sourceArgument, outputArgument] = process.argv;
if (!sourceArgument) {
  console.error('Usage: node tools/migration/import-local-first.mjs <legacy-root> [output.json]');
  process.exit(2);
}

const sourceRoot = path.resolve(sourceArgument);
const outputPath = path.resolve(outputArgument || 'config/local-first-migration-candidates.json');
const failureDirectory = path.join(sourceRoot, 'docs', 'wiki', 'failures', 'cases');
const skillDirectory = path.join(sourceRoot, 'skills');

const failures = await readMarkdownFiles(failureDirectory, parseFailure);
const skills = await readMarkdownFiles(skillDirectory, parseSkill, true);
const bundle = {
  schemaVersion: 1,
  kind: 'team-loop-migration-candidates',
  source: sourceRoot,
  policy: {
    activation: 'manual-review-required',
    sourceMutation: false,
    importedRuntimeState: false,
  },
  failures,
  skills,
  counts: { failures: failures.length, skills: skills.length },
};

if (outputArgument) {
  await writeFile(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${failures.length} failure and ${skills.length} skill candidates to ${outputPath}`);
} else {
  console.log(JSON.stringify(bundle, null, 2));
}

async function readMarkdownFiles(directory, parser, recursive = false) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const output = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && recursive) output.push(...await readMarkdownFiles(target, parser, true));
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md' || entry.name.startsWith('_') || entry.name === 'README.md') continue;
    const content = await readFile(target, 'utf8');
    output.push(parser(content, path.relative(sourceRoot, target).replaceAll('\\', '/')));
  }
  return output;
}

function parseFailure(content, sourcePath) {
  const heading = firstMatch(content, /^#\s+(FAIL-\d{4}-\d+)\s*[—-]\s*(.+)$/m);
  return {
    sourceId: heading?.[1] || path.basename(sourcePath, '.md'),
    title: heading?.[2]?.trim() || firstHeading(content),
    status: field(content, ['상태', 'status']) || 'unknown',
    failureClass: listField(content, ['실패 분류', 'failure class', 'failureClass']),
    component: field(content, ['컴포넌트', 'component']) || null,
    sourcePath,
    summary: firstParagraph(content),
    disposition: 'CANDIDATE',
  };
}

function parseSkill(content, sourcePath) {
  return {
    id: path.basename(sourcePath, '.md'),
    title: firstHeading(content),
    version: field(content, ['버전', 'version']) || null,
    trigger: field(content, ['트리거', 'trigger']) || null,
    sourcePath,
    disposition: 'CANDIDATE',
  };
}

function firstHeading(content) {
  return firstMatch(content, /^#\s+(.+)$/m)?.[1]?.trim() || '';
}

function firstParagraph(content) {
  return content.replace(/^#.*$/gm, '').split(/\r?\n\s*\r?\n/).map((item) => item.trim()).find((item) => item && !item.startsWith('|'))?.slice(0, 2000) || '';
}

function field(content, labels) {
  for (const label of labels) {
    const match = content.match(new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?${escapeRegExp(label)}\\s*[:：]\\s*([^\\r\\n|]+)`, 'i'));
    if (match) return match[1].trim();
  }
  return '';
}

function listField(content, labels) {
  const value = field(content, labels);
  return value ? value.split(/[,/]/).map((item) => item.trim()).filter(Boolean) : [];
}

function firstMatch(value, expression) {
  return expression.exec(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
