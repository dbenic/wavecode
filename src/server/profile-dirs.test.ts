import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureProfileDirs } from './profiles.js';
import type { WaveConfig } from './config.js';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-pdirs-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const cfg = () => ({ profiles_root: root, profiles: { denis: {} }, runtimes: {} } as unknown as WaveConfig);

describe('ensureProfileDirs', () => {
  it('creates directory-valued env paths, but only the parent of file-valued ones (GIT_CONFIG_GLOBAL)', () => {
    const env = {
      CLAUDE_CONFIG_DIR: path.join(root, 'denis', 'claude'),
      GIT_CONFIG_GLOBAL: path.join(root, 'denis', 'gitconfig'),
      HOME: path.join(root, 'denis', 'grok-home'),
      PATH: '/usr/bin', // outside the profile: untouched
    };
    ensureProfileDirs('denis', env, cfg());
    expect(fs.statSync(path.join(root, 'denis', 'claude')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(root, 'denis', 'grok-home')).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(root, 'denis', 'gitconfig'))).toBe(false); // a file git writes later, never a dir
  });

  it('does not fail when a seeded gitconfig file already exists', () => {
    fs.mkdirSync(path.join(root, 'denis'), { recursive: true });
    fs.writeFileSync(path.join(root, 'denis', 'gitconfig'), '[user]\n\tname = denis\n');
    expect(() => ensureProfileDirs('denis', { GIT_CONFIG_GLOBAL: path.join(root, 'denis', 'gitconfig') }, cfg())).not.toThrow();
    expect(fs.statSync(path.join(root, 'denis', 'gitconfig')).isFile()).toBe(true);
  });
});
