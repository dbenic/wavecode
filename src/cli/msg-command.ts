/**
 * `wavecode msg <to> <message>` target resolution (spec §5c).
 * `all` broadcasts; otherwise `@x` / `x` resolves agent (alias → name → id)
 * → tag group (one message per agent) → person (`to_user_id`, lands in their
 * Attention filter and the notification mirror).
 */

import { resolveAddress } from '../server/agent-identity.js';
import type { Result } from '../server/db.js';

export type MsgTarget =
  | { kind: 'all' }
  | { kind: 'agents'; agentIds: string[]; label: string }
  | { kind: 'user'; userId: string; name: string };

export function resolveMsgTarget(to: string): Result<MsgTarget> {
  if (to === 'all' || to === '@all') return { ok: true, data: { kind: 'all' } };
  const address = resolveAddress(to);
  if (!address) {
    return { ok: false, error: `Unknown recipient '${to}' (an agent alias/name/id, a #tag group, a person, or 'all')` };
  }
  switch (address.kind) {
    case 'agent':
      return { ok: true, data: { kind: 'agents', agentIds: [address.agent.id], label: address.agent.alias ?? address.agent.name } };
    case 'group':
      return { ok: true, data: { kind: 'agents', agentIds: address.agents.map((a) => a.id), label: `@${address.tag}` } };
    default:
      return { ok: true, data: { kind: 'user', userId: address.user.id, name: address.user.name } };
  }
}
