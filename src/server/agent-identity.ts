/**
 * Agent identity (spec §5c): aliases, personas and tag groups, plus the
 * `@x` address resolution shared by routes, the CLI and MCP.
 *
 * `@x` resolves agent (alias → name → id) → tag group → person. To keep that
 * unambiguous, an alias may not equal another agent's name/alias, a tag or
 * a user name; a tag may not equal an agent name/alias or a user name.
 */

import {
  getUserByName,
  listAgents,
  listAgentsByTag,
  listAllAgentTags,
  resolveAgent,
  type Agent,
  type Result,
  type User,
} from './db.js';
import { OWNER_USER } from './users.js';

export const HANDLE_RE = /^[a-z][a-z0-9_-]{1,23}$/;
export const MAX_PERSONA_CHARS = 80;
const RESERVED = new Set(['all', 'everyone', 'here', 'seat', 'me', 'owner', 'system']);

function takenByAgent(handle: string, exceptAgentId?: string): Agent | undefined {
  return listAgents().find((a) => a.id !== exceptAgentId && (a.alias === handle || a.name === handle));
}

function allTags(): Set<string> {
  const tags = new Set<string>();
  for (const list of listAllAgentTags().values()) list.forEach((t) => tags.add(t));
  return tags;
}

function isUserName(handle: string): boolean {
  return handle === OWNER_USER.name || getUserByName(handle).ok;
}

/** `null`/'' clears the alias. */
export function validateAlias(value: unknown, agentId: string): Result<string | null> {
  if (value === null || value === '') return { ok: true, data: null };
  if (typeof value !== 'string' || !HANDLE_RE.test(value)) {
    return { ok: false, error: 'alias must be 2–24 chars: a lowercase letter, then [a-z0-9_-]' };
  }
  if (RESERVED.has(value)) return { ok: false, error: `alias '${value}' is reserved` };
  const clash = takenByAgent(value, agentId);
  if (clash) return { ok: false, error: `'${value}' is already used by agent ${clash.name}` };
  if (allTags().has(value)) return { ok: false, error: `'${value}' is a group tag` };
  if (isUserName(value)) return { ok: false, error: `'${value}' is a person's name` };
  return { ok: true, data: value };
}

export function validateTag(value: unknown): Result<string> {
  if (typeof value !== 'string' || !HANDLE_RE.test(value)) {
    return { ok: false, error: 'tag must be 2–24 chars: a lowercase letter, then [a-z0-9_-]' };
  }
  if (RESERVED.has(value)) return { ok: false, error: `tag '${value}' is reserved` };
  const clash = takenByAgent(value);
  if (clash) return { ok: false, error: `'${value}' is agent ${clash.name}'s name or alias` };
  if (isUserName(value)) return { ok: false, error: `'${value}' is a person's name` };
  return { ok: true, data: value };
}

/** One line, ≤80 chars, printable. `null`/'' clears it. */
export function validatePersona(value: unknown): Result<string | null> {
  if (value === null || value === '') return { ok: true, data: null };
  if (typeof value !== 'string') return { ok: false, error: 'persona must be a string' };
  const persona = value.trim();
  if (persona.length > MAX_PERSONA_CHARS) return { ok: false, error: `persona must be at most ${MAX_PERSONA_CHARS} characters` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(persona)) return { ok: false, error: 'persona must be a single line' };
  return { ok: true, data: persona || null };
}

export function agentHandle(agent: Pick<Agent, 'alias' | 'name'>): string {
  return agent.alias ?? agent.name;
}

/**
 * `[you are @toni — frontend lead] ` before every prompt to an agent with a
 * persona, so its narrative can name itself and its peers (spec §5c).
 */
export function withPersona(agent: Pick<Agent, 'alias' | 'name' | 'persona'>, prompt: string): string {
  if (!agent.persona) return prompt;
  return `[you are @${agentHandle(agent)} — ${agent.persona}] ${prompt}`;
}

export type Address =
  | { kind: 'agent'; agent: Agent }
  | { kind: 'group'; tag: string; agents: Agent[] }
  | { kind: 'user'; user: User };

/** `@x` → an agent, a tag group, or a person (in that order); null if nothing matches. */
export function resolveAddress(ref: string): Address | null {
  const key = ref.trim().replace(/^@/, '');
  if (!key) return null;
  const agent = resolveAgent(key);
  if (agent.ok) return { kind: 'agent', agent: agent.data };
  const group = listAgentsByTag(key);
  if (group.length > 0) return { kind: 'group', tag: key, agents: group };
  if (key === OWNER_USER.name) return { kind: 'user', user: OWNER_USER };
  const user = getUserByName(key);
  if (user.ok) return { kind: 'user', user: user.data };
  return null;
}
