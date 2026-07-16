#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const file = path.join(dataDir, 'discussions.json');
const db = JSON.parse(readFileSync(file, 'utf8'));
const seen = new Set();
const memories = [];
let removed = 0;

for (const memory of db.memories || []) {
  const signature = sourceSignature(memory.sourceMessageIds || []);
  if (seen.has(signature)) {
    removed += 1;
    continue;
  }
  seen.add(signature);
  memories.push({ ...memory, sourceSignatureSha256: signature });
}

db.memories = memories;
writeFileSync(file, `${JSON.stringify(db, null, 2)}\n`, 'utf8');
process.stdout.write(`Removed ${removed} duplicate discussion memories.\n`);

function sourceSignature(ids) {
  return createHash('sha256').update([...new Set(ids.map(String).filter(Boolean))].sort().join('\n')).digest('hex');
}
