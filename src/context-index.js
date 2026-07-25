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
// 관련도 점수와 섞이지 않도록 고정 선택에는 별도의 표식 값을 쓴다. 실제 점수가 아니다.
const PINNED_SCORE = -1;

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
    this.archiveChunks = [];
    this.snapshot = emptySnapshot();
  }

  async initialize() {
    return this.refresh();
  }

  async refresh() {
    const files = await walkFiles(this.workspaceRoot);
    const chunks = [];
    const archiveChunks = [];
    let indexedFiles = 0;
    let archivedFiles = 0;
    let skippedFiles = 0;
    let indexedCharacters = 0;
    let archivedCharacters = 0;

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
      const historical = isArchivePath(relativePath);
      const target = historical ? archiveChunks : chunks;
      fileChunks.forEach((text, index) => target.push(makeChunk(relativePath, index, text, fileSha256, historical)));
      if (historical) {
        archivedFiles += 1;
        archivedCharacters += content.length;
      } else {
        indexedFiles += 1;
        indexedCharacters += content.length;
      }
    }

    this.chunks = chunks;
    this.archiveChunks = archiveChunks;
    this.snapshot = {
      indexedAt: nowIso(),
      indexedFiles,
      skippedFiles,
      chunks: chunks.length,
      indexedCharacters,
      estimatedTokens: estimateTokens(indexedCharacters),
      archive: {
        indexedFiles: archivedFiles,
        chunks: archiveChunks.length,
        indexedCharacters: archivedCharacters,
        estimatedTokens: estimateTokens(archivedCharacters),
        defaultExcluded: true,
        fingerprint: sha256(archiveChunks.map((item) => `${item.path}:${item.sha256}`).join('|')),
      },
      fingerprint: sha256(chunks.map((item) => `${item.path}:${item.sha256}`).join('|')),
    };
    return this.status();
  }

  status() {
    return { ...this.snapshot };
  }

  // pinnedPaths: 작업이 고쳐야 할 파일. 관련도 검색은 질의어가 겹치는 이웃을 올리므로,
  // 정작 손댈 파일이 빠진 팩이 나온다(실측: 기록된 팩 34건 중 21건). 먼저 담고 남은 예산으로
  // 검색 결과를 채운다. 예산은 늘리지 않는다 — 고칠 파일이 이웃보다 우선일 뿐이다.
  search(query, { maxChunks = 6, maxCharacters = 9_000, maxChunksPerFile = 2, historical = false, pinnedPaths = [] } = {}) {
    maxChunks = positiveNumber(maxChunks, 6);
    maxCharacters = positiveNumber(maxCharacters, 9_000);
    maxChunksPerFile = positiveNumber(maxChunksPerFile, 2);
    const pool = historical ? this.archiveChunks : this.chunks;
    const selected = [];
    const selectedPerFile = new Map();
    const taken = new Set();
    let characters = 0;
    const take = (chunk, score) => {
      if (selected.length >= maxChunks) return false;
      const key = `${chunk.path}#${chunk.index}`;
      if (taken.has(key)) return true;
      if ((selectedPerFile.get(chunk.path) || 0) >= maxChunksPerFile) return true;
      const remaining = maxCharacters - characters;
      if (remaining < 32) return false;
      const text = chunk.text.length > remaining ? chunk.text.slice(0, remaining) : chunk.text;
      selected.push({
        path: chunk.path,
        chunk: chunk.index,
        score,
        text,
        fileSha256: chunk.fileSha256,
        contentSha256: chunk.sha256,
        truncated: text.length < chunk.text.length,
        historical: chunk.historical,
        pinned: score === PINNED_SCORE,
      });
      taken.add(key);
      selectedPerFile.set(chunk.path, (selectedPerFile.get(chunk.path) || 0) + 1);
      characters += text.length;
      return true;
    };

    const pinned = new Set(
      (Array.isArray(pinnedPaths) ? pinnedPaths : [])
        .map((item) => String(item ?? '').trim().replace(/\\/g, '/'))
        .filter((item) => item && !/[*?[\]]/.test(item)),
    );
    if (pinned.size) {
      const inScope = pool
        .filter((chunk) => pinned.has(chunk.path))
        .sort((a, b) => a.path.localeCompare(b.path) || a.index - b.index);
      for (const chunk of inScope) if (!take(chunk, PINNED_SCORE)) break;
    }

    const queryTokens = tokenize(query);
    if (queryTokens.size === 0) return packResult(selected, query, maxCharacters, historical);

    const scored = pool
      .map((chunk) => ({ chunk, score: scoreChunk(chunk, queryTokens) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.chunk.path.localeCompare(b.chunk.path) || a.chunk.index - b.chunk.index);

    for (const item of scored) {
      if (!take(item.chunk, item.score)) break;
    }
    return packResult(selected, query, maxCharacters, historical);
  }
}

function emptySnapshot() {
  return {
    indexedAt: null, indexedFiles: 0, skippedFiles: 0, chunks: 0, indexedCharacters: 0, estimatedTokens: 0, fingerprint: null,
    archive: { indexedFiles: 0, chunks: 0, indexedCharacters: 0, estimatedTokens: 0, defaultExcluded: true, fingerprint: null },
  };
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

function makeChunk(relativePath, index, text, fileSha256, historical = false) {
  const pathTokens = tokenize(relativePath.replaceAll('/', ' '));
  const textTokens = tokenize(text);
  return { path: relativePath, index, text, pathTokens, textTokens, sha256: sha256(text), fileSha256, historical };
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

function packResult(items, query, maxCharacters, historical = false) {
  const characters = items.reduce((sum, item) => sum + item.text.length, 0);
  return {
    query: String(query || '').slice(0, 1000),
    sources: items,
    sourceCount: items.length,
    characters,
    estimatedTokens: estimateTokens(characters),
    budgetCharacters: maxCharacters,
    historical,
    warning: historical ? 'Historical archive sources may describe superseded behavior and must not override current contracts.' : null,
  };
}

function isArchivePath(relativePath) {
  return String(relativePath).replaceAll('\\', '/').startsWith('docs/archive/');
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
