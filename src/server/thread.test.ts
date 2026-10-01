/**
 * GET /api/thread mapping (spec §4.1): every kind, needs_attention, and
 * per-viewer action gating — against a real SQLite file.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from './db.js';
import { reserveAgent } from './leases.js';
import { readThread, toThreadItem, ThreadContext, type ThreadItem } from './thread.js';
import { createUser, OWNER_USER } from './users.js';

describe('thread.ts', () => {
  let tmpDir: string;
  let ana: db.User;
  let bob: db.User;
  let watcher: db.User;
  let seat: db.Agent;   // owned by ana
  let free: db.Agent;   // free

  function user(name: string, role: db.UserRole): db.User {
    const r = createUser({ name, role });
    if (!r.ok) throw new Error(r.error);
    return r.data.user;
  }

  function agent(name: string): db.Agent {
    const r = db.insertAgent({ name, runtime: 'claude-code', tmux_session: `wc-${name}`, workspace: null, mode: 'spawned', status: 'idle' });
    if (!r.ok) throw new Error(r.error);
    return r.data;
  }

  function ev(type: string, entityType: string, entityId: string, payload: Record<string, unknown> = {}, actor: string | null = null): db.WaveEvent {
    const r = db.insertEvent({ type, entity_type: entityType, entity_id: entityId, payload, actor_id: actor });
    if (!r.ok) throw new Error(r.error);
    return r.data;
  }

  function item(event: db.WaveEvent, viewer: Pick<db.User, 'id' | 'name' | 'role'> = ana): ThreadItem {
    const mapped = toThreadItem(event, new ThreadContext(viewer));
    if (!mapped) throw new Error(`event ${event.type} did not map`);
    return mapped;
  }

  const actionIds = (i: ThreadItem) => i.actions.map((a) => a.id);

  function makeRun(agentId: string): db.Run {
    const t = db.insertTask({ prompt: 'build it', created_by: ana.id });
    if (!t.ok) throw new Error(t.error);
    const r = db.insertRun({ task_id: t.data.id, agent_id: agentId });
    if (!r.ok) throw new Error(r.error);
    return r.data;
  }

  function message(msg: Partial<db.AgentMessage> & { message: string }): db.AgentMessage {
    const r = db.insertAgentMessage({
      from_agent_id: msg.from_agent_id ?? undefined,
      to_agent_id: msg.to_agent_id ?? undefined,
      message: msg.message,
      message_type: msg.message_type,
      ref_task_id: msg.ref_task_id ?? undefined,
    });
    if (!r.ok) throw new Error(r.error);
    return r.data;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-thread-'));
    db.resetDbForTest();
    db.initDb(path.join(tmpDir, 'test.db'));
    ana = user('ana', 'developer');
    bob = user('bob', 'developer');
    watcher = user('watcher', 'observer');
    seat = agent('grok-fe');
    free = agent('codex-rev');
    reserveAgent(seat.id, ana);
  });

  afterEach(() => {
    db.resetDbForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('kind mapping', () => {
    it('prompt ← agent.prompt_sent', () => {
      const i = item(ev('agent.prompt_sent', 'agent', seat.id, { text: 'start T1' }, ana.id));
      expect(i).toMatchObject({ kind: 'prompt', agent_id: seat.id, actor_id: ana.id, body: 'start T1', needs_attention: false, actions: [] });
    });

    it('report ← message.created (result/info), with reply for whoever may act', () => {
      const msg = message({ from_agent_id: seat.id, message: 'auth middleware done, 14 tests', message_type: 'result', ref_task_id: 't-1' });
      const e = ev('message.created', 'agent_message', msg.id, { from_agent_id: seat.id, message_type: 'result' });
      const i = item(e);
      expect(i).toMatchObject({
        kind: 'report', agent_id: seat.id, title: 'Report (result)', body: 'auth middleware done, 14 tests',
        needs_attention: false, refs: { message_id: msg.id, task_id: 't-1' },
      });
      expect(i.actions).toEqual([{
        id: 'reply', label: 'Reply', method: 'POST', path: '/api/messages',
        body: { to: seat.id, message: '{text}', message_type: 'info', ref_task_id: 't-1' },
      }]);
      expect(actionIds(item(e, bob))).toEqual([]); // bob may not type into ana's agent
    });

    it('a human reply (no from_agent_id) is a report about its recipient', () => {
      const msg = message({ to_agent_id: free.id, message: 'use wavecode.db' });
      const i = item(ev('message.created', 'agent_message', msg.id, { to_agent_id: free.id, message_type: 'info' }, bob.id));
      expect(i).toMatchObject({ kind: 'report', title: 'Reply', agent_id: free.id, actor_id: bob.id });
    });

    it('request ← message type request (needs attention; reply + send file)', () => {
      const msg = message({ from_agent_id: seat.id, message: 'which DB file for tokens?', message_type: 'request' });
      const i = item(ev('message.created', 'agent_message', msg.id, { from_agent_id: seat.id, message_type: 'request' }));
      expect(i).toMatchObject({ kind: 'request', needs_attention: true, body: 'which DB file for tokens?' });
      expect(actionIds(i)).toEqual(['reply', 'send_file']);
      expect(i.actions[1]).toMatchObject({ path: '/api/artifacts/{artifact_id}/share', body: { target_agent_id: seat.id } });
    });

    it('request ← idle agent whose last output line is a question; other status changes are not in the feed', () => {
      const asks = item(ev('agent.status_changed', 'agent', free.id, { status: 'idle', lastOutputLine: 'Proceed with the migration? ' }));
      expect(asks).toMatchObject({ kind: 'request', needs_attention: true, body: 'Proceed with the migration? ' });

      const ctx = new ThreadContext(ana);
      expect(toThreadItem(ev('agent.status_changed', 'agent', free.id, { status: 'idle', lastOutputLine: 'Done.' }), ctx)).toBeNull();
      expect(toThreadItem(ev('agent.status_changed', 'agent', free.id, { status: 'working', lastOutputLine: 'ok?' }), ctx)).toBeNull();
    });

    it('run ← run.started / finished / failed / phase(incomplete); failed needs attention', () => {
      const run = makeRun(free.id);
      const started = item(ev('run.started', 'run', run.id, { task_id: run.task_id, agent_id: free.id }));
      expect(started).toMatchObject({ kind: 'run', title: 'Run started', needs_attention: false, refs: { run_id: run.id, task_id: run.task_id } });
      expect(actionIds(started)).toEqual(['open_log']);

      const finished = item(ev('run.finished', 'run', run.id, { agent_id: free.id, exit_code: 0, result: 'PASS' }));
      expect(finished).toMatchObject({ title: 'Run finished · exit 0 · RESULT: PASS', needs_attention: false });
      expect(actionIds(finished)).toEqual(['open_log', 'retry', 'hand_off']);

      const failed = item(ev('run.failed', 'run', run.id, { agent_id: free.id, exit_code: 1, result: 'FAIL', result_reason: '2 tests red' }));
      expect(failed).toMatchObject({ title: 'Run failed · RESULT: FAIL', body: '2 tests red', needs_attention: true });

      const incomplete = item(ev('run.phase', 'run', run.id, { phase: 'incomplete', agent_id: free.id, reason: 'no RESULT' }));
      expect(incomplete).toMatchObject({ kind: 'run', title: 'Run incomplete', needs_attention: true });
      expect(toThreadItem(ev('run.phase', 'run', run.id, { phase: 'running' }), new ThreadContext(ana))).toBeNull();
    });

    it('verdict ← review.ai_completed; agent is the run author', () => {
      const run = makeRun(seat.id);
      const pass = item(ev('review.ai_completed', 'run', run.id, { review_id: 'rv-1', verdict: 'pass', issues_found: 0, fix_round: 0 }));
      expect(pass).toMatchObject({ kind: 'verdict', agent_id: seat.id, title: 'PASS', needs_attention: false, refs: { run_id: run.id, review_id: 'rv-1' } });
      expect(actionIds(pass)).toEqual(['promote', 'reject']);

      const fixes = item(ev('review.ai_completed', 'run', run.id, { review_id: 'rv-2', verdict: 'needs-fixes', issues_found: 2, fix_round: 1 }));
      expect(fixes).toMatchObject({ title: 'NEEDS FIXES (2 issues)', body: 'Fix round 1', needs_attention: true });
      expect(actionIds(fixes)).toEqual(['send_fixes', 'reject']); // ana: no override (not admin)
    });

    it('task ← task.created/dispatched/completed/blocked/waiting_for_agent/failed', () => {
      const created = item(ev('task.created', 'task', 't1', { prompt: 'build auth', agent_id: null }));
      expect(created).toMatchObject({ kind: 'task', title: 'Task created', body: 'build auth', needs_attention: false, actions: [] });
      expect(item(ev('task.dispatched', 'task', 't1', { agent_id: free.id, agent_name: 'codex-rev' }))).toMatchObject({ title: 'Task dispatched', agent_id: free.id });
      expect(item(ev('task.completed', 'task', 't1', { agent_id: free.id, run_id: 'r1' }))).toMatchObject({ title: 'Task completed', refs: { task_id: 't1', run_id: 'r1' } });

      const blocked = item(ev('task.blocked', 'task', 't2', { blocked_by: 't1' }));
      expect(blocked).toMatchObject({ needs_attention: true });
      expect(actionIds(blocked)).toEqual(['reassign']);

      const waiting = ev('task.waiting_for_agent', 'task', 't3', { agent_id: seat.id, agent_name: 'grok-fe', owner: 'ana', owner_id: ana.id });
      expect(item(waiting, bob)).toMatchObject({ title: 'Task waiting for grok-fe (owned by ana)', needs_attention: true });
      expect(actionIds(item(waiting, bob))).toEqual(['reassign']);
      expect(actionIds(item(waiting, ana))).toEqual(['reassign', 'release_agent']);

      expect(item(ev('task.failed', 'task', 't4', { error: 'runtime not running' }))).toMatchObject({ body: 'runtime not running', needs_attention: false });
    });

    it('alert ← crashed/hung/lease_expired/runtime_relaunched/stop_all and error messages', () => {
      for (const type of ['agent.crashed', 'agent.hung', 'agent.runtime_relaunched']) {
        const i = item(ev(type, 'agent', free.id, { stale_minutes: 12 }));
        expect(i).toMatchObject({ kind: 'alert', agent_id: free.id, needs_attention: true });
        expect(actionIds(i)).toEqual(['restart', 'kill']);
      }
      expect(item(ev('agent.hung', 'agent', free.id, { stale_minutes: 12 })).title).toBe('Agent appears hung (12m silent)');
      expect(actionIds(item(ev('agent.lease_expired', 'agent', free.id, { owner: 'ana' })))).toEqual(['kill']);
      expect(item(ev('system.stop_all', 'system', 'stop-all', { killed: 2 }))).toMatchObject({ kind: 'alert', agent_id: null, actions: [] });

      const err = message({ from_agent_id: free.id, message: 'npm install failed', message_type: 'error' });
      expect(item(ev('message.created', 'agent_message', err.id, { from_agent_id: free.id, message_type: 'error' })))
        .toMatchObject({ kind: 'alert', needs_attention: true, body: 'npm install failed' });
    });

    it('artifact ← artifact.created / artifact.shared', () => {
      const created = item(ev('artifact.created', 'artifact', 'art-1', { filename: 'mock.png', source_agent_id: free.id }));
      expect(created).toMatchObject({ kind: 'artifact', title: 'File added: mock.png', agent_id: free.id, needs_attention: false, refs: { artifact_id: 'art-1' } });
      expect(actionIds(created)).toEqual(['open', 'forward']);
      const shared = item(ev('artifact.shared', 'artifact', 'art-1', { filename: 'mock.png', target_agent_id: seat.id, attached_path: '/ws/mock.png' }));
      expect(shared).toMatchObject({ title: 'File shared: mock.png', agent_id: seat.id, body: '/ws/mock.png' });
    });

    it('unrelated events are not in the feed', () => {
      const ctx = new ThreadContext(ana);
      for (const type of ['heartbeat', 'agent.updated', 'review.ai_started', 'queue.empty', 'user.created']) {
        expect(toThreadItem(ev(type, 'agent', free.id), ctx)).toBeNull();
      }
    });
  });

  describe('action gating (server-side, per viewer)', () => {
    it('observers get only read actions', () => {
      const run = makeRun(free.id);
      const failed = item(ev('run.failed', 'run', run.id, { agent_id: free.id }), watcher);
      expect(actionIds(failed)).toEqual(['open_log']);
      const verdict = item(ev('review.ai_completed', 'run', run.id, { review_id: 'rv', verdict: 'reject' }), watcher);
      expect(verdict.actions).toEqual([]);
      const art = item(ev('artifact.created', 'artifact', 'a', { filename: 'f' }), watcher);
      expect(actionIds(art)).toEqual(['open']);
      expect(item(ev('agent.crashed', 'agent', free.id), watcher).actions).toEqual([]);
    });

    it('non-owners cannot retry, send fixes, restart or kill on someone else\'s agent', () => {
      const run = makeRun(seat.id);
      expect(actionIds(item(ev('run.failed', 'run', run.id, { agent_id: seat.id }), bob))).toEqual(['open_log', 'hand_off']);
      expect(actionIds(item(ev('review.ai_completed', 'run', run.id, { review_id: 'rv', verdict: 'needs-fixes' }), bob))).toEqual(['reject']);
      expect(item(ev('agent.crashed', 'agent', seat.id), bob).actions).toEqual([]);
      expect(actionIds(item(ev('agent.crashed', 'agent', seat.id), ana))).toEqual(['restart', 'kill']);
    });

    it('admins get override-promote on a non-pass verdict and act on any agent', () => {
      const run = makeRun(seat.id);
      const i = item(ev('review.ai_completed', 'run', run.id, { review_id: 'rv', verdict: 'needs-fixes' }), OWNER_USER);
      expect(actionIds(i)).toEqual(['override_promote', 'send_fixes', 'reject']);
      expect(i.actions[0]).toMatchObject({ method: 'POST', path: `/api/reviews/${run.id}/promote`, body: { overrideReason: '{reason}' } });
    });
  });

  describe('readThread paging and filters', () => {
    beforeEach(() => {
      ev('agent.prompt_sent', 'agent', seat.id, { text: 'one' }, ana.id);
      ev('heartbeat', 'run', 'r');                                   // not in feed
      ev('agent.crashed', 'agent', free.id);
      ev('agent.prompt_sent', 'agent', free.id, { text: 'two' }, bob.id);
      ev('task.blocked', 'task', 't9', {});
    });

    it('initial load returns the newest items oldest→newest with the latest cursor', () => {
      const page = readThread({ limit: 2 }, ana);
      expect(page.items.map((i) => i.title)).toEqual(['Prompt sent', 'Task blocked']);
      expect(page.cursor).toBe(db.getLatestEventId());
    });

    it('since=cursor returns only newer items; cursor advances past non-feed events', () => {
      const first = readThread({ since: 0, limit: 1 }, ana);
      expect(first.items.map((i) => i.body)).toEqual(['one']);
      const next = readThread({ since: first.cursor, limit: 10 }, ana);
      expect(next.items.map((i) => i.kind)).toEqual(['alert', 'prompt', 'task']);
      const empty = readThread({ since: next.cursor }, ana);
      expect(empty).toEqual({ items: [], cursor: next.cursor });

      ev('heartbeat', 'run', 'r');
      expect(readThread({ since: next.cursor }, ana).cursor).toBeGreaterThan(next.cursor);
    });

    it('filters by agent, kinds, attention and owner', () => {
      expect(readThread({ agentId: free.id }, ana).items.map((i) => i.kind)).toEqual(['alert', 'prompt']);
      expect(readThread({ agentId: 'all', kinds: ['prompt'] }, ana).items).toHaveLength(2);
      expect(readThread({ attentionOnly: true }, ana).items.map((i) => i.kind)).toEqual(['alert', 'task']);
      // owner: items on agents ana owns, plus items ana caused
      expect(readThread({ ownerId: ana.id }, ana).items.map((i) => i.body)).toEqual(['one']);
      expect(readThread({ ownerId: bob.id }, ana).items.map((i) => i.body)).toEqual(['two']);
    });
  });
});
