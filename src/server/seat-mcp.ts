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
