/**
 * Shared daemon URL/token resolution for CLI and MCP clients.
 * Flags (when provided by the caller) override this result.
 *
 * Token, in order: `WAVECODE_TOKEN`; the seat bearer registered in the
 * current directory's (or a parent's) `.mcp.json` — so a seat typing
 * `wavecode send …` acts as its person, not as the daemon's owner; then
 * `auth.fallback_token` from config. The URL follows the same order
 * (`WAVECODE_URL`, the seat registration, config).
 */

import { getConfig } from '../server/config.js';
import { readSeatMcp } from '../server/seat-mcp.js';

export interface DaemonConnectionOptions {
  /** Where to look for a seat registration; default `process.cwd()`. */
  cwd?: string;
  /** Environment to read; default `process.env`. */
  env?: Record<string, string | undefined>;
}

export interface DaemonConnection {
  url: string;
  token: string | null;
  /** Where the token came from (never the token itself). */
  tokenSource: 'env' | 'seat' | 'config' | 'none';
}

export function resolveDaemonConnection(opts: DaemonConnectionOptions = {}): DaemonConnection {
  const env = opts.env ?? process.env;
  const envUrl = env.WAVECODE_URL?.trim();
  const envToken = env.WAVECODE_TOKEN ?? null;

  let url = envUrl || 'http://localhost:3777';
  let token = envToken;
  let tokenSource: DaemonConnection['tokenSource'] = envToken ? 'env' : 'none';

  if (token == null) {
    const seat = readSeatMcp(opts.cwd ?? process.cwd());
    if (seat) {
      token = seat.token;
      tokenSource = 'seat';
      if (!envUrl) url = seat.url;
      return { url, token, tokenSource };
    }
  }

  try {
    const cfg = getConfig();
    if (!envUrl) {
      const host = cfg.server.host === '0.0.0.0' || cfg.server.host === '::'
        ? '127.0.0.1'
        : cfg.server.host;
      url = `http://${host}:${cfg.server.port}`;
    }
    if (token == null) {
      token = cfg.auth.fallback_token;
      if (token) tokenSource = 'config';
    }
  } catch {
    // config not loaded — keep env/defaults
  }

  return { url, token, tokenSource };
}
