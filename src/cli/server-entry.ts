import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ServerEntry {
  path: string;
  execArgv: string[];
}

export function resolveAppRoot(baseDir: string): string {
  return path.resolve(baseDir, '..', '..');
}

export function resolveServerEntry(baseDir: string): ServerEntry {
  const candidates: ServerEntry[] = [
    {
      path: path.join(baseDir, '..', 'server', 'index.ts'),
      execArgv: ['--import', 'tsx'],
    },
    {
      path: path.join(baseDir, '..', 'server', 'index.js'),
      execArgv: [],
    },
  ];

  const match = candidates.find((candidate) => fs.existsSync(candidate.path));
  if (!match) {
    throw new Error(`Unable to locate WaveCode server entry from ${baseDir}`);
  }

  return match;
}

export function getServerEntryUrl(baseDir: string): string {
  return pathToFileURL(resolveServerEntry(baseDir).path).href;
}
