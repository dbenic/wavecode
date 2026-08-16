/**
 * Shared daemon URL/token resolution for CLI and MCP clients.
 * Flags (when provided by the caller) override this result.
 * Env overrides config: WAVECODE_TOKEN, then auth.fallback_token.
 */

import { getConfig } from '../server/config.js';

export function resolveDaemonConnection(): { url: string; token: string | null } {
  const envUrl = process.env.WAVECODE_URL?.trim();
  const envToken = process.env.WAVECODE_TOKEN ?? null;

  let url = envUrl || 'http://localhost:3777';
  let token = envToken;

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
    }
  } catch {
    // config not loaded — keep env/defaults
  }

  return { url, token };
}
