#!/usr/bin/env node
import { constants } from 'node:fs';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const roots = ['apps/cli/dist', 'packages/core/dist', 'packages/mcp-gateway/dist'];
const runtimeLog = process.env.TOOLBX_TOKEN_LEAK_LOG ?? 'runtime-token-leak-check.log';
const patterns = [
  {
    name: 'bearer token',
    regex:
      /(?<!-)Bearer (?!resource_metadata=|realm=|token\b|scheme\b|challenge\b)[A-Za-z0-9._~+/-]+/g,
  },
  { name: 'access_token JSON field', regex: /"access_token":"[^"]+"/g },
];

async function* walk(target) {
  let info;
  try {
    info = await stat(target);
  } catch {
    return;
  }

  if (info.isFile()) {
    if (target.includes('/__tests__/') || target.includes('/__snapshots__/')) {
      return;
    }
    yield target;
    return;
  }

  if (!info.isDirectory()) {
    return;
  }

  for (const entry of await readdir(target)) {
    yield* walk(join(target, entry));
  }
}

async function scanFile(file, hits) {
  const text = await readFile(file, 'utf8').catch(() => '');
  for (const pattern of patterns) {
    if (pattern.regex.test(text)) {
      hits.push(`${file}: ${pattern.name}`);
    }
    pattern.regex.lastIndex = 0;
  }
}

async function ensureFileExists(file) {
  try {
    await access(file, constants.R_OK);
  } catch {
    console.error(`Token leak check failed: expected runtime log is missing: ${file}`);
    process.exit(1);
  }
}

const hits = [];
for (const root of roots) {
  for await (const file of walk(root)) {
    await scanFile(file, hits);
  }
}

await ensureFileExists(runtimeLog);
await scanFile(runtimeLog, hits);

if (hits.length > 0) {
  console.error('Token leak check failed:');
  for (const hit of hits) {
    console.error(`- ${hit}`);
  }
  process.exit(1);
}

console.log('Token leak check passed.');
