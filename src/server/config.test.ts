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

  it('uses the documented safer default Claude runtime command', async () => {
    const { loadConfig, updateConfig, getConfig } = await import('./config.js');

    loadConfig(configPath);
    updateConfig({ server: { port: 4000, host: '0.0.0.0' } });

    const cfg = getConfig();
    expect(cfg.runtimes['claude-code']?.command).toBe('claude --permission-mode bypassPermissions');
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
      method: 'tailscale',
      fallback_token: null,
      trusted_proxies: [],
    });
  });
});
