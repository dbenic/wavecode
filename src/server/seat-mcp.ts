/**
 * Register the `wavecode` MCP server for an orchestrator seat with the seat
 * token (spec §5d), so the seat drives WaveCode as its user. Only ever
 * written where *this seat alone* reads it — its own workspace — never a
 * profile or home config, where every agent on that login would inherit
 * the user's identity. Files are 0600; the token is never logged.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';

export interface SeatMcpInput {
  runtime: string;
  profile: string | null;
  workspace: string;
  token: string;
  /** Daemon base URL, e.g. http://127.0.0.1:3777 */
  daemonUrl: string;
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
 * Claude Code: an HTTP MCP server with the seat token as bearer, in the seat
 * workspace's project config (`.mcp.json`, pre-approved in
 * `.claude/settings.local.json`). Never in the profile's `.claude.json`:
 * every worker agent on that profile loads it and would inherit the seat
 * token. The seat runs in its own workspace, so only it picks this up.
 */
function registerClaude(input: SeatMcpInput): SeatMcpResult {
  const server = {
    type: 'http',
    url: `${input.daemonUrl}/mcp`,
    headers: { Authorization: `Bearer ${input.token}` },
  };
  const file = path.join(input.workspace, '.mcp.json');
  const settingsFile = path.join(input.workspace, '.claude', 'settings.local.json');
  const settings = readJson(settingsFile);
  const enabled = new Set([...(Array.isArray(settings.enabledMcpjsonServers) ? settings.enabledMcpjsonServers as string[] : []), 'wavecode']);
  writePrivate(settingsFile, JSON.stringify({ ...settings, enabledMcpjsonServers: [...enabled] }, null, 2));
  const config = readJson(file);
  const servers = (config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {}) as Record<string, unknown>;
  writePrivate(file, JSON.stringify({ ...config, mcpServers: { ...servers, wavecode: server } }, null, 2));
  return { ok: true, file };
}

export interface SeatMcpRegistration {
  /** Daemon base URL the seat is registered against (the `/mcp` suffix removed). */
  url: string;
  /** The seat bearer written by `registerSeatMcp`. */
  token: string;
  /** The `.mcp.json` the registration was read from. */
  file: string;
}

/**
 * The registration `registerSeatMcp` wrote, read back from a seat workspace:
 * `startDir` and its parents are searched for a `.mcp.json` whose
 * `mcpServers.wavecode` is an HTTP server with a bearer. The CLI uses this so
 * `wavecode send` / `queue` / `msg` typed by a seat act as the seat's person
 * (31 Oct 2026: a seat's CLI calls carried the daemon's own token and every
 * task it created was `owner`'s — unattributed, and refused by every
 * personal profile). Nothing outside a seat workspace carries this file, so
 * everyone else keeps the env / config token. Never logs the token.
 */
export function readSeatMcp(startDir: string): SeatMcpRegistration | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const file = path.join(dir, '.mcp.json');
    const found = readSeatMcpFile(file);
    if (found) return found;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readSeatMcpFile(file: string): SeatMcpRegistration | null {
  if (!fs.existsSync(file)) return null;
  const config = readJson(file);
  const servers = config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers as Record<string, unknown> : null;
  const server = servers?.wavecode;
  if (!server || typeof server !== 'object') return null;
  const { type, url, headers } = server as { type?: unknown; url?: unknown; headers?: unknown };
  if (type !== 'http' || typeof url !== 'string') return null;
  const auth = headers && typeof headers === 'object' ? (headers as Record<string, unknown>).Authorization : null;
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length).trim();
  if (!token) return null;
  return { url: url.replace(/\/mcp\/?$/, ''), token, file };
}

/**
 * Only runtimes with a seat-local config are registered automatically. Codex
 * reads MCP servers from `$CODEX_HOME/config.toml`, which the whole profile
 * shares — writing the seat token there would hand it to every Codex worker.
 */
const REGISTRARS: Record<string, (input: SeatMcpInput) => SeatMcpResult> = {
  'claude-code': registerClaude,
};

export function registerSeatMcp(input: SeatMcpInput): SeatMcpResult {
  const registrar = REGISTRARS[input.runtime];
  if (!registrar) {
    return {
      ok: false,
      error: `Automatic MCP registration is only available for claude-code seats: '${input.runtime}' keeps MCP servers in a config shared by every agent on the profile, so the seat token is not written there — register the wavecode MCP server for this seat by hand`,
    };
  }
  try {
    return registrar(input);
  } catch (e) {
    return { ok: false, error: `Failed to register the wavecode MCP server: ${(e as Error).message}` };
  }
}
