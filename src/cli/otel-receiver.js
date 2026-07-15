import http from 'node:http';
import path from 'node:path';
import { appendFile, mkdir } from 'node:fs/promises';
import { cliHome } from './session.js';

export async function startOtelReceiver({ host = '127.0.0.1', port = 4318, maxBodyBytes = 4 * 1024 * 1024 } = {}) {
  const spool = path.join(cliHome(), 'otel-usage.jsonl');
  await mkdir(path.dirname(spool), { recursive: true, mode: 0o700 });
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || !['/v1/metrics', '/v1/logs'].includes(request.url)) {
        response.writeHead(404).end();
        return;
      }
      const body = await readBody(request, maxBodyBytes);
      const rows = extractOtelUsage(body);
      if (rows.length) await appendFile(spool, rows.map((row) => `${JSON.stringify(row)}\n`).join(''), 'utf8');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
    } catch (error) {
      response.writeHead(error.status || 400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return { server, host, port: server.address().port, spool };
}

export function extractOtelUsage(payload) {
  const metricRows = extractMetrics(payload);
  if (metricRows.length) return metricRows;
  return extractLogs(payload);
}

function extractMetrics(payload) {
  const rows = [];
  for (const resource of payload?.resourceMetrics || []) {
    for (const scope of resource.scopeMetrics || []) {
      for (const metric of scope.metrics || []) {
        if (!['claude_code.token.usage', 'gen_ai.client.token.usage'].includes(metric.name)) continue;
        const points = metric.sum?.dataPoints || metric.gauge?.dataPoints || [];
        for (const point of points) {
          const attrs = attributes(point.attributes);
          const tokenType = attrs.type || attrs['gen_ai.token.type'] || 'input';
          const value = Number(point.asInt ?? point.asDouble ?? 0) || 0;
          rows.push(tokenRow(metric.name.startsWith('claude_code') ? 'claude-code' : 'other', attrs.model || attrs['gen_ai.request.model'] || 'unknown', tokenType, value));
        }
      }
    }
  }
  return mergeRows(rows);
}

function extractLogs(payload) {
  const rows = [];
  for (const resource of payload?.resourceLogs || []) {
    for (const scope of resource.scopeLogs || []) {
      for (const record of scope.logRecords || []) {
        const attrs = attributes(record.attributes);
        const name = attrs['event.name'] || attrs.event_name || stringValue(record.body);
        if (!String(name).includes('api_request')) continue;
        rows.push({
          tool: String(name).startsWith('claude_code') || attrs['service.name'] === 'claude-code' ? 'claude-code' : 'other',
          model: attrs.model || attrs['gen_ai.request.model'] || 'unknown',
          usage: {
            inputTokens: nonNegative(attrs.input_tokens),
            inputCachedTokens: nonNegative(attrs.cache_read_tokens),
            outputTokens: nonNegative(attrs.output_tokens),
            reasoningTokens: nonNegative(attrs.reasoning_tokens),
            totalTokens: nonNegative(attrs.input_tokens) + nonNegative(attrs.output_tokens),
          },
        });
      }
    }
  }
  return mergeRows(rows);
}

function tokenRow(tool, model, type, value) {
  const usage = { inputTokens: 0, inputCachedTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
  if (type === 'input') usage.inputTokens = nonNegative(value);
  else if (type === 'output') usage.outputTokens = nonNegative(value);
  else if (type === 'cacheRead' || type === 'cache_read') usage.inputCachedTokens = nonNegative(value);
  else if (type === 'reasoning') usage.reasoningTokens = nonNegative(value);
  usage.totalTokens = usage.inputTokens + usage.outputTokens;
  return { tool, model, usage };
}

function mergeRows(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = `${row.tool}|${row.model}`;
    const target = map.get(key) || { tool: row.tool, model: row.model, usage: { inputTokens: 0, inputCachedTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 } };
    for (const field of Object.keys(target.usage)) target.usage[field] += nonNegative(row.usage[field]);
    map.set(key, target);
  }
  return [...map.values()];
}

function attributes(values = []) {
  const result = {};
  for (const item of values) result[item.key] = anyValue(item.value);
  return result;
}
function anyValue(value) { return value?.stringValue ?? value?.intValue ?? value?.doubleValue ?? value?.boolValue ?? null; }
function stringValue(value) { return value?.stringValue ?? ''; }
function nonNegative(value) { return Math.max(0, Math.round(Number(value) || 0)); }

async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) { const error = new Error('OTLP body is too large.'); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
