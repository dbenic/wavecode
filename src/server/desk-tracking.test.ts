import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import * as db from './db.js';
import { ensureReviewTable } from './code-review.js';
import { deskIdsIn, deskSlice, linksFromIndex, loadDeskWork, trackOpenDesks } from './desk-tracking.js';
import { ensureReleaseFreezeTable } from './release-freezes.js';
import { ensureReleaseTables } from './releases.js';

const SHA = '2431f684b9e960b84e73a4e98b5068869664ffb4';
const NOW = Date.parse('2026-10-13T00:00:00Z');

describe('desk tracking', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-desk-track-'));
    db.initDb(path.join(tmp, 't.db'));
    ensureReleaseFreezeTable();
    ensureReleaseTables();
    ensureReviewTable();
  });

  afterEach(() => {
    db.resetDbForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function agent(name: string) {
    const made = db.insertAgent({ name, runtime: 'codex', tmux_session: `wc-${name}`, mode: 'spawned', status: 'idle' });
    if (!made.ok) throw new Error(made.error);
    return made.data;
  }

  function task(agentId: string, prompt: string) {
    const made = db.insertTask({ agent_id: agentId, prompt, created_by: null });
    if (!made.ok) throw new Error(made.error);
    return made.data;
  }

  function runFor(agentId: string, taskId: string) {
    const made = db.insertRun({ task_id: taskId, agent_id: agentId });
    if (!made.ok) throw new Error(made.error);
    return made.data.id;
  }

  function freeze(fields: { sha?: string; runId?: string | null; lane?: string | null; desk?: number | null; status?: string; verdict?: string | null; authorId?: string | null; author?: string | null; note?: string | null }) {
    const sha = fields.sha ?? SHA;
    let notePath: string | null = null;
    if (fields.note) {
      notePath = path.join(tmp, `${sha.slice(0, 8)}.md`);
      fs.writeFileSync(notePath, fields.note);
    }
    db.getDb().prepare(
      `INSERT INTO release_freezes (
         sha, run_id, project, lane, desk, author_agent_id, author_name, verdict, status, freeze_path, created_at, updated_at
       ) VALUES (?, ?, 'wave', ?, ?, ?, ?, ?, ?, ?, '2026-10-01 00:00:00', '2026-10-01 00:00:00')`,
    ).run(sha, fields.runId ?? null, fields.lane ?? null, fields.desk ?? null, fields.authorId ?? null, fields.author ?? null, fields.verdict ?? null, fields.status ?? 'open', notePath);
  }

  it('reads Desk #N and a desk84-s6 branch', () => {
    expect(deskIdsIn('See Desk #84 and PD-108 plus [desk 12]')).toEqual(expect.arrayContaining([84, 108, 12]));
    expect(deskIdsIn('claude1/desk84-s6-year-end')).toEqual([84]);
    expect(deskSlice('claude1/desk84-s6-year-end', 84)).toBe('s6');
    expect(deskSlice('Desk #84 whole request', 84)).toBeNull();
  });

  it('a run, a review, and a freeze inherit the desk number from the task', () => {
    const seat = agent('claude2');
    const made = task(seat.id, 'Desk #84 settle the year');
    const runId = runFor(seat.id, made.id);
    db.finishRun(runId, 0);
    db.getDb().prepare(
      `INSERT INTO code_reviews (id, run_id, reviewer_type, status, verdict) VALUES ('cr1', ?, 'cross-model', 'done', 'pass')`,
    ).run(runId);
    freeze({ runId, lane: 'wc-claude2', authorId: seat.id, author: 'claude2', verdict: 'pass' });

    const links = linksFromIndex(loadDeskWork(), 84);
    expect(links.tasks.map((row) => row.id)).toEqual([made.id]);
    expect(links.runs.map((row) => row.id)).toEqual([runId]);
    expect(links.reviews).toEqual([{ run_id: runId, status: 'done', verdict: 'pass' }]);
    expect(links.lanes.map((row) => row.sha)).toEqual([SHA]);
  });

  it('a freeze note and a desk84-s6 branch name link a freeze that has no desk column', () => {
    freeze({ lane: 'claude1/desk84-s6-year-end', sha: SHA });
    const other = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    freeze({ sha: other, note: '# Freeze\n\nDesk #91 only.\n' });
    const work = loadDeskWork();
    expect(linksFromIndex(work, 84).lanes.map((row) => row.sha)).toEqual([SHA]);
    expect(linksFromIndex(work, 91).lanes.map((row) => row.sha)).toEqual([other]);
  });

  it('flags idle work, two builders without a split, unreviewed work, and live work still implementing', () => {
    const a = agent('claude2');
    const b = agent('codex2');
    const stalled = task(a.id, 'Desk #84 still open');
    db.getDb().prepare(`UPDATE tasks SET created_at = '2026-10-01 00:00:00' WHERE id = ?`).run(stalled.id);
    const sharedA = task(a.id, '[desk 70] whole card');
    const sharedB = task(b.id, '[desk 70] whole card');
    const splitA = task(a.id, 'desk71-s1 first slice');
    const splitB = task(b.id, 'desk71-s2 second slice');
    const quiet = task(a.id, 'Desk #55 done, waiting on review');
    const runId = runFor(a.id, quiet.id);
    db.finishRun(runId, 0);
    db.getDb().prepare(`UPDATE runs SET finished_at = '2026-10-01 00:00:00', review_status = 'pending' WHERE id = ?`).run(runId);
    const liveTask = task(a.id, 'Desk #30 shipped');
    db.getDb().prepare(`UPDATE tasks SET status = 'done', created_at = '2026-10-12 00:00:00' WHERE id = ?`).run(liveTask.id);
    const liveRun = runFor(a.id, liveTask.id);
    db.finishRun(liveRun, 0);
    db.getDb().prepare(`UPDATE runs SET review_status = 'approved', finished_at = '2026-10-12 00:00:00' WHERE id = ?`).run(liveRun);
    freeze({ sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', runId: liveRun, status: 'merged', verdict: 'pass', authorId: a.id, author: 'claude2' });

    const work = loadDeskWork();
    const agents = [
      { id: a.id, name: 'claude2', status: 'idle', for_min: 24 * 60 + 10 },
      { id: b.id, name: 'codex2', status: 'idle', for_min: 30 },
    ];
    const rows = trackOpenDesks([
      { id: 84, status: 'implementing', title: 'year end', updated_at: null },
      { id: 70, status: 'implementing', title: 'shared', updated_at: null },
      { id: 71, status: 'implementing', title: 'split', updated_at: null },
      { id: 55, status: 'in_review', title: 'quiet', updated_at: null },
      { id: 30, status: 'implementing', title: 'live', updated_at: null },
    ], work, agents, NOW);

    const flags = (id: number) => rows.find((row) => row.id === id)?.flags ?? [];
    expect(flags(84)).toContain('idle_24h');
    expect(flags(84)).not.toContain('two_builders');
    expect(flags(70)).toContain('two_builders');
    expect(rows.find((row) => row.id === 70)?.note).toMatch(/without a split/);
    expect(rows.find((row) => row.id === 70)?.builders.sort()).toEqual(['claude2', 'codex2']);
    expect(flags(71)).not.toContain('two_builders');
    expect(flags(55)).toContain('unreviewed');
    expect(flags(55)).not.toContain('suggest_close');
    expect(flags(30)).toContain('suggest_close');
    expect(flags(30)).not.toContain('unreviewed');
    void sharedA; void sharedB; void splitA; void splitB;
  });
});
