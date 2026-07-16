#!/usr/bin/env node
// public-asset-integrity harness
// Fails if public/ has a broken local reference (referenced-but-missing js/css/html)
// or an orphaned asset (a js/css file not referenced by any html).
// Exit 0 = clean. Exit 1 = problems (listed on stderr). Zero dependencies.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const publicDir = path.join(root, 'public');

if (!existsSync(publicDir)) {
  process.stderr.write(`public-asset-integrity: no public/ directory at ${publicDir}\n`);
  process.exit(1);
}

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

const files = listFiles(publicDir);
const htmlFiles = files.filter((f) => f.toLowerCase().endsWith('.html'));
const assetFiles = files.filter((f) => /\.(js|css)$/i.test(f));

const refRe = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
const referenced = new Set();
const broken = [];

for (const html of htmlFiles) {
  const text = readFileSync(html, 'utf8');
  let m;
  while ((m = refRe.exec(text)) !== null) {
    let ref = m[1].trim();
    if (!ref) continue;
    if (/^(?:https?:)?\/\//i.test(ref)) continue;              // external / protocol-relative
    if (/^(?:data:|mailto:|tel:|javascript:|#)/i.test(ref)) continue;
    ref = ref.split('#')[0].split('?')[0];
    if (!ref || !/\.(js|css|html)$/i.test(ref)) continue;      // only track code/page assets
    const target = path.join(publicDir, ref.replace(/^\//, ''));
    referenced.add(path.resolve(target));
    if (!existsSync(target)) broken.push({ html: path.relative(root, html), ref });
  }
}

const orphans = assetFiles.filter((f) => !referenced.has(path.resolve(f)));

const problems = [];
for (const b of broken) problems.push(`BROKEN_REFERENCE: ${b.html} -> ${b.ref} (missing target)`);
for (const o of orphans) problems.push(`ORPHAN_ASSET: ${path.relative(root, o)} (not referenced by any html)`);

if (problems.length) {
  process.stderr.write('public-asset-integrity FAILED:\n' + problems.map((x) => '  - ' + x).join('\n') + '\n');
  process.exit(1);
}

process.stdout.write(`public-asset-integrity OK: ${htmlFiles.length} html, ${assetFiles.length} asset(s), no broken refs, no orphans.\n`);
process.exit(0);