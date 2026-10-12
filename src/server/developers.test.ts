import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { laneMatches, matchDeveloper } from './developers.js';

describe('developer identity', () => {
  it('matches a user name or a bearer token, and lane globs', () => {
    const list = [
      { name: 'Antonio', users: ['antonio'], tokens: ['antonio-token'], lanes: ['wc-s3-*', 'wc-eba-*'] },
      { name: 'Aleš', users: ['ales'], lanes: ['wc-ales-*', 'wc-recognition-*'] },
    ];
    expect(matchDeveloper(list, { name: 'Antonio' }, null)?.name).toBe('Antonio');
    expect(matchDeveloper(list, { name: 'owner' }, 'antonio-token')?.name).toBe('Antonio');
    expect(matchDeveloper(list, { name: 'ales' }, null)?.name).toBe('Aleš');
    expect(matchDeveloper(list, { name: 'denis' }, 'nope')).toBeNull();
    expect(laneMatches(list[0].lanes, 'wc-eba-viewer')).toBe(true);
    expect(laneMatches(list[0].lanes, 'wc-recognition-timeout')).toBe(false);
  });
});

describe('developers config', () => {
  let tmpDir: string;
  let configPath: string;

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('loads developers and refuses a list with no identity', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-dev-'));
    configPath = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(configPath, `
developers:
  - name: Aleš
    users: [ales]
    lanes: ['wc-ales-*']
`, 'utf8');
    const { loadConfig } = await import('./config.js');
    expect(loadConfig(configPath).developers?.[0]?.name).toBe('Aleš');
    vi.resetModules();
    fs.writeFileSync(configPath, `
developers:
  - name: Antonio
    lanes: ['wc-s3-*']
`, 'utf8');
    const again = await import('./config.js');
    expect(() => again.loadConfig(configPath)).toThrow(/users or tokens/);
  });
});