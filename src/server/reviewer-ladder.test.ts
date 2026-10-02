/**
 * Reviewer assignment ladder: explicit → task → config default → tagged free → any free → none.
 * Developers stay in charge; the system fills gaps with free agents only, other vendor preferred.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('./event-bus.js', () => ({ emit: vi.fn() }));

const review = { auto_review: true, default_reviewer: '', self_review: false, max_fix_loops: 2, require_pass_to_promote: false, gate_dependents_on_approval: false, auto_pick: true };
const profiles: Record<string, { shared?: boolean }> = {};
vi.mock('./config.js', () => ({ getConfig: vi.fn(() => ({ review, profiles, profiles_root: '/tmp/p' })) }));

import * as db from './db.js';
import { reserveAgent } from './leases.js';
import { createUser } from './users.js';
import { pickReviewer } from './reviewer-ladder.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-ladder-'));
  db.initDb(path.join(tmp, 't.db'));
  review.default_reviewer = '';
  review.auto_pick = true;
  for (const k of Object.keys(profiles)) delete profiles[k];
});
afterEach(() => {
  db.resetDbForTest();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function agent(name: string, over: Partial<Parameters<typeof db.insertAgent>[0]> = {}): db.Agent {
  const r = db.insertAgent({ name, runtime: 'codex', tmux_session: `wc-${name}`, workspace: null, mode: 'spawned', status: 'idle', ...over });
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

function runBy(author: db.Agent, over: { created_by?: string | null; reviewer?: string | null } = {}): db.Run {
  const t = db.insertTask({ prompt: 'build', agent_id: author.id, created_by: over.created_by ?? null, reviewer: over.reviewer ?? null });
  if (!t.ok) throw new Error(t.error);
  const r = db.insertRun({ task_id: t.data.id, agent_id: author.id });
  if (!r.ok) throw new Error(r.error);
  db.finishRun(r.data.id, 0);
  return r.data;
}

describe('pickReviewer', () => {
  it('rung 1: an explicit reviewer wins even when busy; the author is refused', () => {
    const author = agent('codex1');
    const opus = agent('opus', { runtime: 'claude-code', status: 'working' });
    const run = runBy(author);
    const pick = pickReviewer(run, { explicit: 'opus' });
    expect(pick).toMatchObject({ ok: true, rung: 'explicit', agent: { id: opus.id }, reason: 'named by you' });
    const self = pickReviewer(run, { explicit: 'codex1' });
    expect(self).toMatchObject({ ok: false });
    expect((self as { reason: string }).reason).toMatch(/cannot review/);
    expect(pickReviewer(run, { explicit: 'nobody' })).toMatchObject({ ok: false });
  });

  it('rung 2: the reviewer set on the task', () => {
    const author = agent('codex1');
    const opus = agent('opus', { runtime: 'claude-code', status: 'working' });
    agent('free-one');
    const run = runBy(author, { reviewer: opus.id });
    expect(pickReviewer(run)).toMatchObject({ ok: true, rung: 'task', agent: { id: opus.id } });
  });

  it('rung 3: config default_reviewer by name, then by runtime (free one of that runtime first)', () => {
    const author = agent('codex1');
    const busyClaude = agent('claude-a', { runtime: 'claude-code', status: 'working' });
    const freeClaude = agent('claude-b', { runtime: 'claude-code' });
    const run = runBy(author);
    review.default_reviewer = 'claude-a';
    expect(pickReviewer(run)).toMatchObject({ ok: true, rung: 'default', agent: { id: busyClaude.id } });
    review.default_reviewer = 'claude-code';
    expect(pickReviewer(run)).toMatchObject({ ok: true, rung: 'default', agent: { id: freeClaude.id } });
    // the author never, even when it is the only one of that runtime
    const soloRun = runBy(freeClaude);
    review.default_reviewer = 'claude-b';
    const pick = pickReviewer(soloRun);
    expect(pick.ok && pick.agent.id).not.toBe(freeClaude.id);
  });

  it('rung 4: a free agent tagged review, other vendor first; busy/reserved/seat agents are skipped', () => {
    const author = agent('codex1');
    const sameVendorTagged = agent('codex-rev');
    const otherVendorTagged = agent('claude-rev', { runtime: 'claude-code' });
    const busyTagged = agent('grok-rev', { runtime: 'grok', status: 'working' });
    const reservedTagged = agent('grok-rev2', { runtime: 'grok' });
    const seat = agent('pm', { runtime: 'claude-code', role: 'orchestrator' } as never);
    for (const a of [sameVendorTagged, otherVendorTagged, busyTagged, reservedTagged, seat]) db.addAgentTag(a.id, 'review');
    const ana = createUser({ name: 'ana', role: 'developer' });
    if (!ana.ok) throw new Error(ana.error);
    expect(reserveAgent(reservedTagged.id, ana.data.user, 1).ok).toBe(true);

    const pick = pickReviewer(runBy(author));
    expect(pick).toMatchObject({ ok: true, rung: 'tag', agent: { id: otherVendorTagged.id }, reason: 'free, tagged review, other vendor' });
    expect((pick as { alternatives: db.Agent[] }).alternatives.map((a) => a.name)).toEqual(['codex-rev']);
  });

  it('rung 5: any free agent, other vendor preferred, same vendor as fallback', () => {
    const author = agent('codex1');
    const same = agent('codex2');
    const run = runBy(author);
    expect(pickReviewer(run)).toMatchObject({ ok: true, rung: 'pool', agent: { id: same.id }, reason: 'free, same vendor' });
    const other = agent('grok1', { runtime: 'grok' });
    const pick = pickReviewer(run);
    expect(pick).toMatchObject({ ok: true, rung: 'pool', agent: { id: other.id }, reason: 'free, other vendor' });
    expect((pick as { alternatives: db.Agent[] }).alternatives.map((a) => a.id)).toEqual([same.id]);
  });

  it('profiles: a free agent on someone else\'s subscription is not free for this task', () => {
    profiles.ana = {};
    profiles.bob = {};
    const ana = createUser({ name: 'ana', role: 'developer' });
    if (!ana.ok) throw new Error(ana.error);
    const author = agent('codex1', { profile: 'ana' } as never);
    agent('bobs', { runtime: 'claude-code', profile: 'bob' } as never);
    const run = runBy(author, { created_by: ana.data.user.id });
    expect(pickReviewer(run)).toMatchObject({ ok: false });
    const mine = agent('anas', { runtime: 'claude-code', profile: 'ana' } as never);
    expect(pickReviewer(run)).toMatchObject({ ok: true, agent: { id: mine.id } });
  });

  it('none: auto_pick off, or nobody free → candidates for a person to pick (never the author)', () => {
    const author = agent('codex1');
    const busy = agent('opus', { runtime: 'claude-code', status: 'working' });
    const run = runBy(author);
    const none = pickReviewer(run);
    expect(none.ok).toBe(false);
    expect((none as { candidates: db.Agent[] }).candidates.map((a) => a.id)).toEqual([busy.id]);

    agent('free-one');
    review.auto_pick = false;
    const off = pickReviewer(run);
    expect(off).toMatchObject({ ok: false });
    expect((off as { reason: string }).reason).toMatch(/auto-pick is off/);
  });
});
