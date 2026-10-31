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
const cfg: { deliveries?: { notify?: string[]; budgets_min?: Record<string, number>; auto_desk?: boolean; auto_track?: boolean }; projects?: Record<string, { repo?: string }> } = {};
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
    // The tick loads the signals once for every open delivery and hands them in: same spans.
    const shared = del.loadSignals(new Date(T0 - 60 * 60_000).toISOString());
    const again = del.deriveDelivery(id, shared);
    if (!again.ok) throw new Error(again.error);
    const strip = (rows: typeof spans) => rows.map(({ id: _id, ...rest }) => rest);
    expect(strip(again.data.spans)).toEqual(strip(spans));
    expect(spans.filter((s) => (s.cause ?? '').includes('not on origin'))).toEqual([]);
  });

  it('the tick keeps its signals between passes and reads only the rows written since (by id); an older window reloads', () => {
    del.resetSignalCacheForTest();
    const created = del.createDelivery({ title: 'Cache', project: 'wavepulse', lanes: [LANE], since: new Date(T0).toISOString(), created_by: 'denis' });
    if (!created.ok) throw new Error(created.error);
    ev(1, 'pipeline.frozen', A, { sha: A, project: 'wavepulse', lane: LANE });
    ev(2, 'agent.output_updated', 'x', {}); // not a signal: never cached
    const since = new Date(T0).toISOString();
    const first = del.cachedSignals(since);
    expect(first.map((e) => e.type)).toEqual(['pipeline.frozen']);
    expect(first[0].at_ms).toBe(Date.parse(first[0].created_at));
    ev(3, 'pipeline.quick', `${A}:quick`, { sha: A, lane: LANE, quick: 'QUEUED' });
    const second = del.cachedSignals(since);
    expect(second).toBe(first); // same array, appended in place
    expect(second.map((e) => e.type)).toEqual(['pipeline.frozen', 'pipeline.quick']);
    expect(del.cachedSignals(since).length).toBe(2); // nothing new: nothing appended twice
    // the oldest open delivery moved later: older signals leave the cache
    expect(del.cachedSignals(new Date(T0 + 2 * 60_000).toISOString()).map((e) => e.type)).toEqual(['pipeline.quick']);
    // an older window than the cache holds reloads from the database
    expect(del.cachedSignals(since).map((e) => e.type)).toEqual(['pipeline.frozen', 'pipeline.quick']);
    // same spans whether the tick's cache or a direct load feeds the derivation
    const viaCache = del.deriveDelivery(created.data.id, del.cachedSignals(since));
    const direct = del.deriveDelivery(created.data.id);
    if (!viaCache.ok || !direct.ok) throw new Error('derive failed');
    const strip = (rows: typeof direct.data.spans) => rows.map(({ id: _id, ...rest }) => rest);
    expect(strip(viaCache.data.spans)).toEqual(strip(direct.data.spans));
  });

  it('the rolling candidate review rides on the candidate span: reviewer as actor, NEEDS FIXES as its cause; a cancelled run supersedes its gates span', () => {
    const created = del.createDelivery({ title: 'Posting', project: 'wavepulse', lanes: [LANE], since: new Date(T0).toISOString(), created_by: 'denis' });
    if (!created.ok) throw new Error(created.error);
    const id = created.data.id;
    ev(10, 'pipeline.frozen', A, { sha: A, project: 'wavepulse', lane: LANE });
    ev(11, 'pipeline.quick', `${A}:quick`, { sha: A, lane: LANE, quick: 'QUEUED' });
    ev(12, 'pipeline.gate', `${A}:full`, { sha: A, lane: LANE, gate: 'QUEUED' });
    ev(20, 'pipeline.frozen', B, { sha: B, project: 'wavepulse', lane: LANE });
    ev(20, 'pipeline.gate', `${A}:full`, { sha: A, lane: LANE, gate: 'CANCELLED', reason: `superseded by ${B.slice(0, 8)}` });
    ev(21, 'pipeline.quick', `${B}:quick`, { sha: B, lane: LANE, quick: 'QUEUED' });
    ev(40, 'gate.result', B, { sha: B, suite: 'full', state: 'GREEN' });
    ev(41, 'merge_queue.queued', B, { sha: B, lane: LANE, tier: 'ship' });
    ev(50, 'merge_queue.merged', B, { lane: LANE, sha_in: B, sha_out: M, main_before: 'a'.repeat(40), author: 'codex1' });
    ev(51, 'pipeline.candidate_review', M, { kind: 'assign', project: 'wavepulse', sha: M, base: 'a'.repeat(40), lane: LANE, reviewer: 'claude4', reviewer_id: 'x' });
    let spans = del.deriveDelivery(id);
    if (!spans.ok) throw new Error(spans.error);
    const gatesA = spans.data.spans.find((s) => s.stage === 'gates' && s.sha === A)!;
    expect(gatesA.outcome).toBe('superseded');
    expect(gatesA.cause).toContain('superseded by');
    let cand = spans.data.spans.find((s) => s.stage === 'candidate' && s.sha === M)!;
    expect(cand.actor).toBe('claude4');
    expect(cand.cause).toBeNull();
    ev(70, 'pipeline.candidate_review', M, { kind: 'result', project: 'wavepulse', sha: M, result: 'needs-fixes', issues: 2, seat: 'claude4', file: '/inbox/wave-candidate-43bca6d9-20261028.md' });
    spans = del.deriveDelivery(id);
    if (!spans.ok) throw new Error(spans.error);
    cand = spans.data.spans.find((s) => s.stage === 'candidate' && s.sha === M)!;
    expect(cand.outcome).toBeNull();
    expect(cand.cause).toBe('candidate review NEEDS FIXES by @claude4 (2 issues), see /inbox/wave-candidate-43bca6d9-20261028.md');
    expect(del.findStalls(spans.data.delivery, spans.data.spans, T0 + 71 * 60_000).map((s) => `${s.stage}:${s.code}`)).toContain('candidate:BLOCKED');
  });

  it('a CANDIDATE REVIEW: PASS closes the candidate span ok, so it never raises an over-budget alarm (8c564ada, 31 Oct 2026)', () => {
    const created = del.createDelivery({ title: 'Pass', project: 'wavepulse', lanes: [LANE], since: new Date(T0).toISOString(), created_by: 'denis' });
    if (!created.ok) throw new Error(created.error);
    ev(10, 'pipeline.frozen', B, { sha: B, project: 'wavepulse', lane: LANE });
    ev(40, 'gate.result', B, { sha: B, suite: 'full', state: 'GREEN' });
    ev(41, 'merge_queue.queued', B, { sha: B, lane: LANE, tier: 'ship' });
    ev(50, 'merge_queue.merged', B, { lane: LANE, sha_in: B, sha_out: M, main_before: 'a'.repeat(40), author: 'codex1' });
    ev(51, 'pipeline.candidate_review', M, { kind: 'assign', project: 'wavepulse', sha: M, base: 'a'.repeat(40), lane: LANE, reviewer: 'claude4', reviewer_id: 'x' });
    ev(70, 'pipeline.candidate_review', M, { kind: 'result', project: 'wavepulse', sha: M, result: 'pass', issues: 0, seat: 'claude4', file: '/inbox/wave-candidate-43bca6d9-20261031.md' });
    const spans = del.deriveDelivery(created.data.id);
    if (!spans.ok) throw new Error(spans.error);
    const cand = spans.data.spans.find((s) => s.stage === 'candidate' && s.sha === M)!;
    expect(cand).toMatchObject({ outcome: 'ok', actor: 'claude4', cause: 'candidate review PASS' });
    expect(cand.finished_at).toBeTruthy();
    // hours later, past the 60 min candidate budget: no OVERRUN on the answered review
    expect(del.findStalls(spans.data.delivery, spans.data.spans, T0 + 600 * 60_000).filter((s) => s.stage === 'candidate')).toEqual([]);
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
    ev(12, 'pipeline.action', `wavepulse:${LANE}`, { action: 'quick', sha: A, lane: LANE, note: 'auto: quick check on aaaaaaaa refused — merge queue switched off' });
    const d = del.deriveDelivery(id);
    if (!d.ok) throw new Error(d.error);

    const first = await del.reportStalls(d.data.delivery, d.data.spans, T0 + 15 * 60_000);
    expect(first.map((s) => [s.stage, s.code])).toEqual([['gates', 'BLOCKED']]);
    expect(first[0].cause).toContain('merge queue switched off');
    expect(vi.mocked(emit)).toHaveBeenCalledWith('delivery.stalled', 'delivery', id, expect.objectContaining({ stage: 'gates', code: 'BLOCKED' }), null);
    expect(vi.mocked(deliverSystemLine)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deliverSystemLine).mock.calls[0][1]).toContain('gates is blocked');
    expect(del.getDelivery(id)!.stall_cause).toContain('BLOCKED');

    // same cause again: nothing new — and the memory is in the DB, so a restart does not re-send it either
    expect(db.getDb().prepare('SELECT count(*) AS n FROM delivery_stall_reports').get()).toEqual({ n: 1 });
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

  it('gateway queueing is the cause on the card, not a stall; past the budget it is one overrun that quotes the wait', async () => {
    const created = del.createDelivery({ title: 'Bank', lanes: [LANE], since: new Date(T0).toISOString() });
    if (!created.ok) throw new Error(created.error);
    const id = created.data.id;
    ev(10, 'pipeline.frozen', A, { sha: A, lane: LANE });
    ev(11, 'pipeline.quick', `${A}:quick`, { sha: A, lane: LANE, quick: 'QUEUED' });
    ev(12, 'pipeline.action', `wavepulse:${LANE}`, { action: 'quick', sha: A, lane: LANE, note: "auto: quick check on aaaaaaaa waits for @codex1's other run (the gateway keeps one queued run per agent)" });
    const d = del.deriveDelivery(id);
    if (!d.ok) throw new Error(d.error);
    expect(d.data.spans.find((s) => s.stage === 'gates')!.cause).toContain("waits for @codex1's other run");
    expect(await del.reportStalls(d.data.delivery, d.data.spans, T0 + 15 * 60_000)).toEqual([]);
    expect(del.getDelivery(id)!.stall_cause).toBeNull();
    // the queue counts change: still nothing to say
    ev(14, 'pipeline.action', `wavepulse:${LANE}`, { action: 'quick', sha: A, lane: LANE, note: 'auto: quick check on aaaaaaaa waits for a slot (2 running, 3 waiting)' });
    const d2 = del.deriveDelivery(id);
    if (!d2.ok) throw new Error(d2.error);
    expect(await del.reportStalls(d2.data.delivery, d2.data.spans, T0 + 16 * 60_000)).toEqual([]);
    expect(vi.mocked(deliverSystemLine)).not.toHaveBeenCalled();
    // past the gates budget (25 min): one overrun, with the wait in its text
    const over = await del.reportStalls(d2.data.delivery, d2.data.spans, T0 + 11 * 60_000 + 26 * 60_000);
    expect(over.map((s) => [s.stage, s.code])).toEqual([['gates', 'OVERRUN']]);
    expect(over[0].cause).toMatch(/budget 25 min; auto: quick check on aaaaaaaa waits for a slot/);
    expect(vi.mocked(deliverSystemLine)).toHaveBeenCalledTimes(1);
    expect(await del.reportStalls(d2.data.delivery, d2.data.spans, T0 + 11 * 60_000 + 27 * 60_000)).toEqual([]);
    expect(del.isQueueing("waits for @ales-claude2's other run")).toBe(true);
    expect(del.isQueueing('freeze refused — wc-x is not on origin')).toBe(false);
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
    const codex1 = db.listAgents().find((x) => x.name === 'codex1')!;
    const withAgent = await call(a, '/api/deliveries', 'POST', { title: 'Payments tabs', project: 'wavepulse', lanes: ['wc-codex6-payables-ready'], agent_ids: [codex1.id] });
    expect(withAgent.status).toBe(201);
    expect(withAgent.json).toMatchObject({ stage: 'build', agent_ids: [codex1.id] }); // an agent is on it: build, not spec
    expect((await call(a, '/api/deliveries', 'POST', { title: 'x', agent_ids: 'codex1' })).status).toBe(400);
    const obs = await app('observer');
    expect((await call(obs, '/api/deliveries', 'POST', { title: 'no' })).status).toBe(403);
    expect((await call(obs, `/api/deliveries/${id}`)).status).toBe(200);
    expect((await call(obs, '/api/deliveries/nope')).status).toBe(404);
  });
});

describe('deliveries keyed by product-desk number', () => {
  function freezeRow(sha: string, lane: string, desk: number | null, createdAt: string, file = `/inbox/${lane.replace('/', '-')}-freeze-${sha.slice(0, 8)}.md`): void {
    db.getDb().prepare('INSERT INTO release_freezes (sha, project, desk, lane, status, freeze_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sha, 'wavepulse', desk, lane, 'open', file, createdAt, createdAt);
  }
  const all = () => db.getDb().prepare('SELECT desk, lane, project, created_at, freeze_path FROM release_freezes').all() as never;
  it('a lane marked with a desk number opens PD-<n> (or joins it); a desk only mentioned in the note, a prose "lane" and an old freeze are skipped', async () => {
    const { ensureReleaseFreezeTable } = await import('./release-freezes.js');
    ensureReleaseFreezeTable();
    freezeRow('1'.repeat(40), 'wc-codex1-pd134-overview', 134, at(-60));
    freezeRow('2'.repeat(40), 'wc-claude2-pd134-tests', 134, at(-30));
    freezeRow('3'.repeat(40), 'wc-codex6-no-desk', null, at(-20));
    freezeRow('5'.repeat(40), 'codex2/vasco-v2-a1', 134, at(-10)); // PD-134 only in the note's prose: a reference
    freezeRow('6'.repeat(40), 'has', 134, at(-10), '/inbox/desk134-freeze-66666666.md'); // a word, not a branch
    freezeRow('7'.repeat(40), 'wc-old-pd134-lane', 134, at(-20 * 24 * 60)); // 20 days old
    freezeRow('8'.repeat(40), 'claude1/wavenetic-b4b', 116, at(-5), '/inbox/desk116-freeze-88888888.md'); // marked by the file name
    const first = del.adoptDeskLanes(all());
    expect(first.created).toHaveLength(2);
    expect(del.findOpenByDesk(116)!.lanes).toEqual(['claude1/wavenetic-b4b']);
    const d = del.findOpenByDesk(134)!;
    expect(d).toMatchObject({ title: 'PD-134', desk: 134, project: 'wavepulse', created_by: 'tracker' });
    expect(d.lanes.sort()).toEqual(['wc-claude2-pd134-tests', 'wc-codex1-pd134-overview']);
    expect(new Date(d.since_at).getTime()).toBe(T0 - 60 * 60_000 - 24 * 3600_000);
    freezeRow('4'.repeat(40), 'wc-codex1-pd134-fix', 134, at(0));
    const again = del.adoptDeskLanes(all());
    expect(again.created).toEqual([]);
    expect(again.joined).toEqual([`${d.id}:wc-codex1-pd134-fix`]);
    expect(del.findOpenByDesk(134)!.lanes).toContain('wc-codex1-pd134-fix');
    expect(del.createDelivery({ desk: 134 })).toMatchObject({ ok: false, error: expect.stringMatching(/already tracked/) });
    expect(del.listDeliveries({ desk: 134 }).map((x) => x.id)).toEqual([d.id]);
    expect(del.listDeliveries({ desk: 999 })).toEqual([]);
  });
  it('a task record opens in build with the agent as actor; a failed run and a hung agent block it, a finished run and resumed output clear it, the freeze ends it', async () => {
    const codex1 = db.listAgents().find((a) => a.name === 'codex1')!;
    const task = db.insertTask({ agent_id: codex1.id, prompt: 'Bank line: post to several konto rows\nDetails below…', created_by: null });
    expect(task.ok).toBe(true);
    if (!task.ok) return;
    const run = db.insertRun({ task_id: task.data.id, agent_id: codex1.id });
    if (!run.ok) return;
    const created = del.createDelivery({ title: 'Bank multi-konto', project: 'wavepulse', task_ids: [task.data.id], agent_ids: [codex1.id], since: new Date(T0).toISOString(), created_by: 'tracker' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.data.id;
    expect(created.data).toMatchObject({ stage: 'build', task_ids: [task.data.id], agent_ids: [codex1.id] });
    db.getDb().prepare('INSERT INTO events (type, entity_type, entity_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)').run('task.dispatched', 'task', task.data.id, JSON.stringify({ agent_id: codex1.id, agent_name: 'codex1' }), at(1));
    let d = del.deriveDelivery(id);
    expect(d.ok && stages(id)).toEqual(['build#1:open']);
    expect(d.ok && d.data.spans[0]).toMatchObject({ stage: 'build', actor: 'codex1', started_at: new Date(T0).toISOString(), cause: null });
    // the run fails: the build is blocked until the agent or a person acts
    db.getDb().prepare('INSERT INTO events (type, entity_type, entity_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)').run('run.failed', 'run', run.data.id, JSON.stringify({ agent_id: codex1.id, exit_code: 1, error: 'tests red' }), at(20));
    d = del.deriveDelivery(id);
    expect(d.ok && d.data.spans[0].cause).toBe('run failed: tests red');
    vi.setSystemTime(T0 + 21 * 60_000);
    await del.reportStalls(d.ok ? d.data.delivery : created.data, d.ok ? d.data.spans : [], T0 + 21 * 60_000);
    // the driver seat and the actor (codex1) both hear it, once
    expect(vi.mocked(deliverSystemLine).mock.calls.map((c) => c[1])).toEqual([expect.stringMatching(/\[delivery "Bank multi-konto"\] build is blocked: run failed: tests red/), expect.stringMatching(/build is blocked: run failed: tests red/)]);
    // a second run finishes: cleared. Then the agent goes quiet while working: blocked again, until it speaks.
    const run2 = db.insertRun({ task_id: task.data.id, agent_id: codex1.id, attempt: 2 });
    if (!run2.ok) return;
    db.getDb().prepare('INSERT INTO events (type, entity_type, entity_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)').run('run.finished', 'run', run2.data.id, JSON.stringify({ agent_id: codex1.id, exit_code: 0 }), at(30));
    d = del.deriveDelivery(id);
    expect(d.ok && d.data.spans[0].cause).toBeNull();
    db.getDb().prepare('INSERT INTO events (type, entity_type, entity_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)').run('agent.hung', 'agent', codex1.id, JSON.stringify({ name: 'codex1', stale_minutes: 12, action: 'alert' }), at(50));
    d = del.deriveDelivery(id);
    expect(d.ok && d.data.spans[0].cause).toBe('@codex1 quiet for 12 min (no output while working)');
    db.getDb().prepare('INSERT INTO events (type, entity_type, entity_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)').run('agent.resumed', 'agent', codex1.id, JSON.stringify({ name: 'codex1', quiet_minutes: 14 }), at(52));
    d = del.deriveDelivery(id);
    expect(d.ok && d.data.spans[0].cause).toBeNull();
    // the lane freezes: the build is done, the lane and SHA join the record
    const laneRec = del.addLanes(id, ['wc-codex1-bank-multi-konto']);
    expect(laneRec.ok).toBe(true);
    ev(60, 'pipeline.frozen', A, { sha: A, project: 'wavepulse', lane: 'wc-codex1-bank-multi-konto' });
    d = del.deriveDelivery(id);
    expect(stages(id)).toEqual(['build#1:ok@4fa5']);
    expect(d.ok && d.data.delivery.shas).toEqual([A]);
  });

  it('adoptWork: every running task and every lane ahead of main gets a record; pipeline review tasks, covered work and old lanes are skipped; a desk lane joins PD-<n>', () => {
    const codex1 = db.listAgents().find((a) => a.name === 'codex1')!;
    const pm = db.listAgents().find((a) => a.name === 'pm-denis')!;
    const bank = db.insertTask({ agent_id: codex1.id, prompt: '[you are @codex1 — builder]\nBank line: post to several konto rows.\nMore.', created_by: null });
    const review = db.insertTask({ agent_id: pm.id, prompt: 'Release freeze wavepulse @ e8092c0f (lane wc-x) — author @codex4', template: 'review', created_by: null });
    const pending = db.insertTask({ agent_id: null, prompt: 'Not started yet', created_by: null });
    if (!bank.ok || !review.ok || !pending.ok) return;
    db.getDb().prepare("UPDATE tasks SET status = 'running' WHERE id IN (?, ?)").run(bank.data.id, review.data.id);
    const running = (id: string) => db.getTask(id).ok ? (db.getTask(id) as { ok: true; data: never }).data : (null as never);
    const work = {
      tasks: [
        { task: running(bank.data.id), lane: 'wc-codex1-bank-multi-konto', project: 'wavepulse' },
        { task: running(review.data.id), lane: null, project: 'wavepulse' },
        { task: { ...running(pending.data.id), status: 'pending' as const }, lane: null, project: null },
      ],
      lanes: [
        { project: 'wavepulse', lane: 'wc-codex1-bank-multi-konto', author_agent_id: codex1.id, started_at: new Date(T0 - 40 * 60_000).toISOString() },
        { project: 'wavepulse', lane: 'wc-kimi2-pd164-cad-label', author_agent_id: null, started_at: new Date(T0 - 30 * 60_000).toISOString() },
        { project: 'wavepulse', lane: 'wc-codex8', author_agent_id: null, started_at: new Date(T0 - 10 * 60_000).toISOString() },
        { project: 'wavepulse', lane: 'wc-old-forgotten', author_agent_id: null, started_at: new Date(T0 - 20 * 24 * 3600_000).toISOString() },
        { project: 'wavepulse', lane: 'x', author_agent_id: null, started_at: null },
      ],
    };
    const first = del.adoptWork(work);
    expect(first.created).toHaveLength(3); // the bank task (lane joins it), PD-164, wc-codex8
    expect(first.joined).toEqual([]);
    const open = del.listDeliveries({ status: 'open' });
    const bankRec = open.find((d) => d.task_ids.includes(bank.data.id))!;
    expect(bankRec).toMatchObject({ title: 'Bank line: post to several konto rows.', project: 'wavepulse', lanes: ['wc-codex1-bank-multi-konto'], agent_ids: [codex1.id], stage: 'build', created_by: 'tracker' });
    expect(bankRec.since_at).toBe(new Date(`${running(bank.data.id).created_at.replace(' ', 'T')}Z`).toISOString()); // the task's creation (sqlite clock)
    expect(del.findOpenByDesk(164)).toMatchObject({ title: 'PD-164', lanes: ['wc-kimi2-pd164-cad-label'] });
    expect(open.find((d) => d.title === 'wc-codex8')).toMatchObject({ lanes: ['wc-codex8'], since_at: new Date(T0 - 10 * 60_000).toISOString() });
    expect(open.some((d) => d.task_ids.includes(review.data.id) || d.task_ids.includes(pending.data.id))).toBe(false);
    expect(open.some((d) => d.lanes.includes('wc-old-forgotten') || d.lanes.includes('x'))).toBe(false);
    // the second sweep adds nothing; a new task on a tracked lane joins that record
    expect(del.adoptWork(work)).toEqual({ created: [], joined: [] });
    // a record opened by hand with no agent learns the lane's author from the sweep
    const byHand = del.createDelivery({ title: 'By hand', lanes: ['wc-codex2-by-hand'], since: new Date(T0).toISOString(), created_by: 'denis' });
    if (!byHand.ok) return;
    expect(del.adoptWork({ tasks: [], lanes: [{ project: 'wavepulse', lane: 'wc-codex2-by-hand', author_agent_id: codex1.id, started_at: null }] })).toEqual({ created: [], joined: [`${byHand.data.id}:agent:${codex1.id}`] });
    expect(del.getDelivery(byHand.data.id)!.agent_ids).toEqual([codex1.id]);
    const fix = db.insertTask({ agent_id: codex1.id, prompt: 'Fix the review findings', created_by: null });
    if (!fix.ok) return;
    db.getDb().prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(fix.data.id);
    const again = del.adoptWork({ tasks: [{ task: running(fix.data.id), lane: 'wc-codex1-bank-multi-konto', project: 'wavepulse' }], lanes: [] });
    expect(again).toEqual({ created: [], joined: [`${bankRec.id}:task:${fix.data.id}`] });
    expect(del.getDelivery(bankRec.id)!.task_ids).toEqual([bank.data.id, fix.data.id]);
    cfg.deliveries = { notify: [], auto_track: false };
    expect(del.adoptWork({ tasks: [{ task: running(bank.data.id), lane: 'wc-new', project: null }], lanes: [{ project: null, lane: 'wc-another-lane', author_agent_id: null, started_at: null }] })).toEqual({ created: [], joined: [] });
  });

  it('auto_desk: false leaves freezes alone', () => {
    cfg.deliveries = { notify: [], auto_desk: false };
    expect(del.adoptDeskLanes([{ desk: 5, lane: 'wc-x-pd5-fix', project: null, created_at: at(0) }])).toEqual({ created: [], joined: [] });
    expect(del.findOpenByDesk(5)).toBeNull();
  });
});

describe('markedDesk', () => {
  it('reads the mark from the branch name or the note file name, never from prose, and refuses a disagreeing freeze desk', () => {
    expect(del.markedDesk({ desk: 162, lane: 'wc-codex7-pd162-reland' })).toBe(162);
    expect(del.markedDesk({ desk: null, lane: 'codex2/pd108-s1-fixes' })).toBe(108);
    expect(del.markedDesk({ desk: 138, lane: 'wc-claude5-desk138' })).toBe(138);
    expect(del.markedDesk({ desk: 91, lane: 'wc-x', freeze_path: '/home/wave/inbox/desk91-freeze-abcd1234.md' })).toBe(91);
    expect(del.markedDesk({ desk: 162, lane: 'wc-codex2-vasco-v2-a1', freeze_path: '/inbox/codex2-vasco-v2-a1-main-sync-freeze-ed15374e-20261028.md' })).toBeNull();
    expect(del.markedDesk({ desk: 99, lane: 'wc-codex7-pd162-reland' })).toBeNull();
    expect(del.markedDesk({ desk: null, lane: 'wc-claude5-upd1623' })).toBeNull();
  });
});
