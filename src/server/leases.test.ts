/**
 * Agent leases (multi-orchestrator spec §2) against a real SQLite file.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from './db.js';
import * as leases from './leases.js';
import { createUser } from './users.js';

describe('leases.ts', () => {
  let tmpDir: string;
  let ana: db.User;
  let bob: db.User;
  let boss: db.User;

  function makeAgent(name: string, status: db.Agent['status'] = 'idle'): db.Agent {
    const r = db.insertAgent({ name, runtime: 'claude-code', tmux_session: `wc-${name}`, workspace: null, mode: 'adopted', status });
    if (!r.ok) throw new Error(r.error);
    return r.data;
  }

  function user(name: string, role: db.UserRole): db.User {
    const r = createUser({ name, role });
    if (!r.ok) throw new Error(r.error);
    return r.data.user;
  }

  function fresh(id: string): db.Agent {
    const r = db.getAgent(id);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  }

  function eventsOf(type: string) {
    return db.listEvents().filter((e) => e.type === type).map((e) => ({ ...e, payload: JSON.parse(e.payload_json ?? 'null') }));
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-leases-'));
    db.resetDbForTest();
    db.initDb(path.join(tmpDir, 'test.db'));
    ana = user('ana', 'developer');
    bob = user('bob', 'developer');
    boss = user('boss', 'admin');
  });

  afterEach(() => {
    db.resetDbForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('reserve / release', () => {
    it('reserves a free agent for the default 4h and emits agent.reserved', () => {
      const agent = makeAgent('grok-fe');
      const before = Date.now();
      const r = leases.reserveAgent(agent.id, ana);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.owner_id).toBe(ana.id);
      expect(r.data.lease_reason).toBe('reserved');
      const until = Date.parse(r.data.lease_expires_at!);
      expect(until - before).toBeGreaterThanOrEqual(4 * 3_600_000 - 1000);
      expect(until - before).toBeLessThanOrEqual(4 * 3_600_000 + 1000);
      expect(eventsOf('agent.reserved')[0].payload).toMatchObject({ owner: 'ana', reason: 'reserved' });
    });

    it('validates hours: (0, 24]', () => {
      const agent = makeAgent('a1');
      expect(leases.reserveAgent(agent.id, ana, 0)).toMatchObject({ ok: false, code: 'invalid' });
      expect(leases.reserveAgent(agent.id, ana, 25)).toMatchObject({ ok: false, code: 'invalid' });
      expect(leases.reserveAgent(agent.id, ana, '2')).toMatchObject({ ok: false, code: 'invalid' });
      expect(leases.reserveAgent(agent.id, ana, 24).ok).toBe(true);
    });

    it('returns 409 (conflict) when reserving an agent someone else owns; re-reserving your own extends it', () => {
      const agent = makeAgent('a1');
      leases.reserveAgent(agent.id, ana, 1);
      const conflict = leases.reserveAgent(agent.id, bob);
      expect(conflict).toMatchObject({ ok: false, code: 'conflict' });
      expect(!conflict.ok && conflict.error).toContain('ana');
      expect(leases.leaseErrorStatus('conflict')).toBe(409);

      const extended = leases.reserveAgent(agent.id, ana, 8);
      expect(extended.ok && Date.parse(extended.data.lease_expires_at!) - Date.now()).toBeGreaterThan(7 * 3_600_000);
    });

    it('only the owner or an admin may release', () => {
      const agent = makeAgent('a1');
      leases.reserveAgent(agent.id, ana);
      expect(leases.releaseAgent(agent.id, bob)).toMatchObject({ ok: false, code: 'forbidden' });
      expect(fresh(agent.id).owner_id).toBe(ana.id);

      expect(leases.releaseAgent(agent.id, boss).ok).toBe(true);
      expect(fresh(agent.id).owner_id).toBeNull();
      expect(eventsOf('agent.released')[0].payload).toMatchObject({ by: 'boss', owner: 'ana', reason: 'force_released' });

      leases.reserveAgent(agent.id, ana);
      expect(leases.releaseAgent(agent.id, ana).ok).toBe(true);
      expect(fresh(agent.id)).toMatchObject({ owner_id: null, lease_reason: null, lease_expires_at: null });
    });

    it('unknown agents are not_found', () => {
      expect(leases.reserveAgent('nope', ana)).toMatchObject({ ok: false, code: 'not_found' });
      expect(leases.releaseAgent('nope', ana)).toMatchObject({ ok: false, code: 'not_found' });
    });
  });

  describe('rule 2 — checkAgentAccess', () => {
    it('allows free agents, the owner, and admins; denies others with the owner name', () => {
      const agent = makeAgent('grok-fe');
      expect(leases.checkAgentAccess(fresh(agent.id), bob).ok).toBe(true);

      leases.reserveAgent(agent.id, ana);
      const owned = fresh(agent.id);
      expect(leases.checkAgentAccess(owned, ana).ok).toBe(true);
      expect(leases.checkAgentAccess(owned, boss).ok).toBe(true);
      expect(leases.checkAgentAccess(owned, { id: 'owner', role: 'admin' }).ok).toBe(true);
      expect(leases.checkAgentAccess(owned, bob)).toEqual({
        ok: false, code: 'forbidden', error: 'Agent grok-fe is owned by ana',
      });
    });
  });

  describe('rules 3 + 6 — dispatcher helpers', () => {
    function task(createdBy: string | null, agentId: string | null = null): db.Task {
      const r = db.insertTask({ prompt: 'x', agent_id: agentId, created_by: createdBy });
      if (!r.ok) throw new Error(r.error);
      return r.data;
    }

    it('canDispatchTaskToAgent: free agent, or owned by the creator, or admin-assigned', () => {
      const agent = makeAgent('a1');
      expect(leases.canDispatchTaskToAgent(task(bob.id), fresh(agent.id))).toBe(true);
      expect(leases.canDispatchTaskToAgent(task(null), fresh(agent.id))).toBe(true);

      leases.reserveAgent(agent.id, ana);
      const owned = fresh(agent.id);
      expect(leases.canDispatchTaskToAgent(task(ana.id), owned)).toBe(true);
      expect(leases.canDispatchTaskToAgent(task(bob.id), owned)).toBe(false);
      expect(leases.canDispatchTaskToAgent(task(bob.id, agent.id), owned)).toBe(false);
      expect(leases.canDispatchTaskToAgent(task(null), owned)).toBe(false);
      expect(leases.canDispatchTaskToAgent(task(boss.id, agent.id), owned)).toBe(true);
      expect(leases.canDispatchTaskToAgent(task(boss.id), owned)).toBe(false);
    });

    it('autoLeaseForTask leases a free agent to the task creator (reason task, no expiry)', () => {
      const agent = makeAgent('a1');
      expect(leases.autoLeaseForTask(fresh(agent.id), task(ana.id))).toBe(true);
      expect(fresh(agent.id)).toMatchObject({ owner_id: ana.id, lease_reason: 'task', lease_expires_at: null });

      // Already owned → untouched; creatorless tasks never lease
      expect(leases.autoLeaseForTask(fresh(agent.id), task(bob.id))).toBe(false);
      const other = makeAgent('a2');
      expect(leases.autoLeaseForTask(fresh(other.id), task(null))).toBe(false);
    });

    it('maybeReleaseTaskLease releases idle task leases but keeps reservations and busy agents', () => {
      const agent = makeAgent('a1', 'working');
      leases.autoLeaseForTask(fresh(agent.id), task(ana.id));
      expect(leases.maybeReleaseTaskLease(agent.id)).toBe(false); // working

      db.updateAgentStatus(agent.id, 'idle');
      expect(leases.maybeReleaseTaskLease(agent.id)).toBe(true);
      expect(fresh(agent.id).owner_id).toBeNull();
      expect(eventsOf('agent.released').at(-1)?.payload).toMatchObject({ reason: 'task_complete', owner: 'ana' });

      leases.reserveAgent(agent.id, ana);
      expect(leases.maybeReleaseTaskLease(agent.id)).toBe(false);
      expect(fresh(agent.id).owner_id).toBe(ana.id);
    });
  });

  describe('rule 5 — sweepLeases', () => {
    function expire(agentId: string) {
      db.getDb().prepare('UPDATE agents SET lease_expires_at = ? WHERE id = ?')
        .run(new Date(Date.now() - 1000).toISOString(), agentId);
    }

    it('releases expired reservations on idle agents and emits agent.lease_expired', () => {
      const agent = makeAgent('idle-one');
      leases.reserveAgent(agent.id, ana, 1);
      expire(agent.id);
      expect(leases.sweepLeases()).toEqual([agent.id]);
      expect(fresh(agent.id).owner_id).toBeNull();
      const ev = db.listEvents().find((e) => e.type === 'agent.lease_expired');
      expect(ev?.actor_id).toBeNull();
      expect(JSON.parse(ev!.payload_json!)).toMatchObject({ owner: 'ana' });
    });

    it('never yanks a working agent or one with an open run; keeps unexpired leases', () => {
      const working = makeAgent('working-one', 'working');
      leases.reserveAgent(working.id, ana, 1);
      expire(working.id);

      const running = makeAgent('running-one');
      leases.reserveAgent(running.id, ana, 1);
      expire(running.id);
      const t = db.insertTask({ prompt: 'x', created_by: ana.id });
      if (!t.ok) throw new Error(t.error);
      db.insertRun({ task_id: t.data.id, agent_id: running.id });

      const fresh1 = makeAgent('fresh-one');
      leases.reserveAgent(fresh1.id, ana, 1);

      expect(leases.sweepLeases()).toEqual([]);
      expect(fresh(working.id).owner_id).toBe(ana.id);
      expect(fresh(running.id).owner_id).toBe(ana.id);
      expect(fresh(fresh1.id).owner_id).toBe(ana.id);

      // Once the working agent goes idle, the next tick releases it
      db.updateAgentStatus(working.id, 'idle');
      expect(leases.sweepLeases()).toEqual([working.id]);
    });

    it('also clears task leases left on idle agents', () => {
      const agent = makeAgent('a1');
      const t = db.insertTask({ prompt: 'x', created_by: ana.id });
      if (!t.ok) throw new Error(t.error);
      leases.autoLeaseForTask(fresh(agent.id), t.data);
      expect(leases.sweepLeases()).toEqual([agent.id]);
    });
  });

  it('releaseLeasesOf clears every lease of a revoked user', () => {
    const a1 = makeAgent('a1');
    const a2 = makeAgent('a2');
    leases.reserveAgent(a1.id, ana);
    leases.reserveAgent(a2.id, bob);
    expect(leases.releaseLeasesOf(ana.id)).toBe(1);
    expect(fresh(a1.id).owner_id).toBeNull();
    expect(fresh(a2.id).owner_id).toBe(bob.id);
  });

  it('insertTask records the in-flight request actor as created_by', async () => {
    const { runWithActor } = await import('./request-context.js');
    const t = await runWithActor(ana.id, async () => db.insertTask({ prompt: 'x' }));
    expect(t.ok && t.data.created_by).toBe(ana.id);
    const sys = db.insertTask({ prompt: 'y' });
    expect(sys.ok && sys.data.created_by).toBeNull();
  });
});
