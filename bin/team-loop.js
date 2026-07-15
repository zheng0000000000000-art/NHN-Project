#!/usr/bin/env node
import { ApiError } from '../src/cli/client.js';
import { runCli } from '../src/cli/main.js';

try {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
} catch (error) {
  const prefix = error instanceof ApiError ? `HTTP ${error.status}: ` : '';
  console.error(`${prefix}${error.message}`);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exitCode = error instanceof ApiError && error.status === 409 ? 3 : 1;
}
