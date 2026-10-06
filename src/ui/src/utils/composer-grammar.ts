/**
 * The composer's deterministic grammar (spec §5c). Parsed client-side,
 * executed through the existing routes by the Command Center.
 *
 *   @x text            prompt x            @x @y text   fan-out
 *   @group text        prompt every agent tagged `group`
 *   @all text          broadcast on the wire
 *   @person text       message a person (their Attention inbox + phone)
 *   #reserve @x [Nh]   #release @x   #kill @x   #tag @x name   #review #n @x   #ask peer/agent …
 *   #task [@x] text [deps:#n,#m]     #promote #n
 *   #file @x name      share an uploaded file by name or id
 *   #status            ask the orchestrator seat for a status
 *
 * No `@`/`#`, or anything that does not parse → prompt to the chip target
 * (the orchestrator seat by default), text unchanged.
 */

import type { Agent, Task, User } from '../types';

export interface GrammarContext {
  agents: Agent[];
  users: User[];
  tasks: Task[];
  /** The orchestrator seat — receives #status and anything unparseable. */
  seat: Agent | null;
  /** The composer chip target — receives plain text. */
  chip: Agent | null;
}

export type Plan =
  | { kind: 'prompt'; agents: Agent[]; text: string }
  | { kind: 'broadcast'; text: string }
  | { kind: 'message'; users: User[]; text: string }
  | { kind: 'reserve'; agent: Agent; hours: number }
  | { kind: 'release' | 'kill'; agent: Agent }
  | { kind: 'tag'; agent: Agent; tag: string }
  | { kind: 'task'; agent: Agent | null; text: string; deps: Task[] }
  | { kind: 'promote'; task: Task }
  | { kind: 'review'; task: Task; agent: Agent }
  | { kind: 'ask_peer'; peer: string; agent: string; text: string }
  | { kind: 'file'; agent: Agent; name: string }
  | { kind: 'status'; seat: Agent }
  | { kind: 'none'; reason: string };

export const STATUS_PROMPT =
  'Status please: what is each agent on right now, what finished, what is blocked or waiting for review or a decision?';

export const COMMANDS: Array<{ cmd: string; usage: string }> = [
  { cmd: 'reserve', usage: '#reserve @agent [Nh]' },
  { cmd: 'release', usage: '#release @agent' },
  { cmd: 'kill', usage: '#kill @agent' },
  { cmd: 'task', usage: '#task [@agent] text [deps:#n,#m]' },
  { cmd: 'promote', usage: '#promote #n' },
  { cmd: 'review', usage: '#review #n @agent' },
  { cmd: 'ask', usage: '#ask peer/agent question' },
  { cmd: 'file', usage: '#file @agent name' },
  { cmd: 'status', usage: '#status' },
  { cmd: 'tag', usage: '#tag @agent group' },
];

export function handleOf(agent: Pick<Agent, 'alias' | 'name'>): string {
  return agent.alias ?? agent.name;
}

/** alias → name → id */
export function findAgent(ref: string, agents: Agent[]): Agent | null {
  const key = ref.replace(/^@/, '');
  const lower = key.toLowerCase();
  return agents.find((a) => a.alias === lower)
    ?? agents.find((a) => a.name.toLowerCase() === lower)
    ?? agents.find((a) => a.id === key)
    ?? null;
}

type Address = { kind: 'agents'; agents: Agent[] } | { kind: 'all' } | { kind: 'user'; user: User };

/** `@x` → agent (alias → name → id) → tag group → person, like the server. */
export function resolveMention(token: string, ctx: Pick<GrammarContext, 'agents' | 'users'>): Address | null {
  const key = token.replace(/^@/, '').toLowerCase();
  if (!key) return null;
  if (key === 'all') return { kind: 'all' };
  const agent = findAgent(key, ctx.agents);
  if (agent) return { kind: 'agents', agents: [agent] };
  const group = ctx.agents.filter((a) => a.tags?.includes(key));
  if (group.length > 0) return { kind: 'agents', agents: group };
  const user = ctx.users.find((u) => u.name === key);
  return user ? { kind: 'user', user } : null;
}

function taskByRef(ref: string, tasks: Task[]): Task | null {
  const m = /^#?(\d+)$/.exec(ref);
  return m ? tasks.find((t) => t.num === Number(m[1])) ?? null : null;
}

function fallback(text: string, ctx: GrammarContext, reason: string, toSeat = false): Plan {
  const target = toSeat ? ctx.seat ?? ctx.chip : ctx.chip ?? ctx.seat;
  return target ? { kind: 'prompt', agents: [target], text } : { kind: 'none', reason };
}

function parseCommand(cmd: string, args: string[], text: string, ctx: GrammarContext): Plan | null {
  const agentArg = () => (args[0]?.startsWith('@') ? findAgent(args[0], ctx.agents) : null);
  switch (cmd) {
    case 'status':
      return ctx.seat ? { kind: 'status', seat: ctx.seat } : null;
    case 'reserve': {
      const agent = agentArg();
      if (!agent || args.length > 2) return null;
      let hours = 4;
      if (args[1]) {
        const m = /^(\d+(?:\.\d+)?)h?$/i.exec(args[1]);
        if (!m || Number(m[1]) <= 0 || Number(m[1]) > 24) return null;
        hours = Number(m[1]);
      }
      return { kind: 'reserve', agent, hours };
    }
    case 'release':
    case 'kill': {
      const agent = agentArg();
      return agent && args.length === 1 ? { kind: cmd, agent } : null;
    }
    case 'tag': {
      const agent = agentArg();
      return agent && args.length === 2 && /^[a-z][a-z0-9_-]{1,23}$/.test(args[1]) ? { kind: 'tag', agent, tag: args[1] } : null;
    }
    case 'promote': {
      const task = args.length === 1 ? taskByRef(args[0], ctx.tasks) : null;
      return task ? { kind: 'promote', task } : null;
    }
    case 'ask': {
      // `#ask deploy/fable is the invoice table migrated on staging?` → a question to an agent on another WaveCode
      const target = /^@?([a-z][a-z0-9_-]*)\/(@?[\w.-]+)$/i.exec(args[0] ?? '');
      const question = text.replace(/^#ask\s+\S+\s*/i, '').trim();
      return target && question ? { kind: 'ask_peer', peer: target[1].toLowerCase(), agent: target[2].replace(/^@/, ''), text: question } : null;
    }
    case 'review': {
      // `#review #12 @opus` or `#review @opus #12`: name the reviewer for a task (ladder rung 1)
      if (args.length !== 2) return null;
      const [a, b] = args;
      const agentRef = a.startsWith('@') ? a : b.startsWith('@') ? b : null;
      const taskRef = agentRef === a ? b : a;
      const agent = agentRef ? findAgent(agentRef, ctx.agents) : null;
      const task = taskByRef(taskRef, ctx.tasks);
      return agent && task ? { kind: 'review', task, agent } : null;
    }
    case 'file': {
      const agent = agentArg();
      return agent && args.length >= 2 ? { kind: 'file', agent, name: args.slice(1).join(' ') } : null;
    }
    case 'task': {
      let rest = text.replace(/^#task\s*/i, '');
      let agent: Agent | null = null;
      const mention = /^@(\S+)\s+/.exec(rest);
      if (mention) {
        agent = findAgent(mention[1], ctx.agents);
        if (!agent) return null;
        rest = rest.slice(mention[0].length);
      }
      const deps: Task[] = [];
      const depsMatch = /\s*\[?deps:\s*([#\d,\s]+)\]?\s*$/i.exec(rest);
      if (depsMatch) {
        for (const ref of depsMatch[1].split(/[,\s]+/).filter(Boolean)) {
          const t = taskByRef(ref, ctx.tasks);
          if (!t) return null;
          deps.push(t);
        }
        rest = rest.slice(0, depsMatch.index);
      }
      rest = rest.trim();
      return rest ? { kind: 'task', agent, text: rest, deps } : null;
    }
    default:
      return null;
  }
}

export function parseComposer(input: string, ctx: GrammarContext): Plan {
  const text = input.trim();
  if (!text) return { kind: 'none', reason: 'Type a message' };

  if (text.startsWith('#') && !/^#\d/.test(text)) {
    const [head, ...args] = text.split(/\s+/);
    const plan = parseCommand(head.slice(1).toLowerCase(), args, text, ctx);
    // Unknown or malformed #command → the orchestrator seat, unchanged
    return plan ?? fallback(text, ctx, 'No orchestrator seat to send this to', true);
  }

  if (text.startsWith('@')) {
    const recipients: Agent[] = [];
    const users: User[] = [];
    let broadcast = false;
    let rest = text;
    for (;;) {
      const m = /^@(\S+)\s*/.exec(rest);
      if (!m) break;
      const address = resolveMention(m[1], ctx);
      if (!address) return fallback(text, ctx, `Unknown @${m[1]}`, true);
      if (address.kind === 'all') broadcast = true;
      else if (address.kind === 'user') users.push(address.user);
      else for (const a of address.agents) if (!recipients.includes(a)) recipients.push(a);
      rest = rest.slice(m[0].length);
    }
    const body = rest.trim();
    if (!body) return { kind: 'none', reason: 'Add a message after the @mention' };
    if (broadcast) return { kind: 'broadcast', text: body };
    if (users.length > 0 && recipients.length === 0) return { kind: 'message', users, text: body };
    if (users.length > 0) return { kind: 'none', reason: 'Address agents or people in one message, not both' };
    return { kind: 'prompt', agents: recipients, text: body };
  }

  return fallback(text, ctx, 'Pick an agent');
}

// --- autocomplete ------------------------------------------------------------

export interface Suggestion {
  insert: string;
  label: string;
  detail: string;
  color?: string;
}

/** The `@…` / `#…` token ending at the cursor, if any. */
export function tokenAt(text: string, cursor: number): { start: number; token: string } | null {
  const before = text.slice(0, cursor);
  const m = /(^|\s)([@#][^\s]*)$/.exec(before);
  return m ? { start: cursor - m[2].length, token: m[2] } : null;
}

export function suggestionsFor(
  token: string,
  ctx: Pick<GrammarContext, 'agents' | 'users' | 'tasks'> & { colorFor: (a: Agent) => string; currentTask: (a: Agent) => string | null },
): Suggestion[] {
  const q = token.slice(1).toLowerCase();
  if (token.startsWith('@')) {
    const out: Suggestion[] = [];
    for (const a of ctx.agents) {
      const handle = handleOf(a);
      if (!handle.toLowerCase().startsWith(q) && !a.name.toLowerCase().includes(q)) continue;
      out.push({
        insert: `@${handle}`,
        label: `@${handle}`,
        detail: [a.status, a.persona, ctx.currentTask(a)].filter(Boolean).join(' · '),
        color: ctx.colorFor(a),
      });
    }
    const tags = [...new Set(ctx.agents.flatMap((a) => a.tags ?? []))].sort();
    for (const tag of tags) {
      if (tag.startsWith(q)) out.push({ insert: `@${tag}`, label: `@${tag}`, detail: `group · ${ctx.agents.filter((a) => a.tags?.includes(tag)).length} agents` });
    }
    for (const u of ctx.users) {
      if (u.name.startsWith(q)) out.push({ insert: `@${u.name}`, label: `@${u.name}`, detail: 'person', color: u.color });
    }
    if ('all'.startsWith(q)) out.push({ insert: '@all', label: '@all', detail: 'broadcast on the wire' });
    return out.slice(0, 8);
  }
  if (/^#\d*$/.test(token) && token.length > 1) {
    return ctx.tasks
      .filter((t) => t.num != null && ['pending', 'running', 'blocked'].includes(t.status) && String(t.num).startsWith(q))
      .slice(0, 8)
      .map((t) => ({ insert: `#${t.num}`, label: `#${t.num}`, detail: `${t.status} · ${t.prompt.slice(0, 60)}` }));
  }
  if (token.startsWith('#')) {
    return COMMANDS.filter((c) => c.cmd.startsWith(q)).map((c) => ({ insert: `#${c.cmd}`, label: `#${c.cmd}`, detail: c.usage }));
  }
  return [];
}
