/**
 * Production server code must not block the event loop with synchronous
 * process APIs. Tests and the CLI are outside this scan.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SERVER = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SERVER, '..');
const BANNED = /\b(execFileSync|execSync|spawnSync|Atomics\.wait)\b/;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...productionFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('server event loop', () => {
  it('does not call execFileSync, execSync, spawnSync, or Atomics.wait under src/server', () => {
    const hits: string[] = [];
    for (const file of productionFiles(SERVER)) {
      const body = stripComments(fs.readFileSync(file, 'utf8'));
      if (BANNED.test(body)) hits.push(path.relative(ROOT, file));
    }
    expect(hits).toEqual([]);
  });
});
