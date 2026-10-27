import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

vi.mock('./event-bus.js', () => ({ emit: vi.fn(() => ({ id: 1 })) }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./wire-lines.js', () => {
  const deliverSystemLine = vi.fn(async () => undefined);
  return {
    deliverSystemLine,
    // the real helper fans one line out to deliveries.notify + the actor through deliverSystemLine
    tellDriverSeats: vi.fn(async (text: string, extra: string | null) => {
      const { resolveAgent } = await import('./db.js');
      const targets = new Set<string>([...(cfg.deliveries?.notify ?? []), ...(extra ? [extra] : [])]);
      for (const ref of targets) { const a = resolveAgent(ref); if (a.ok) await deliverSystemLine(a.data, text, { kind: 'info', source: 'delivery' }); }
    }),
  };
});
const cfg: { deliveries?: { notify?: string[]; budgets_min?: Record<string, number>; auto_desk?: boolean } } = {};
vi.mock('./config.js', () => ({ getConfig: vi.fn(() => cfg) }));

import { emit } from './event-bus.js';
import { deliverSystemLine } from './wire-lines.js';
import * as db from './db.js';
import * as del from './deliveries.js';

const LANE = 'wc-codex1-bank-simple-posting';
const A = '4fa51cd40413361421359e88f798db4c7f18aa54';
const B = 'caa03cde0d7fa69989e9ec02f41a93c18ff18f8b';
const M = '43bca6d97d28b76cf6aea2437481bfff2f5d726f';
const T0 = Date.UTC(2026, 9, 27, 11, 0, 0);

let tmp: string;
let clock = T0;

function at(min: number): string {
  return new Date(T0 + min * 60_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function ev(min: number, type: string, entityId: string, payload: Record<string, unknown>): void {
  db.getDb().prepare('INSERT INTO events (type, entity_type, entity_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(type, 'run', entityId, JSON.stringify(payload), at(min));
}

function stages(id: string): string[] {
  return del.listStages(id).map((s) => `${s.stage}#${s.attempt}:${s.outcome ?? 'open'}${s.sha ? '@' + s.sha.slice(0, 4) : ''}`);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-del-'));
  db.initDb(path.join(tmp, 't.db'));
  del.resetDeliveryStallMemoryForTest();
  clock = T0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  cfg.deliveries = { notify: ['pm-denis'] };
  db.insertAgent({ name: 'pm-denis', runtime: 'claude-code', tmux_session: 'wc-pm-denis', workspace: null, mode: 'spawned', status: 'idle' } as never);
  db.insertAgent({ name: 'codex1', runtime: 'codex', tmux_session: 'wc-codex1', workspace: null, mode: 'spawned', status: 'idle' } as never);
  vi.mocked(emit).mockClear();
  vi.mocked(deliverSystemLine).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  try { db.closeDb?.(); } catch { /* not exported in every build */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('delivery derivation', () => {
  it('a hand merge on GitHub (lane.retired: every commit on main) closes land; notes stick to their own SHA', () => {
    const created = del.createDelivery({ title: 'Fixes', lanes: ['wc-x-fix', 'wc-y-fix'], since: new Date(T0).toISOString() });
    if (!created.ok) throw new Error(created.error);
    const id = created.data.id;
    const X = 'a'.repeat(40); const Y = 'b'.repeat(40);
    ev(1, 'pipeline.frozen', X, { sha: X, lane: 'wc-x-fix' });
    ev(2, 'pipeline.frozen', Y, { sha: Y, lane: 'wc-y-fix' });
    ev(3, 'pipeline.quick', `${X}:quick`, { sha: X, lane: 'wc-x-fix', quick: 'QUEUED' });
    ev(3, 'pipeline.quick', `${Y}:quick`, { sha: Y, lane: 'wc-y-fix', quick: 'QUEUED' });
    ev(4, 'merge_queue.queued', X, { sha: X, lane: 'wc-x-fix', tier: 'ask' });
    // a note about Y's quick check must not land on X's spans
    ev(5, 'pipeline.action', 'wavepulse:wc-y-fix', { action: 'quick', sha: Y, lane: 'wc-y-fix', note: "auto: quick check on bbbbbbbb waits for @y's other run" });
    // a refusal for a SHA nobody tracks on lane x goes to build only (nothing open there) and never to X's gates/land
    ev(6, 'pipeline.refused', 'c'.repeat(40), { sha: 'c'.repeat(40), lane: 'wc-x-fix', reason: 'ccccccc is not on origin/wc-x-fix — push the exact SHA first' });
    ev(10, 'lane.retired', `wc-x-fix@${X.slice(0, 8)}`, { lane: 'wc-x-fix', tip: X, why: 'git cherry origin/main wc-x-fix is empty: every commit of the lane is on main', freezes_closed: 1 });
    const derived = del.deriveDelivery(id);
    if (!derived.ok) throw new Error(derived.error);
    const spans = derived.data.spans;
    const landX = spans.find((s) => s.stage === 'land' && s.sha === X)!;
    expect(landX.outcome).toBe('ok');
    expect(landX.cause).toContain('outside the queue');
    expect(spans.find((s) => s.stage === 'gates' && s.sha === X)!.outcome).toBe('ok');
    expect(spans.filter((s) => s.sha === X).every((s) => !(s.cause ?? '').includes('waits for'))).toBe(true);
    expect(spans.find((s) => s.stage === 'gates' && s.sha === Y)!.cause).toContain("waits for @y's other run");
    expect(spans.filter((s) => (s.cause ?? '').includes('not on origin'))).toEqual([]);
  });

  it('derives the bank-posting day: freeze, first pass, gates, review, land, candidate, release', () => {
    const created = del.createDelivery({ title: 'Bank simple posting', project: 'wavepulse', lanes: [LANE], since: new Date(T0).toISOString(), created_by: 'denis' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.data.id;

    ev(10, 'pipeline.frozen', A, { sha: A, project: 'wavepulse', lane: LANE });
    ev(11, 'pipeline.first_pass_requested', A, { sha: A, lane: LANE, seat: 'codex3' });
    ev(11, 'pipeline.quick', `${A}:quick`, { sha: A, lane: LANE, quick: 'QUEUED' });
    ev(11, 'pipeline.review', `${A}:assign`, { sha: A, kind: 'assign', reviewer_id: 'x' });
    ev(14, 'pipeline.first_pass', A, { sha: A, result: 'pass', seat: 'codex3' });
    ev(20, 'gate.result', A, { sha: A, suite: 'quick', state: 'GREEN' });
    ev(25, 'review.ai_completed', 'r1', { verdict: 'pass', reviewer_agent: 'claude4', freeze: { sha: A, lane: LANE } });
    ev(30, 'gate.result', A, { sha: A, suite: 'api', state: 'GREEN' });
    // main moved: the lane re-freezes on a sync merge; A's open spans are superseded
    ev(40, 'pipeline.frozen', B, { sha: B, project: 'wavepulse', lane: LANE });
    ev(41, 'pipeline.action', `wavepulse:${LANE}`, { action: 'quick', sha: B, lane: LANE, note: "auto: quick check on caa03cde waits for @codex1's other run" });
    ev(41, 'pipeline.quick', `${B}:quick`, { sha: B, lane: LANE, quick: 'QUEUED' });
    ev(55, 'gate.result', B, { sha: B, suite: 'full', state: 'GREEN' });
    ev(56, 'merge_queue.queued', B, { sha: B, lane: LANE, tier: 'ask' });
    ev(62, 'merge_queue.merged', B, { lane: LANE, sha_in: B, sha_out: M, main_before: 'a'.repeat(40) });
    ev(90, 'release.requested', 'rel1', { target: 'production', sha: M, project: 'wavepulse', requested_by: 'denis' });
    ev(120, 'release.reported', 'rel1', { target: 'production', status: 'deployed', sha: M, version: '0.450.0' });

    const derived = del.deriveDelivery(id);
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    expect(stages(id)).toEqual([
      'spec#1:ok',
      'build#1:ok@4fa5',
      'first_pass#1:ok@4fa5',
      'gates#1:ok@4fa5',
      'review#1:ok@4fa5',
      'gates#2:ok@caa0',
      'land#1:ok@caa0',
      'candidate#1:ok@43bc',
      'release#1:ok@43bc',
    ]);
    expect(derived.data.delivery.status).toBe('done');
    expect(derived.data.delivery.shas).toEqual(expect.arrayContaining([A, B, M]));
    const gatesB = del.listStages(id).find((s) => s.stage === 'gates' && s.sha === B)!;
    expect(gatesB.cause).toBeNull(); // the block was cleared by the GREEN result
    expect(gatesB.finished_at).toBe(new Date(T0 + 55 * 60_000).toISOString());
  });

  it('a RED gate or NEEDS FIXES reopens build with attempt+1, and the current stage follows the earliest open span', () => {
    const created = del.createDelivery({ title: 'PD158', lanes: ['wc-codex2-pd158'], since: new Date(T0).toISOString() });
    if (!created.ok) throw new Error(created.error);
    const id = created.data.id;
    ev(5, 'pipeline.frozen', A, { sha: A, lane: 'wc-codex2-pd158' });
    ev(6, 'pipeline.review', `${A}:assign`, { sha: A, kind: 'assign' });
    ev(6, 'pipeline.quick', `${A}:quick`, { sha: A, lane: 'wc-codex2-pd158', quick: 'QUEUED' });
    ev(15, 'gate.result', A, { sha: A, suite: 'quick', state: 'RED' });
    let d = del.deriveDelivery(id);
    if (!d.ok) throw new Error(d.error);
    expect(stages(id)).toEqual(['spec#1:ok', 'build#1:ok@4fa5', 'review#1:open@4fa5', 'gates#1:fail@4fa5', 'build#2:open']);
    expect(d.data.delivery.stage).toBe('build');
    expect(d.data.delivery.attempts).toBe(2);
    ev(30, 'pipeline.frozen', B, { sha: B, lane: 'wc-codex2-pd158' });
    d = del.deriveDelivery(id);
    if (!d.ok) throw new Error(d.error);
    expect(stages(id)).toEqual(['spec#1:ok', 'build#1:ok@4fa5', 'review#1:superseded@4fa5', 'gates#1:fail@4fa5', 'build#2:ok@caa0']);
    expect(d.data.delivery.stage).toBe('build'); // nothing open after the freeze yet: the last build is what the card shows
  });
});

describe('stalls', () => {
  it('an overrun is reported once although its minute count grows, and stalls older than the record are shown but not messaged', async () => {
    const created = del.createDelivery({ title: 'Old', lanes: [LANE], since: new Date(T0 - 120 * 60_000).toISOString() });
    if (!created.ok) throw new Error(created.error);
    const id = created.data.id;
    ev(-100, 'pipeline.frozen', A, { sha: A, lane: LANE });
    ev(-99, 'pipeline.quick', `${A}:quick`, { sha: A, lane: LANE, quick: 'QUEUED' });
    const d = del.deriveDelivery(id);
    if (!d.ok) throw new Error(d.error);
    // gates open since T0-99 min: over budget already, but it predates the record (created at T0)
    const first = await del.reportStalls(d.data.delivery, d.data.spans, T0 + 1 * 60_000);
    expect(first).toEqual([]);
    expect(del.getDelivery(id)!.stall_cause).toContain('OVERRUN');
    expect(vi.mocked(deliverSystemLine)).not.toHaveBeenCalled();
    // a new span after the record's creation is messaged once, and not again as the minutes grow
    ev(5, 'pipeline.frozen', B, { sha: B, lane: LANE });
    ev(6, 'pipeline.quick', `${B}:quick`, { sha: B, lane: LANE, quick: 'QUEUED' });
    const d2 = del.deriveDelivery(id);
    if (!d2.ok) throw new Error(d2.error);
    const over = await del.reportStalls(d2.data.delivery, d2.data.spans, T0 + 40 * 60_000);
    expect(over.map((s) => [s.stage, s.code, s.sha])).toEqual([['gates', 'OVERRUN', B]]);
    const again = await del.reportStalls(d2.data.delivery, d2.data.spans, T0 + 41 * 60_000);
    expect(again).toEqual([]);
    expect(vi.mocked(deliverSystemLine)).toHaveBeenCalledTimes(1);
  });

  it('reports a blocked gate once, with the pipeline note as the cause, and an overrun once the budget passes', async () => {
    const created = del.createDelivery({ title: 'Bank', lanes: [LANE], since: new Date(T0).toISOString() });
    if (!created.ok) throw new Error(created.error);
    const id = created.data.id;
    ev(10, 'pipeline.frozen', A, { sha: A, lane: LANE });
    ev(11, 'pipeline.quick', `${A}:quick`, { sha: A, lane: LANE, quick: 'QUEUED' });
    ev(12, 'pipeline.action', `wavepulse:${LANE}`, { action: 'quick', sha: A, lane: LANE, note: "auto: quick check waits for @codex1's other run" });
    const d = del.deriveDelivery(id);
    if (!d.ok) throw new Error(d.error);

    const first = await del.reportStalls(d.data.delivery, d.data.spans, T0 + 15 * 60_000);
    expect(first.map((s) => [s.stage, s.code])).toEqual([['gates', 'BLOCKED']]);
    expect(first[0].cause).toContain("waits for @codex1's other run");
    expect(vi.mocked(emit)).toHaveBeenCalledWith('delivery.stalled', 'delivery', id, expect.objectContaining({ stage: 'gates', code: 'BLOCKED' }), null);
    expect(vi.mocked(deliverSystemLine)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deliverSystemLine).mock.calls[0][1]).toContain('gates is blocked');
    expect(del.getDelivery(id)!.stall_cause).toContain('BLOCKED');

    // same cause again: nothing new
    const again = await del.reportStalls(d.data.delivery, d.data.spans, T0 + 16 * 60_000);
    expect(again).toEqual([]);
    expect(vi.mocked(deliverSystemLine)).toHaveBeenCalledTimes(1);

    // the block clears with a GREEN quick, api still missing: after the budget the gate is an overrun
    ev(20, 'gate.result', A, { sha: A, suite: 'quick', state: 'GREEN' });
    const d2 = del.deriveDelivery(id);
    if (!d2.ok) throw new Error(d2.error);
    expect(await del.reportStalls(d2.data.delivery, d2.data.spans, T0 + 21 * 60_000)).toEqual([]);
    expect(del.getDelivery(id)!.stall_cause).toBeNull();
    const over = await del.reportStalls(d2.data.delivery, d2.data.spans, T0 + 11 * 60_000 + 26 * 60_000);
    expect(over.map((s) => [s.stage, s.code])).toEqual([['gates', 'OVERRUN']]);
    expect(over[0].cause).toMatch(/budget 25 min/);
  });

  it('budgets come from config', () => {
    cfg.deliveries = { budgets_min: { gates: 5 } };
    const created = del.createDelivery({ title: 'x', lanes: [LANE], since: new Date(T0).toISOString() });
    if (!created.ok) throw new Error(created.error);
    ev(1, 'pipeline.frozen', A, { sha: A, lane: LANE });
    ev(2, 'pipeline.quick', `${A}:quick`, { sha: A, lane: LANE, quick: 'QUEUED' });
    const d = del.deriveDelivery(created.data.id);
    if (!d.ok) throw new Error(d.error);
    expect(del.findStalls(d.data.delivery, d.data.spans, T0 + 6 * 60_000)).toEqual([]);
    expect(del.findStalls(d.data.delivery, d.data.spans, T0 + 8 * 60_000).map((s) => s.code)).toEqual(['OVERRUN']);
  });
});

describe('delivery routes', () => {
  async function app(role: 'developer' | 'observer' | 'admin' = 'developer') {
    const { registerDeliveryRoutes } = await import('./routes/deliveries.js');
    const a = new Hono();
    a.use('*', async (c, next) => { c.set('user' as never, { id: 'u1', name: 'denis', role, color: '#fff', profile: null } as never); await next(); });
    registerDeliveryRoutes(a as never);
    return a;
  }
  async function call(a: Hono, url: string, method = 'GET', body?: unknown) {
    const res = await a.fetch(new Request(`http://x${url}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined }));
    return { status: res.status, json: await res.json() as Record<string, unknown> & Record<string, never>[] };
  }

  it('creates, lists with time in stage, adds lanes, and closes a delivery; observers are refused', async () => {
    const a = await app();
    ev(5, 'pipeline.frozen', A, { sha: A, lane: LANE });
    const created = await call(a, '/api/deliveries', 'POST', { title: 'Bank', project: 'wavepulse', lanes: [LANE], since: new Date(T0).toISOString() });
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    expect((created.json.stages as unknown[]).length).toBeGreaterThan(0);
    const list = await call(a, '/api/deliveries');
    expect(list.status).toBe(200);
    expect((list.json as unknown as Array<{ id: string; stage: string; stage_minutes: number | null }>)[0]).toMatchObject({ id, stage: 'build' });
    const lanes = await call(a, `/api/deliveries/${id}/lanes`, 'POST', { lanes: ['wc-claude6-bank-posting-ui'] });
    expect(lanes.status).toBe(200);
    expect(lanes.json.lanes).toEqual([LANE, 'wc-claude6-bank-posting-ui']);
    const closed = await call(a, `/api/deliveries/${id}/status`, 'POST', { status: 'cancelled' });
    expect(closed.status).toBe(200);
    expect((await call(a, '/api/deliveries')).json).toEqual([]);
    expect((await call(a, '/api/deliveries?status=all')).json).toHaveLength(1);
    const bad = await call(a, '/api/deliveries', 'POST', { lanes: [LANE] });
    expect(bad.status).toBe(400);
    const obs = await app('observer');
    expect((await call(obs, '/api/deliveries', 'POST', { title: 'no' })).status).toBe(403);
    expect((await call(obs, `/api/deliveries/${id}`)).status).toBe(200);
    expect((await call(obs, '/api/deliveries/nope')).status).toBe(404);
  });
});

describe('deliveries keyed by product-desk number', () => {
  function freezeRow(sha: string, lane: string, desk: number | null, createdAt: string): void {
    db.getDb().prepare('INSERT INTO release_freezes (sha, project, desk, lane, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sha, 'wavepulse', desk, lane, 'open', createdAt, createdAt);
  }
  it('a freeze with a desk number opens PD-<n> (or joins it) with its lane; a second desk record is refused', async () => {
    const { ensureReleaseFreezeTable } = await import('./release-freezes.js');
    ensureReleaseFreezeTable();
    freezeRow('1'.repeat(40), 'wc-codex1-pd134-overview', 134, at(-60));
    freezeRow('2'.repeat(40), 'wc-claude2-pd134-tests', 134, at(-30));
    freezeRow('3'.repeat(40), 'wc-codex6-no-desk', null, at(-20));
    const first = del.adoptDeskLanes(db.getDb().prepare('SELECT desk, lane, project, created_at FROM release_freezes').all() as never);
    expect(first.created).toHaveLength(1);
    const d = del.findOpenByDesk(134)!;
    expect(d).toMatchObject({ title: 'PD-134', desk: 134, project: 'wavepulse', created_by: 'tracker' });
    expect(d.lanes.sort()).toEqual(['wc-claude2-pd134-tests', 'wc-codex1-pd134-overview']);
    expect(new Date(d.since_at).getTime()).toBe(T0 - 60 * 60_000 - 24 * 3600_000);
    freezeRow('4'.repeat(40), 'wc-codex1-pd134-fix', 134, at(0));
    const again = del.adoptDeskLanes(db.getDb().prepare('SELECT desk, lane, project, created_at FROM release_freezes').all() as never);
    expect(again.created).toEqual([]);
    expect(again.joined).toEqual([`${d.id}:wc-codex1-pd134-fix`]);
    expect(del.findOpenByDesk(134)!.lanes).toContain('wc-codex1-pd134-fix');
    expect(del.createDelivery({ desk: 134 })).toMatchObject({ ok: false, error: expect.stringMatching(/already tracked/) });
    expect(del.listDeliveries({ desk: 134 }).map((x) => x.id)).toEqual([d.id]);
    expect(del.listDeliveries({ desk: 999 })).toEqual([]);
  });
  it('auto_desk: false leaves freezes alone', () => {
    cfg.deliveries = { notify: [], auto_desk: false };
    expect(del.adoptDeskLanes([{ desk: 5, lane: 'wc-x', project: null, created_at: at(0) }])).toEqual({ created: [], joined: [] });
    expect(del.findOpenByDesk(5)).toBeNull();
  });
});
