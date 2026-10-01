import { describe, expect, it } from 'vitest';
import type { Agent, Task, ThreadAction, User } from '../types';
import {
  actionPlaceholders,
  apiRelativePath,
  currentTaskTitle,
  fillAction,
  groupRoster,
  invalidatesThreadActions,
  leaseCountdown,
  mergeThreadItems,
  parseSlashCommand,
  presence,
  swimlanes,
  userColor,
} from './command-center';

function agent(over: Partial<Agent>): Agent {
  return {
    id: over.name ?? 'a', name: 'a', runtime: 'codex', tmux_session: 'wc-a', workspace: null,
    mode: 'spawned', status: 'idle', model: null, effort: null, created_at: '', ...over,
  };
}

function task(over: Partial<Task>): Task {
  return { id: 't', agent_id: null, prompt: 'p', status: 'pending', priority: 0, created_at: '2026-10-01 10:00:00', ...over };
}

const ana: User = { id: 'u-ana', name: 'ana', role: 'developer', color: '#2563eb' };
const bob: User = { id: 'u-bob', name: 'bob', role: 'developer', color: '#16a34a' };

describe('command-center utils', () => {
  it('groupRoster: Mine / Free / Team, other-subscription free agents go to Team', () => {
    const g = groupRoster([
      agent({ name: 'z-mine', owner_id: 'u-ana' }),
      agent({ name: 'free', owner_id: null }),
      agent({ name: 'theirs', owner_id: 'u-bob' }),
      agent({ name: 'other-sub', owner_id: null, profile: 'bob', profile_compatible: false }),
      agent({ name: 'a-mine', owner_id: 'u-ana' }),
    ], 'u-ana');
    expect(g.mine.map((a) => a.name)).toEqual(['a-mine', 'z-mine']);
    expect(g.free.map((a) => a.name)).toEqual(['free']);
    expect(g.team.map((a) => a.name)).toEqual(['other-sub', 'theirs']);
  });

  it('leaseCountdown', () => {
    const now = Date.parse('2026-10-01T10:00:00Z');
    expect(leaseCountdown(null, now)).toBeNull();
    expect(leaseCountdown('2026-10-01T13:12:00Z', now)).toBe('3h 12m');
    expect(leaseCountdown('2026-10-01T10:04:00Z', now)).toBe('4m');
    expect(leaseCountdown('2026-10-01T10:00:20Z', now)).toBe('1m');
    expect(leaseCountdown('2026-10-01T09:00:00Z', now)).toBe('expired');
    expect(leaseCountdown('garbage', now)).toBeNull();
  });

  it('userColor and currentTaskTitle', () => {
    const users = new Map([[ana.id, ana]]);
    expect(userColor(users, 'u-ana')).toBe('#2563eb');
    expect(userColor(users, 'nobody')).toBe('#64748b');
    const a = agent({ id: 'x' });
    expect(currentTaskTitle(a, [task({ agent_id: 'x', status: 'running', prompt: 'build auth' })])).toBe('build auth');
    expect(currentTaskTitle(a, [task({ agent_id: 'x', status: 'pending' })])).toBeNull();
    expect(currentTaskTitle(a, [task({ agent_id: 'x', status: 'running', prompt: 'x'.repeat(80) })])?.endsWith('…')).toBe(true);
  });

  it('presence: active = holds agents, most agents first', () => {
    const entries = presence([ana, bob], [agent({ owner_id: 'u-bob' }), agent({ owner_id: 'u-bob' }), agent({ owner_id: null })]);
    expect(entries.map((e) => [e.user.name, e.agentCount, e.active])).toEqual([['bob', 2, true], ['ana', 0, false]]);
  });

  it('swimlanes by creator, System last, active work first', () => {
    const lanes = swimlanes([
      task({ id: '1', created_by: 'u-bob', status: 'done' }),
      task({ id: '2', created_by: 'u-bob', status: 'running' }),
      task({ id: '3', created_by: null }),
      task({ id: '4', created_by: 'u-ana', status: 'blocked' }),
    ], new Map([[ana.id, ana], [bob.id, bob]]));
    expect(lanes.map((l) => l.label)).toEqual(['ana', 'bob', 'System']);
    expect(lanes[1].tasks.map((t) => t.id)).toEqual(['2', '1']);
    expect(lanes[1].color).toBe('#16a34a');
  });

  it('action placeholders, filling and api paths', () => {
    const action: ThreadAction = {
      id: 'hand_off', label: 'Hand off', method: 'POST', path: '/api/reviews/r1/handoff',
      body: { targetAgentId: '{agent_id}', note: 'fixed {missing}' },
    };
    expect(actionPlaceholders(action).sort()).toEqual(['agent_id', 'missing']);
    expect(fillAction(action, { agent_id: 'a9' }).body).toEqual({ targetAgentId: 'a9', note: 'fixed {missing}' });
    expect(actionPlaceholders({ id: 'f', label: 'f', method: 'POST', path: '/api/artifacts/{artifact_id}/share' })).toEqual(['artifact_id']);
    expect(apiRelativePath('/api/runs/r1/log')).toBe('/runs/r1/log');
    expect(apiRelativePath('/other')).toBe('/other');
  });

  it('mergeThreadItems replaces known items by id, appends new ones in event order, caps', () => {
    const a = { id: 'ev-1', event_id: 1, v: 'old' };
    const b = { id: 'ev-2', event_id: 2, v: 'old' };
    const merged = mergeThreadItems([a, b], [{ id: 'ev-3', event_id: 3, v: 'new' }, { id: 'ev-1', event_id: 1, v: 'fresh' }], 10);
    expect(merged.map((i) => `${i.id}:${i.v}`)).toEqual(['ev-1:fresh', 'ev-2:old', 'ev-3:new']);
    expect(mergeThreadItems([a, b], [], 10)).toEqual([a, b]);
    expect(mergeThreadItems([a, b], [{ id: 'ev-3', event_id: 3, v: 'x' }], 2).map((i) => i.id)).toEqual(['ev-2', 'ev-3']);
  });

  it('ownership changes invalidate actions already on screen', () => {
    for (const t of ['agent.reserved', 'agent.released', 'agent.lease_expired', 'agent.killed', 'user.revoked']) {
      expect(invalidatesThreadActions(t), t).toBe(true);
    }
    for (const t of ['run.finished', 'agent.prompt_sent', 'message.created']) {
      expect(invalidatesThreadActions(t), t).toBe(false);
    }
  });

  it('parseSlashCommand', () => {
    expect(parseSlashCommand('hello')).toBeNull();
    expect(parseSlashCommand('/reserve 4h')).toEqual({ ok: true, command: { cmd: 'reserve', hours: 4 } });
    expect(parseSlashCommand('/reserve 1.5')).toEqual({ ok: true, command: { cmd: 'reserve', hours: 1.5 } });
    expect(parseSlashCommand('/reserve')).toEqual({ ok: true, command: { cmd: 'reserve', hours: 4 } });
    expect(parseSlashCommand('/reserve 48h')).toMatchObject({ ok: false });
    expect(parseSlashCommand('/reserve soon')).toMatchObject({ ok: false });
    for (const cmd of ['release', 'kill', 'review', 'promote', 'retry'] as const) {
      expect(parseSlashCommand(` /${cmd.toUpperCase()} `)).toEqual({ ok: true, command: { cmd } });
    }
    expect(parseSlashCommand('/deploy')).toMatchObject({ ok: false, error: expect.stringMatching(/Unknown command \/deploy/) });
  });
});
