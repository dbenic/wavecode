/**
 * Phase 1 Security Tests — config.ts (file permissions, key masking)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('config.ts — security', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-test-'));
    configPath = path.join(tmpDir, 'config.yaml');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('writes config.yaml with restricted permissions (0600)', async () => {
    // Import fresh module to avoid cached state
    const { loadConfig, updateConfig } = await import('./config.js');

    // Load config pointing to our temp file
    loadConfig(configPath);

    // Update config to trigger a write
    updateConfig({ server: { port: 4000, host: '0.0.0.0' } });

    // Verify the file exists
    expect(fs.existsSync(configPath)).toBe(true);

    // Check file permissions (Unix only)
    if (process.platform !== 'win32') {
      const stat = fs.statSync(configPath);
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('defaults Codex effort_flag so high/xhigh pins are injected', async () => {
    const { loadConfig, getConfig } = await import('./config.js');
    loadConfig(configPath);
    expect(getConfig().runtimes.codex?.effort_flag).toBe('-c model_reasoning_effort=');
    expect(getConfig().projects).toEqual({});
  });

  it('loads a per-project referee profile from yaml', async () => {
    fs.writeFileSync(configPath, `
projects:
  wavepulse:
    workspace_match: '**/wavepulse*'
    gate:
      command: wavepulse-gate
      branch: landing-v3-human-first
      mode: full
      baseline_glob: ~/gate-results/landing-v3-human-first-*-full.log
    require_result_to_promote: true
`, 'utf8');

    const { loadConfig } = await import('./config.js');
    const cfg = loadConfig(configPath);
    expect(cfg.projects.wavepulse?.workspace_match).toBe('**/wavepulse*');
    expect(cfg.projects.wavepulse?.gate?.command).toBe('wavepulse-gate');
    expect(cfg.projects.wavepulse?.gate?.branch).toBe('landing-v3-human-first');
    expect(cfg.projects.wavepulse?.gate?.mode).toBe('full');
    expect(cfg.projects.wavepulse?.require_result_to_promote).toBe(true);
  });

  it('uses the live no-click bypass runtime commands', async () => {
    const { loadConfig, updateConfig, getConfig } = await import('./config.js');

    loadConfig(configPath);
    updateConfig({ server: { port: 4000, host: '0.0.0.0' } });

    const cfg = getConfig();
    expect(cfg.runtimes['claude-code']?.command).toBe('claude --dangerously-skip-permissions');
    expect(cfg.runtimes.grok?.command).toBe('grok --always-approve');
    expect(cfg.runtimes.codex?.command).toBe(
      'codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust',
    );
  });

  it('ignores disallowed top-level updates such as auth overrides', async () => {
    const { loadConfig, updateConfig, getConfig } = await import('./config.js');

    loadConfig(configPath);

    updateConfig({
      auth: {
        method: 'token',
        fallback_token: 'should-not-apply',
        trusted_proxies: ['loopback'],
      },
    } as unknown as Parameters<typeof updateConfig>[0]);

    expect(getConfig().auth).toEqual({
      method: 'token',
      fallback_token: null,
      trusted_proxies: [],
    });
  });

  it('expands home-relative paths and resolves relative paths from the config directory', async () => {
    fs.writeFileSync(configPath, `
paths:
  projects_root: ~/WaveProjects
  guides_root: guides
artifacts:
  storage: .wavecode-artifacts
`, 'utf8');

    const { loadConfig } = await import('./config.js');
    const cfg = loadConfig(configPath);

    expect(cfg.paths.projects_root).toBe(path.join(os.homedir(), 'WaveProjects'));
    expect(cfg.paths.guides_root).toBe(path.join(tmpDir, 'guides'));
    expect(cfg.artifacts.storage).toBe(path.join(tmpDir, '.wavecode-artifacts'));
  });

  it('builds default filesystem paths relative to the config location', async () => {
    const { loadConfig } = await import('./config.js');
    const cfg = loadConfig(configPath);

    expect(cfg.paths.worktrees_root).toBe(path.join(tmpDir, '.wavecode-data', 'worktrees'));
    expect(cfg.paths.transcripts_root).toBe(path.join(tmpDir, '.wavecode-data', 'transcripts'));
    expect(cfg.paths.teams_root).toBe(path.join(tmpDir, 'teams'));
  });

  it('creates the artifact storage directory at startup if it does not exist', async () => {
    const storageDir = path.join(tmpDir, 'fresh-storage');
    fs.writeFileSync(configPath, `
artifacts:
  storage: ${storageDir}
`, 'utf8');

    const { loadConfig } = await import('./config.js');
    expect(() => loadConfig(configPath)).not.toThrow();
    expect(fs.existsSync(storageDir)).toBe(true);
  });

  it('throws a clear error when artifact storage cannot be created (unwritable parent)', async () => {
    if (process.platform === 'win32') return; // permissions semantics differ on Windows

    // Build a path under an unwritable parent so mkdir fails
    const lockedParent = path.join(tmpDir, 'locked');
    fs.mkdirSync(lockedParent);
    fs.chmodSync(lockedParent, 0o555); // read+execute, no write

    const storageDir = path.join(lockedParent, 'storage');
    fs.writeFileSync(configPath, `
artifacts:
  storage: ${storageDir}
`, 'utf8');

    const { loadConfig } = await import('./config.js');
    expect(() => loadConfig(configPath)).toThrow(/Cannot create artifact storage directory/);

    // Restore so afterEach cleanup can rm -rf
    fs.chmodSync(lockedParent, 0o755);
  });

  it('throws a clear error when artifact storage exists but is not writable', async () => {
    if (process.platform === 'win32') return;
    if (process.getuid && process.getuid() === 0) return; // root bypasses permissions

    const storageDir = path.join(tmpDir, 'readonly-storage');
    fs.mkdirSync(storageDir);
    fs.chmodSync(storageDir, 0o555);

    fs.writeFileSync(configPath, `
artifacts:
  storage: ${storageDir}
`, 'utf8');

    const { loadConfig } = await import('./config.js');
    expect(() => loadConfig(configPath)).toThrow(/not writable/);

    fs.chmodSync(storageDir, 0o755);
  });
});
