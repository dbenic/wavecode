import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAppRoot, resolveServerEntry } from './server-entry.js';

describe('resolveServerEntry', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it('prefers the TypeScript server entry when running from source', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-cli-source-'));
    tmpDirs.push(root);

    const cliDir = path.join(root, 'src', 'cli');
    const serverDir = path.join(root, 'src', 'server');
    fs.mkdirSync(cliDir, { recursive: true });
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(path.join(serverDir, 'index.ts'), 'export {};');

    expect(resolveServerEntry(cliDir)).toEqual({
      path: path.join(serverDir, 'index.ts'),
      execArgv: ['--import', 'tsx'],
    });
  });

  it('falls back to the compiled JavaScript server entry for packaged builds', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-cli-dist-'));
    tmpDirs.push(root);

    const cliDir = path.join(root, 'dist', 'cli');
    const serverDir = path.join(root, 'dist', 'server');
    fs.mkdirSync(cliDir, { recursive: true });
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(path.join(serverDir, 'index.js'), 'export {};');

    expect(resolveServerEntry(cliDir)).toEqual({
      path: path.join(serverDir, 'index.js'),
      execArgv: [],
    });
  });

  it('throws when neither server entry exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-cli-missing-'));
    tmpDirs.push(root);

    const cliDir = path.join(root, 'dist', 'cli');
    fs.mkdirSync(cliDir, { recursive: true });

    expect(() => resolveServerEntry(cliDir)).toThrow('Unable to locate WaveCode server entry');
  });

  it('resolves the install root for source and packaged layouts', () => {
    expect(resolveAppRoot('/tmp/wavecode/src/cli')).toBe('/tmp/wavecode');
    expect(resolveAppRoot('/tmp/wavecode/dist/cli')).toBe('/tmp/wavecode');
  });
});
