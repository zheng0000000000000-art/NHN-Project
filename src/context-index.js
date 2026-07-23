import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { nowIso, sha256 } from './utils.js';

const DEFAULT_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.json', '.jsonl', '.yaml', '.yml', '.toml',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.html',
  '.py', '.java', '.kt', '.go', '.rs', '.swift', '.cs', '.sh', '.ps1',
]);
const DEFAULT_EXCLUDED = new Set([
  '.git', '.team-loop-worktrees', 'node_modules', 'dist', 'build', 'coverage',
  '.next', '.cache', 'data',
]);
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'then', 'than',
  '있는', '하는', '위한', '그리고', '에서', '으로', '기능', '작업', '파일', '코드',
]);

export class ContextIndex {
  constructor({ workspaceRoot, maxFileBytes = 256_000, chunkChars = 2_400 } = {}) {
    this.workspaceRoot = path.resolve(workspaceRoot || process.cwd());
    this.maxFileBytes = maxFileBytes;
    this.chunkChars = chunkChars;
    this.chunks = [];
    this.snapshot = emptySnapshot();
  }

  async initialize() {
    return this.refresh();
  }

  async refresh() {
    const files = await walkFiles(this.workspaceRoot);
    const chunks = [];
    let indexedFiles = 0;
    let skippedFiles = 0;
    let indexedCharacters = 0;

    for (const absolutePath of files) {
      const extension = path.extname(absolutePath).toLowerCase();
      if (!DEFAULT_EXTENSIONS.has(extension)) {
        skippedFiles += 1;
        continue;
      }
      const metadata = await stat(absolutePath).catch(() => null);
      if (!metadata?.isFile() || metadata.size > this.maxFileBytes) {
        skippedFiles += 1;
        continue;
      }
      const content = await readFile(absolutePath, 'utf8').catch(() => null);
      if (content === null || content.includes('\u0000')) {
        skippedFiles += 1;
        continue;
      }
      const relativePath = path.relative(this.workspaceRoot, absolutePath).replaceAll('\\', '/');
      const fileChunks = chunkText(content, this.chunkChars);
      const fileSha256 = sha256(content);
      fileChunks.forEach((text, index) => chunks.push(makeChunk(relativePath, index, text, fileSha256)));
      indexedFiles += 1;
      indexedCharacters += content.length;
    }

    this.chunks = chunks;
    this.snapshot = {
      indexedAt: nowIso(),
      indexedFiles,
      skippedFiles,
      chunks: chunks.length,
      indexedCharacters,
      estimatedTokens: estimateTokens(indexedCharacters),
      fingerprint: sha256(chunks.map((item) => `${item.path}:${item.sha256}`).join('|')),
    };
    return this.status();
  }

  status() {
    return { ...this.snapshot };
  }

  search(query, { maxChunks = 6, maxCharacters = 9_000, maxChunksPerFile = 2 } = {}) {
    const queryTokens = tokenize(query);
    if (queryTokens.size === 0) return packResult([], query, maxCharacters);

    const scored = this.chunks
      .map((chunk) => ({ chunk, score: scoreChunk(chunk, queryTokens) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.chunk.path.localeCompare(b.chunk.path) || a.chunk.index - b.chunk.index);

    const selected = [];
    const selectedPerFile = new Map();
    let characters = 0;
    for (const item of scored) {
      if (selected.length >= maxChunks) break;
      if ((selectedPerFile.get(item.chunk.path) || 0) >= maxChunksPerFile) continue;
      const remaining = maxCharacters - characters;
      if (remaining < 32) break;
      const text = item.chunk.text.length > remaining ? item.chunk.text.slice(0, remaining) : item.chunk.text;
      selected.push({
        path: item.chunk.path,
        chunk: item.chunk.index,
        score: item.score,
        text,
        fileSha256: item.chunk.fileSha256,
        contentSha256: item.chunk.sha256,
        truncated: text.length < item.chunk.text.length,
      });
      selectedPerFile.set(item.chunk.path, (selectedPerFile.get(item.chunk.path) || 0) + 1);
      characters += text.length;
    }
    return packResult(selected, query, maxCharacters);
  }
}

function emptySnapshot() {
  return { indexedAt: null, indexedFiles: 0, skippedFiles: 0, chunks: 0, indexedCharacters: 0, estimatedTokens: 0, fingerprint: null };
}

async function walkFiles(root) {
  const output = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && DEFAULT_EXCLUDED.has(entry.name)) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) output.push(target);
    }
  }
  await visit(root);
  return output;
}

function chunkText(content, maxChars) {
  const lines = String(content).replaceAll('\r\n', '\n').split('\n');
  const chunks = [];
  let current = [];
  let size = 0;
  for (const line of lines) {
    const addition = line.length + 1;
    if (current.length && size + addition > maxChars) {
      chunks.push(current.join('\n').trim());
      current = [];
      size = 0;
    }
    if (addition > maxChars) {
      for (let offset = 0; offset < line.length; offset += maxChars) chunks.push(line.slice(offset, offset + maxChars));
      continue;
    }
    current.push(line);
    size += addition;
  }
  if (current.length) chunks.push(current.join('\n').trim());
  return chunks.filter(Boolean);
}

function makeChunk(relativePath, index, text, fileSha256) {
  const pathTokens = tokenize(relativePath.replaceAll('/', ' '));
  const textTokens = tokenize(text);
  return { path: relativePath, index, text, pathTokens, textTokens, sha256: sha256(text), fileSha256 };
}

function scoreChunk(chunk, queryTokens) {
  let score = 0;
  for (const token of queryTokens) {
    if (chunk.pathTokens.has(token)) score += 6;
    if (chunk.textTokens.has(token)) score += 2;
    if (chunk.path.toLowerCase().includes(token)) score += 2;
  }
  if (/^(readme|docs)\//i.test(chunk.path) || /^readme\./i.test(chunk.path)) score += 0.5;
  return score;
}

function tokenize(value) {
  return new Set(String(value || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && !STOP_WORDS.has(item)));
}

function estimateTokens(characters) {
  return Math.ceil(Number(characters || 0) / 4);
}

function packResult(items, query, maxCharacters) {
  const characters = items.reduce((sum, item) => sum + item.text.length, 0);
  return {
    query: String(query || '').slice(0, 1000),
    sources: items,
    sourceCount: items.length,
    characters,
    estimatedTokens: estimateTokens(characters),
    budgetCharacters: maxCharacters,
  };
}
