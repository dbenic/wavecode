import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Http2ServerRequest, Http2ServerResponse } from 'node:http2';
import type { MiddlewareHandler } from 'hono';
import { getConfig, type WaveConfig } from './config.js';
import type { User } from './db.js';
import { runWithActor } from './request-context.js';
import { canMutate, OWNER_USER, resolveUserByToken, isRestrictedUser, restrictedAgentRefs } from './users.js';

export interface NodeAppBindings {
  incoming?: IncomingMessage | Http2ServerRequest | {
    socket?: { remoteAddress?: string };
  };
  outgoing?: ServerResponse | Http2ServerResponse | unknown;
}

export interface NodeAppVariables {
  /** Authenticated caller; set by `createAuthMiddleware` on every non-public request. */
  user: User;
}

export interface NodeAppEnv {
  Bindings: NodeAppBindings;
  Variables: NodeAppVariables;
}

/**
 * The authenticated caller. Apps mounted without the auth middleware (unit
 * tests, embedded use) act as the synthetic admin `owner` — today's
 * single-user behavior.
 */
export function getActingUser(c: { get: (key: 'user') => User | undefined }): User {
  return c.get('user') ?? OWNER_USER;
}

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * What a seat token may never do (spec §5d): it acts as its user for work —
 * agents, tasks, reviews, rooms, the wire — but not for identity or the
 * control plane. Returns a short reason, or null when allowed.
 */
export function seatTokenDenied(method: string, pathname: string): string | null {
  if (pathname === '/api/users' || pathname.startsWith('/api/users/')) {
    return method === 'GET' && pathname === '/api/users' ? null : 'manage users or seats';
  }
  if (pathname.startsWith('/api/settings')) return 'change settings';
  if (pathname.startsWith('/api/system/')) return 'use system controls';
  if (/^\/api\/profiles\/[^/]+\/login$/.test(pathname)) return 'open login seats';
  return null;
}

export interface PublicAuthStatus {
  method: WaveConfig['auth']['method'];
  tokenConfigured: boolean;
}

export function getPublicAuthStatus(config: WaveConfig): PublicAuthStatus {
  return {
    method: config.auth.method,
    tokenConfigured: !!config.auth.fallback_token,
  };
}

export function normalizeIp(rawIp: string | null | undefined): string | null {
  if (!rawIp) return null;

  let ip = rawIp.trim();
  if (!ip) return null;

  if (ip.startsWith('[') && ip.includes(']')) {
    ip = ip.slice(1, ip.indexOf(']'));
  }

  if (ip.startsWith('::ffff:')) {
    ip = ip.slice('::ffff:'.length);
  }

  ip = ip.replace(/%.+$/, '');

  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) {
    ip = ip.replace(/:\d+$/, '');
  }

  return ip;
}

function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip === 'local';
}

export function isPrivateOrTailnetIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const normalized = normalizeIp(ip);
  if (!normalized) return false;

  return isLoopback(normalized)
    || normalized.startsWith('100.')
    || normalized.startsWith('10.')
    || normalized.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[01])\./.test(normalized)
    || normalized.startsWith('fd7a:')
    || normalized.startsWith('fc')
    || normalized.startsWith('fd');
}

export function isTrustedProxyIp(ip: string | null | undefined, trustedProxies: string[]): boolean {
  const normalized = normalizeIp(ip);
  if (!normalized) return false;

  return trustedProxies.some((candidate) => {
    const entry = candidate.trim();
    if (!entry) return false;
    if (entry === 'loopback') return isLoopback(normalized);
    return normalizeIp(entry) === normalized;
  });
}

export function parseForwardedFor(headerValue: string | null | undefined): string[] {
  if (!headerValue) return [];

  return headerValue
    .split(',')
    .map((part) => normalizeIp(part))
    .filter((part): part is string => !!part);
}

export function resolveSocketIp(bindings: NodeAppBindings): string {
  return normalizeIp(bindings.incoming?.socket?.remoteAddress) ?? 'local';
}

export function resolveClientIp(
  bindings: NodeAppBindings,
  headers: Headers,
  trustedProxies: string[],
): string {
  const socketIp = resolveSocketIp(bindings);

  if (!isTrustedProxyIp(socketIp, trustedProxies)) {
    return socketIp;
  }

  const forwardedChain = parseForwardedFor(headers.get('X-Forwarded-For'));
  if (forwardedChain.length > 0) {
    return forwardedChain[0];
  }

  return normalizeIp(headers.get('X-Real-IP')) ?? socketIp;
}

export function resolveRequestToken(pathname: string, headers: Headers, queryToken?: string | null): string | null {
  const authHeader = headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  if (pathname === '/api/events') {
    return queryToken?.trim() || null;
  }

  return null;
}

function hasForwardingHeaders(headers: Headers): boolean {
  return parseForwardedFor(headers.get('X-Forwarded-For')).length > 0
    || normalizeIp(headers.get('X-Real-IP')) !== null;
}

export type UserResolver = (token: string | null, fallbackToken: string | null) => User | null;

/**
 * Authenticate the request and resolve it to a user (spec §1):
 * - `auth.fallback_token` → synthetic admin `owner`
 * - a token from `users` → that user
 * - a token that resolves to nobody → 401 in every mode. It must never fall
 *   through to the tailnet rule: a revoked or mistyped token would
 *   otherwise be upgraded to admin `owner`.
 * - no token → 401 in `token` mode; in `tailscale` mode a tailnet client
 *   without any token is the trusted `owner` (today's behavior)
 *
 * Observers are read-only on `/api/*`: any non-GET/HEAD/OPTIONS → 403.
 * MCP (`/mcp`) is JSON-RPC over POST, so its per-tool guards live in T3.
 */
export function createAuthMiddleware(
  getConfigFn: () => WaveConfig = getConfig,
  resolveUser: UserResolver = resolveUserByToken,
): MiddlewareHandler<NodeAppEnv> {
  return async (c, next) => {
    if (c.req.path === '/api/auth/status') {
      await next();
      return;
    }

    const config = getConfigFn();
    const expectedToken = config.auth.fallback_token;
    const token = resolveRequestToken(c.req.path, c.req.raw.headers, c.req.query('access_token'));

    let user: User | null = null;
    try {
      user = resolveUser(token, expectedToken);
    } catch {
      // users table unavailable (DB not initialized) — fall back to token-less rules
      user = token && expectedToken && token === expectedToken ? OWNER_USER : null;
    }

    if (!user && token) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    if (!user) {
      if (config.auth.method === 'token') {
        if (!expectedToken) {
          return c.json({ error: 'Token auth is enabled but no fallback token is configured' }, 500);
        }
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const socketIp = resolveSocketIp(c.env);
      const proxyTrusted = isTrustedProxyIp(socketIp, config.auth.trusted_proxies);
      if (!proxyTrusted && hasForwardingHeaders(c.req.raw.headers)) {
        return c.json({ error: 'Unauthorized: untrusted proxy' }, 401);
      }

      const clientIp = proxyTrusted
        ? resolveClientIp(c.env, c.req.raw.headers, config.auth.trusted_proxies)
        : socketIp;
      if (!isPrivateOrTailnetIp(clientIp)) {
        return c.json({ error: 'Unauthorized: not on tailnet' }, 401);
      }

      user = OWNER_USER;
    }

    if (!canMutate(user) && c.req.path.startsWith('/api/') && !READ_ONLY_METHODS.has(c.req.method)) {
      return c.json({ error: `Forbidden: '${user.name}' is an observer (read-only)` }, 403);
    }

    // Spec §5d: a seat token is narrower than its person's login — it never
    // carries admin powers and cannot manage people, seats, settings or the system.
    if (user.via_seat) {
      const denied = seatTokenDenied(c.req.method, c.req.path);
      if (denied) return c.json({ error: `Forbidden: a seat token cannot ${denied} — use your own login` }, 403);
      if (user.role === 'admin') user = { ...user, role: 'developer' };
    }

    // docs/peers.md: a token limited to named agents (a peer's ask-only token)
    // gets exactly the surface needed to ask them and read their answers.
    if (isRestrictedUser(user) && c.req.path.startsWith('/api/') && !restrictedPathAllowed(c.req.method, c.req.path)) {
      return c.json({ error: `Forbidden: this token is limited to asking ${restrictedAgentRefs(user)!.join(', ')}` }, 403);
    }

    c.set('user', user);
    await runWithActor(user.id, () => next());
  };
}

const RESTRICTED_ALLOW: Array<[string, RegExp]> = [
  ['GET', /^\/api\/me$/],
  ['GET', /^\/api\/agents$/],
  ['GET', /^\/api\/agents\/[^/]+$/],
  ['GET', /^\/api\/agents\/[^/]+\/output$/],
  ['POST', /^\/api\/agents\/[^/]+\/send$/],
  ['GET', /^\/api\/events\/log$/],
  ['GET', /^\/api\/messages$/],
];

/** Exported for tests. */
export function restrictedPathAllowed(method: string, path: string): boolean {
  return RESTRICTED_ALLOW.some(([m, re]) => m === method && re.test(path));
}
