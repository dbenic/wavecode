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

  it('claude-code on a profile: the seat workspace project config — NEVER the profile-wide .claude.json every worker on that profile reads', () => {
    const profileCfg = path.join(root, 'ana', 'claude', '.claude.json');
    fs.mkdirSync(path.dirname(profileCfg), { recursive: true });
    const before = JSON.stringify({ theme: 'dark', mcpServers: { other: { type: 'stdio', command: 'x' } } });
    fs.writeFileSync(profileCfg, before);
    const ws = path.join(tmpDir, 'ws');

    const res = mcp.registerSeatMcp({ ...base, runtime: 'claude-code', profile: 'ana', workspace: ws });
    expect(res).toEqual({ ok: true, file: path.join(ws, '.mcp.json') });
    // the shared profile config is untouched: a builder spawned on ana's profile must not inherit her seat token
    expect(fs.readFileSync(profileCfg, 'utf8')).toBe(before);
    const json = JSON.parse(fs.readFileSync(path.join(ws, '.mcp.json'), 'utf8'));
    expect(json.mcpServers.wavecode).toEqual({ type: 'http', url: 'http://127.0.0.1:3777/mcp', headers: { Authorization: 'Bearer wc_seat_secret' } });
    expect(fs.statSync(path.join(ws, '.mcp.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(path.join(ws, '.claude', 'settings.local.json'), 'utf8')).enabledMcpjsonServers).toEqual(['wavecode']);
  });

  it('refuses to overwrite a config file that is not valid JSON (never clobbers CLI state)', () => {
    const ws = path.join(tmpDir, 'ws-broken');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, '.mcp.json'), '{ this is not json');
    const res = mcp.registerSeatMcp({ ...base, runtime: 'claude-code', profile: null, workspace: ws });
    expect(res.ok).toBe(false);
    expect(fs.readFileSync(path.join(ws, '.mcp.json'), 'utf8')).toBe('{ this is not json');
  });

  it('claude-code without a profile: the seat workspace project config, pre-approved — never the shared home config', () => {
    const ws = path.join(tmpDir, 'seats', 'pm-owner');
    const res = mcp.registerSeatMcp({ ...base, runtime: 'claude-code', profile: null, workspace: ws });
    expect(res).toEqual({ ok: true, file: path.join(ws, '.mcp.json') });
    expect(JSON.parse(fs.readFileSync(path.join(ws, '.mcp.json'), 'utf8')).mcpServers.wavecode.headers.Authorization).toBe('Bearer wc_seat_secret');
    expect(JSON.parse(fs.readFileSync(path.join(ws, '.claude', 'settings.local.json'), 'utf8')).enabledMcpjsonServers).toEqual(['wavecode']);
  });

  it('codex on a profile: stdio block in $CODEX_HOME/config.toml, replaced (not duplicated) on re-registration', () => {
    const file = path.join(root, 'ana', 'codex', 'config.toml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'model = "gpt-5.2"\n\n[mcp_servers.other]\ncommand = "x"\n');
    const cli = { node: '/usr/bin/node', entry: '/opt/wavecode/dist/cli/index.js' };

    expect(mcp.registerSeatMcp({ ...base, runtime: 'codex', profile: 'ana', cli }).ok).toBe(true);
    expect(mcp.registerSeatMcp({ ...base, token: 'wc_new', runtime: 'codex', profile: 'ana', cli }).ok).toBe(true);
    const toml = fs.readFileSync(file, 'utf8');
    expect(toml).toContain('model = "gpt-5.2"');
    expect(toml).toContain('[mcp_servers.other]\ncommand = "x"');
    expect(toml.match(/\[mcp_servers\.wavecode\]/g)).toHaveLength(1);
    expect(toml).toContain('command = "/usr/bin/node"\nargs = ["/opt/wavecode/dist/cli/index.js", "mcp"]');
    expect(toml).toContain('WAVECODE_TOKEN = "wc_new"');
    expect(toml).not.toContain('wc_seat_secret');
    expect(toml).toContain('WAVECODE_URL = "http://127.0.0.1:3777"');
  });

  it('refuses where the config would be shared, and runtimes without a registrar', () => {
    expect(mcp.registerSeatMcp({ ...base, runtime: 'codex', profile: null })).toMatchObject({ ok: false, error: expect.stringMatching(/shared/) });
    expect(mcp.registerSeatMcp({ ...base, runtime: 'aider', profile: 'ana' })).toMatchObject({ ok: false, error: expect.stringMatching(/manually/) });
    // claude-code registration is project-scoped and no longer touches the profile; profile validity is enforced at seat creation
  });
});
