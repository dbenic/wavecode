/**
 * Seat MCP registration (spec §5d): written only where the seat alone reads
 * it, with the seat token, private file mode, idempotent re-registration.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('registerSeatMcp', () => {
  let tmpDir: string;
  let root: string;
  let mcp: typeof import('./seat-mcp.js');

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-seatmcp-'));
    root = path.join(tmpDir, 'profiles');
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), [
      `profiles_root: ${root}`, 'profiles:', '  ana: {}',
      'artifacts:', `  storage: ${path.join(tmpDir, 'artifacts')}`, '',
    ].join('\n'));
    (await import('./config.js')).loadConfig(path.join(tmpDir, 'config.yaml'));
    mcp = await import('./seat-mcp.js');
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const base = { workspace: '', token: 'wc_seat_secret', daemonUrl: 'http://127.0.0.1:3777' };

  it('claude-code: HTTP server with the seat bearer in the seat workspace .mcp.json, pre-approved, 0600 — never the profile config', () => {
    const ws = path.join(tmpDir, 'seats', 'pm-ana');
    const profileConfig = path.join(root, 'ana', 'claude', '.claude.json');
    fs.mkdirSync(path.dirname(profileConfig), { recursive: true });
    fs.writeFileSync(profileConfig, JSON.stringify({ theme: 'dark' }));
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { other: { type: 'stdio', command: 'x' } } }));

    const res = mcp.registerSeatMcp({ ...base, runtime: 'claude-code', profile: 'ana', workspace: ws });
    expect(res).toEqual({ ok: true, file: path.join(ws, '.mcp.json') });
    const json = JSON.parse(fs.readFileSync(path.join(ws, '.mcp.json'), 'utf8'));
    expect(json.mcpServers.other).toEqual({ type: 'stdio', command: 'x' });
    expect(json.mcpServers.wavecode).toEqual({ type: 'http', url: 'http://127.0.0.1:3777/mcp', headers: { Authorization: 'Bearer wc_seat_secret' } });
    expect(fs.statSync(path.join(ws, '.mcp.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(path.join(ws, '.claude', 'settings.local.json'), 'utf8')).enabledMcpjsonServers).toEqual(['wavecode']);
    // the profile config every worker on ana's profile loads is untouched
    expect(JSON.parse(fs.readFileSync(profileConfig, 'utf8'))).toEqual({ theme: 'dark' });
  });

  it('re-registration replaces the token', () => {
    const ws = path.join(tmpDir, 'seats', 'pm-ana');
    mcp.registerSeatMcp({ ...base, runtime: 'claude-code', profile: 'ana', workspace: ws });
    mcp.registerSeatMcp({ ...base, token: 'wc_new', runtime: 'claude-code', profile: 'ana', workspace: ws });
    const text = fs.readFileSync(path.join(ws, '.mcp.json'), 'utf8');
    expect(text).toContain('Bearer wc_new');
    expect(text).not.toContain('wc_seat_secret');
  });

  it('refuses runtimes whose MCP config is shared by the profile (codex, …) — the token is never written there', () => {
    const ws = path.join(tmpDir, 'seats', 'pm-ana');
    const res = mcp.registerSeatMcp({ ...base, runtime: 'codex', profile: 'ana', workspace: ws });
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/shared by every agent on the profile/) });
    expect(fs.existsSync(path.join(root, 'ana', 'codex', 'config.toml'))).toBe(false);
    expect(mcp.registerSeatMcp({ ...base, runtime: 'aider', profile: null, workspace: ws }).ok).toBe(false);
  });
});
