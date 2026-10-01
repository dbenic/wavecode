/**
 * Pure helpers for the Command Center (spec §4.2–4.3). No React, no I/O —
 * the view and its components stay thin and these stay unit-testable.
 */

import type { Agent, Task, ThreadAction, User } from '../types';

export const FALLBACK_COLOR = '#64748b';

// --- Roster ---

export interface RosterGroups {
  mine: Agent[];
  free: Agent[];
  team: Agent[];
}

/**
 * Mine (I hold the lease) · Free (nobody does, and it runs on my
 * subscription) · Team (someone else holds it, or it is free but on another
 * subscription — spec §5 "free (other subscription)").
 */
export function groupRoster(agents: Agent[], meId: string | null): RosterGroups {
  const groups: RosterGroups = { mine: [], free: [], team: [] };
  const byName = (a: Agent, b: Agent) => a.name.localeCompare(b.name);
  for (const agent of [...agents].sort(byName)) {
    if (!agent.owner_id) (agent.profile_compatible === false ? groups.team : groups.free).push(agent);
    else if (agent.owner_id === meId) groups.mine.push(agent);
    else groups.team.push(agent);
  }
  return groups;
}

/** "3h 12m" / "4m" / "expired"; null when the lease has no expiry. */
export function leaseCountdown(expiresAt: string | null | undefined, now: number): string | null {
  if (!expiresAt) return null;
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return 'expired';
  const totalMin = Math.ceil(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function userColor(users: Map<string, User>, userId: string | null | undefined): string {
  return (userId && users.get(userId)?.color) || FALLBACK_COLOR;
}

/** Title of the task an agent is working on, if any. */
export function currentTaskTitle(agent: Agent, tasks: Task[]): string | null {
  const running = tasks.find((t) => t.agent_id === agent.id && t.status === 'running');
  if (!running) return null;
  return running.prompt.length > 60 ? `${running.prompt.slice(0, 59)}…` : running.prompt;
}

// --- Presence ---

export interface PresenceEntry {
  user: User;
  agentCount: number;
  active: boolean;
}

/** Everyone with an account; active = holds at least one agent. Most agents first. */
export function presence(users: User[], agents: Agent[]): PresenceEntry[] {
  const counts = new Map<string, number>();
  for (const a of agents) {
    if (a.owner_id) counts.set(a.owner_id, (counts.get(a.owner_id) ?? 0) + 1);
  }
  return users
    .map((user) => ({ user, agentCount: counts.get(user.id) ?? 0, active: (counts.get(user.id) ?? 0) > 0 }))
    .sort((a, b) => b.agentCount - a.agentCount || a.user.name.localeCompare(b.user.name));
}

// --- Board ---

export interface Swimlane {
  ownerId: string | null;
  label: string;
  color: string;
  tasks: Task[];
}

const STATUS_ORDER: Record<Task['status'], number> = { running: 0, pending: 1, blocked: 2, failed: 3, done: 4 };

/** Tasks grouped by who created them (unknown creator → "System"). */
export function swimlanes(tasks: Task[], users: Map<string, User>): Swimlane[] {
  const lanes = new Map<string, Swimlane>();
  for (const task of tasks) {
    const key = task.created_by ?? '';
    if (!lanes.has(key)) {
      const user = task.created_by ? users.get(task.created_by) : undefined;
      lanes.set(key, {
        ownerId: task.created_by ?? null,
        label: user?.name ?? (task.created_by ? task.created_by : 'System'),
        color: user?.color ?? FALLBACK_COLOR,
        tasks: [],
      });
    }
    lanes.get(key)!.tasks.push(task);
  }
  for (const lane of lanes.values()) {
    lane.tasks.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.created_at.localeCompare(a.created_at));
  }
  return [...lanes.values()].sort((a, b) => (a.ownerId === null ? 1 : b.ownerId === null ? -1 : a.label.localeCompare(b.label)));
}

// --- Thread order & agent identity ---

/**
 * Feed order with each captured reply moved directly under the prompt it
 * answers (spec §5b) when that prompt is in the list; everything else stays
 * in event order.
 */
export function orderThread<T extends { event_id: number; kind: string; refs: { prompt_event_id?: number } }>(items: T[]): T[] {
  const present = new Set(items.map((i) => i.event_id));
  const anchored = new Map<number, T[]>();
  const rest: T[] = [];
  for (const item of items) {
    const anchor = item.kind === 'reply' ? item.refs.prompt_event_id : undefined;
    if (anchor !== undefined && present.has(anchor) && anchor !== item.event_id) {
      anchored.set(anchor, [...(anchored.get(anchor) ?? []), item]);
    } else {
      rest.push(item);
    }
  }
  const out: T[] = [];
  for (const item of rest) {
    out.push(item);
    const replies = anchored.get(item.event_id);
    if (replies) out.push(...replies);
  }
  return out;
}

const AGENT_PALETTE = ['#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#f472b6', '#fb923c', '#22d3ee', '#a3e635'];

/** A stable color per agent name for its chat bubbles. */
export function agentColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AGENT_PALETTE[h % AGENT_PALETTE.length];
}

/** `@name rest of text` → that agent and the rest; otherwise null. */
export function parseMention<A extends { name: string }>(text: string, agents: A[]): { agent: A; text: string } | null {
  const m = /^@([\w.-]+)\s+([\s\S]*)$/.exec(text.trim());
  if (!m) return null;
  const agent = agents.find((a) => a.name.toLowerCase() === m[1].toLowerCase());
  return agent ? { agent, text: m[2].trim() } : null;
}

// --- Thread merge ---

/**
 * Merge a page into the feed. Items are keyed by id and the incoming copy
 * wins: `actions` / `needs_attention` are computed at read time from current
 * ownership, so a re-read of a known event (after a reserve/release) must
 * replace what is on screen. Ordered by event id, newest last, capped.
 */
export function mergeThreadItems<T extends { id: string; event_id: number }>(prev: T[], incoming: T[], max: number): T[] {
  if (incoming.length === 0) return prev;
  const byId = new Map(prev.map((i) => [i.id, i]));
  for (const item of incoming) byId.set(item.id, item);
  const merged = [...byId.values()].sort((a, b) => a.event_id - b.event_id);
  return merged.length > max ? merged.slice(-max) : merged;
}

/**
 * Events after which the actions on already-shown items may differ (who may
 * act on which agent changed), so the visible window is re-read.
 */
export function invalidatesThreadActions(type: string): boolean {
  return type === 'agent.reserved'
    || type === 'agent.released'
    || type === 'agent.lease_expired'
    || type === 'agent.killed'
    || type === 'agent.detached'
    || type === 'user.revoked';
}

// --- Thread actions ---

/** Placeholders a server action leaves for the UI (`{text}`, `{agent_id}`, …). */
export function actionPlaceholders(action: ThreadAction): string[] {
  const found = new Set<string>();
  const scan = (v: unknown) => {
    if (typeof v === 'string') for (const m of v.matchAll(/\{(\w+)\}/g)) found.add(m[1]);
    else if (v && typeof v === 'object') Object.values(v).forEach(scan);
  };
  scan(action.path);
  scan(action.body);
  return [...found];
}

/** Substitute placeholders in path and body. Missing values stay as-is. */
export function fillAction(action: ThreadAction, values: Record<string, string>): ThreadAction {
  const fill = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  return { ...action, path: fill(action.path) as string, ...(action.body ? { body: fill(action.body) as Record<string, unknown> } : {}) };
}

/** Server paths start with /api; the api helpers add it themselves. */
export function apiRelativePath(path: string): string {
  return path.startsWith('/api/') ? path.slice(4) : path;
}

// --- Composer ---

export type ComposerMode = 'prompt' | 'task' | 'reply' | 'file';

export type SlashCommand =
  | { cmd: 'reserve'; hours: number }
  | { cmd: 'release' | 'kill' | 'review' | 'promote' | 'retry' };

export type SlashParse =
  | { ok: true; command: SlashCommand }
  | { ok: false; error: string }
  | null; // not a slash command

const SIMPLE_COMMANDS = ['release', 'kill', 'review', 'promote', 'retry'] as const;

/** `/reserve 4h`, `/release`, `/kill`, `/review`, `/promote`, `/retry`. */
export function parseSlashCommand(input: string): SlashParse {
  const text = input.trim();
  if (!text.startsWith('/')) return null;
  const [rawCmd, ...rest] = text.slice(1).split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  if (cmd === 'reserve') {
    if (rest.length === 0) return { ok: true, command: { cmd: 'reserve', hours: 4 } };
    const m = /^(\d+(?:\.\d+)?)h?$/i.exec(rest[0]);
    const hours = m ? Number(m[1]) : NaN;
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
      return { ok: false, error: 'Usage: /reserve <hours>h (max 24h)' };
    }
    return { ok: true, command: { cmd: 'reserve', hours } };
  }
  if ((SIMPLE_COMMANDS as readonly string[]).includes(cmd)) {
    return { ok: true, command: { cmd: cmd as (typeof SIMPLE_COMMANDS)[number] } };
  }
  return { ok: false, error: `Unknown command /${cmd}. Try /reserve 4h, /release, /kill, /review, /promote, /retry` };
}
