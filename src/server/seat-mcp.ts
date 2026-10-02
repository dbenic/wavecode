/**
 * Register the `wavecode` MCP server inside an orchestrator seat's own CLI
 * config with the seat token (spec §5d), so the seat drives WaveCode as its
 * user. Only ever written where *this seat alone* reads it: the user's
 * credential-profile dir, or the seat's workspace — never a shared login,
 * where every agent would inherit the user's identity. Files are 0600; the
 * token is never logged.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';
import { resolveProfileEnv } from './profiles.js';

export interface SeatMcpInput {
  runtime: string;
  profile: string | null;
  workspace: string;
  token: string;
  /** Daemon base URL, e.g. http://127.0.0.1:3777 */
  daemonUrl: string;
  /** Node + CLI entry for stdio MCP (`<node> <cli> mcp`) */
  cli?: { node: string; entry: string };
}

export type SeatMcpResult = { ok: true; file: string } | { ok: false; error: string };

export function daemonUrl(): string {
  const { port } = getConfig().server;
  return `http://127.0.0.1:${port}`;
}

function writePrivate(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function readJson(file: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Claude Code: an HTTP MCP server with the seat token as bearer. With a
 * profile it goes into that profile's user config (`$CLAUDE_CONFIG_DIR/.claude.json`);
 * without one, into the seat workspace's project config (`.mcp.json`, pre-approved
 * in `.claude/settings.local.json`).
 */
function registerClaude(input: SeatMcpInput): SeatMcpResult {
  const server = {
    type: 'http',
    url: `${input.daemonUrl}/mcp`,
    headers: { Authorization: `Bearer ${input.token}` },
  };
  let file: string;
  if (input.profile) {
    const env = resolveProfileEnv(input.runtime, input.profile);
    if (!env.ok) return env;
    const dir = env.data.CLAUDE_CONFIG_DIR;
    if (!dir) return { ok: false, error: `Runtime '${input.runtime}' has no CLAUDE_CONFIG_DIR for profile '${input.profile}'` };
    file = path.join(dir, '.claude.json');
  } else {
    file = path.join(input.workspace, '.mcp.json');
    const settingsFile = path.join(input.workspace, '.claude', 'settings.local.json');
    const settings = readJson(settingsFile);
    const enabled = new Set([...(Array.isArray(settings.enabledMcpjsonServers) ? settings.enabledMcpjsonServers as string[] : []), 'wavecode']);
    writePrivate(settingsFile, JSON.stringify({ ...settings, enabledMcpjsonServers: [...enabled] }, null, 2));
  }
  const config = readJson(file);
  const servers = (config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {}) as Record<string, unknown>;
  writePrivate(file, JSON.stringify({ ...config, mcpServers: { ...servers, wavecode: server } }, null, 2));
  return { ok: true, file };
}

const TOML_BLOCK_RE = /^\[mcp_servers\.wavecode(?:\.[^\]]*)?\][^\n]*\n(?:(?!\[)[^\n]*\n?)*/gm;

/** Codex: a stdio server (`<node> <cli> mcp`) with the seat token in its env, in `$CODEX_HOME/config.toml`. */
function registerCodex(input: SeatMcpInput): SeatMcpResult {
  if (!input.profile) {
    return { ok: false, error: 'Codex seats need a credential profile — the default CODEX_HOME is shared by every Codex agent' };
  }
  const env = resolveProfileEnv(input.runtime, input.profile);
  if (!env.ok) return env;
  const home = env.data.CODEX_HOME;
  if (!home) return { ok: false, error: `Runtime '${input.runtime}' has no CODEX_HOME for profile '${input.profile}'` };
  const cli = input.cli ?? { node: process.execPath, entry: path.join(process.cwd(), 'dist', 'cli', 'index.js') };
  const file = path.join(home, 'config.toml');
  let toml = '';
  try {
    toml = fs.readFileSync(file, 'utf8');
  } catch {
    // first registration
  }
  toml = toml.replace(TOML_BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trimEnd();
  const q = (s: string) => JSON.stringify(s); // TOML basic strings share JSON escaping for these values
  const block = [
    '[mcp_servers.wavecode]',
    `command = ${q(cli.node)}`,
    `args = [${q(cli.entry)}, "mcp"]`,
    '',
    '[mcp_servers.wavecode.env]',
    `WAVECODE_URL = ${q(input.daemonUrl)}`,
    `WAVECODE_TOKEN = ${q(input.token)}`,
  ].join('\n');
  writePrivate(file, `${toml ? `${toml}\n\n` : ''}${block}\n`);
  return { ok: true, file };
}

const REGISTRARS: Record<string, (input: SeatMcpInput) => SeatMcpResult> = {
  'claude-code': registerClaude,
  codex: registerCodex,
};

export function registerSeatMcp(input: SeatMcpInput): SeatMcpResult {
  const registrar = REGISTRARS[input.runtime];
  if (!registrar) {
    return { ok: false, error: `Automatic MCP registration is not available for runtime '${input.runtime}' — register the wavecode MCP server in its config manually` };
  }
  try {
    return registrar(input);
  } catch (e) {
    return { ok: false, error: `Failed to register the wavecode MCP server: ${(e as Error).message}` };
  }
}
