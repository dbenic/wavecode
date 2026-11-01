/**
 * Provider API keys a subscription CLI must never see (1 Nov 2026, after
 * unexpected Anthropic invoices): with one of these in its environment
 * Claude Code, Codex or Grok bills a pay-as-you-go account instead of the
 * login's subscription — silently when the CLI runs headless, or whenever a
 * profile has no login at all. Rule: no seat uses any key.
 *
 * The daemon itself may hold such a key (config `llm.*`, or its unit's env
 * file), and the tmux server it starts inherits that environment, so every
 * pane would too. Three places cut the chain: the launch command of every
 * pane is wrapped in `env -u …` (runtime-launcher.ts), the tmux global
 * environment is scrubbed at start (bootstrap.ts), and the credential probe
 * (seat-credentials.ts) reports any pane that still carries one.
 */
export const PROVIDER_KEY_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'XAI_API_KEY',
] as const;

export type ProviderKeyVar = (typeof PROVIDER_KEY_VARS)[number];

/** Names (never values) of the provider keys present in `env`. */
export function providerKeysInEnv(env: Record<string, string | undefined> = process.env): ProviderKeyVar[] {
  return PROVIDER_KEY_VARS.filter((v) => typeof env[v] === 'string' && env[v]!.length > 0);
}

/** A copy of `env` without any provider key. */
export function scrubEnv<T extends Record<string, string | undefined>>(env: T): T {
  const out = { ...env };
  for (const v of PROVIDER_KEY_VARS) delete out[v];
  return out;
}

/**
 * `env -u A -u B` for the keys the daemon's own environment carries, '' when
 * it carries none (a clean daemon starts a clean tmux server, so its panes
 * need no wrapper and launch commands stay as they were).
 */
export function scrubPrefix(env: Record<string, string | undefined> = process.env): string {
  const present = providerKeysInEnv(env);
  return present.length ? `env ${present.map((v) => `-u ${v}`).join(' ')}` : '';
}
