import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent } from './db.js';
import * as db from './db.js';
import { emit } from './event-bus.js';
import { ensureReleaseFreezeTable } from './release-freezes.js';
import {
  loadFor,
  personStem,
  pickLeastLoaded,
  poolNamesFor,
  reviewerLoads,
  sameOwnerPoolReviewer,
  samePerson,
  selectReviewer,
  shouldReassign,
  vendorOf,
  assignmentFacts,
  reviewStatusForVerdict,
  type AssignInput,
  type ReviewerLoad,
} from './reviewer-assign.js';

function seat(name: string, extra: Partial<Agent> = {}): Agent {
  return {
    id: extra.id ?? name,
    name,
    runtime: extra.runtime ?? 'codex',
    tmux_session: `tmux-${name}`,
    workspace: null,
    mode: extra.mode ?? 'spawned',
    status: extra.status ?? 'idle',
    model: null,
    effort: null,
    profile: extra.profile ?? null,
    role: extra.role ?? null,
    alias: extra.alias ?? null,
    persona: null,
    created_at: '',
  };
}

function choose(
  author: Agent,
  agents: Agent[],
  extra: Partial<AssignInput> = {},
  loads: Record<string, Partial<ReviewerLoad>> = {},
): Agent | null {
  return selectReviewer({
    author,
    agents: [author, ...agents],
    deny: extra.deny ?? ['codex1', 'chatgpt-countix'],
    prefer: extra.prefer ?? {},
    pools: extra.pools ?? {},
    routeReviewers: extra.routeReviewers ?? [],
    routeTarget: extra.routeTarget ?? null,
    defaultReviewer: extra.defaultReviewer ?? null,
    autoPick: extra.autoPick ?? true,
    reviewTagIds: extra.reviewTagIds ?? new Set<string>(),
    minCapacityPct: extra.minCapacityPct,
    allow: extra.allow,
    serviceProfiles: extra.serviceProfiles,
    load: (agent) => ({
      busy: agent.status === 'working' || agent.status === 'error',
      openReviews: 0,
      runningTasks: 0,
      lastAssignedAt: 0,
      ...loads[agent.id],
    }),
  });
}

describe('reviewer identity', () => {
  it('reads a person stem from owner-first and runtime-first names', () => {
    expect(personStem('ales-claude1')).toBe('ales');
    expect(personStem('codex-antonio')).toBe('antonio');
    expect(personStem('claude-antonio')).toBe('antonio');
    expect(personStem('claude1')).toBeNull();
    expect(personStem('chatgpt-countix')).toBe('countix');
  });

  it('treats own seats as the same person and leaves bare seats apart', () => {
    expect(samePerson(seat('claude1', { runtime: 'claude-code' }), seat('claude1-codex'))).toBe(true);
    expect(samePerson(seat('codex-antonio'), seat('claude-antonio', { runtime: 'claude-code' }))).toBe(true);
    expect(samePerson(seat('ales-claude1', { runtime: 'claude-code' }), seat('ales-codex2'))).toBe(true);
    expect(samePerson(seat('ales-claude1', { runtime: 'claude-code' }), seat('claude1', { runtime: 'claude-code' }))).toBe(false);
    expect(samePerson(seat('a', { profile: 'ales' }), seat('b', { profile: 'ales' }))).toBe(true);
    expect(vendorOf('claude-code')).toBe('claude');
    expect(vendorOf('Codex')).toBe('codex');
    expect(poolNamesFor('ales-claude1', { 'ales-*': ['ales-codex1'] })).toEqual(new Set(['ales-codex1']));
  });
});

describe('selectReviewer', () => {
  const claude = seat('claude1', { runtime: 'claude-code' });
  const codexAuthor = seat('codex2', { runtime: 'codex' });

  it('never picks a denied name, the author, or the author\'s own seats', () => {
    const picked = choose(claude, [
      seat('codex1'),
      seat('chatgpt-countix', { runtime: 'chatgpt' }),
      seat('claude1-codex'),
      seat('codex3'),
    ], { prefer: { claude: ['codex1', 'chatgpt-countix', 'claude1-codex', 'claude1', 'codex3'] } });
    expect(picked?.name).toBe('codex3');
  });

  it('keeps codex-antonio off claude-antonio\'s own work', () => {
    const antonio = seat('codex-antonio');
    const picked = choose(antonio, [
      seat('claude-antonio', { runtime: 'claude-code' }),
      seat('claude2', { runtime: 'claude-code' }),
    ], { prefer: { codex: ['claude-antonio', 'claude2'] } });
    expect(picked?.name).toBe('claude2');
  });

  it('uses a pooled same-person seat only after every independent reviewer', () => {
    const ales = seat('ales-claude1', { runtime: 'claude-code' });
    const pools = { 'ales-*': ['ales-codex1'] };
    const withIndependent = choose(ales, [
      seat('ales-codex1'),
      seat('ales-codex2'),
      seat('codex3'),
    ], { prefer: {}, pools, autoPick: true });
    expect(withIndependent?.name).toBe('codex3');

    const preferredIndependent = choose(ales, [
      seat('ales-codex1'),
      seat('codex3'),
    ], { prefer: { claude: ['ales-codex1', 'codex3'] }, pools, autoPick: true });
    expect(preferredIndependent?.name).toBe('codex3');

    const onlyOwn = choose(ales, [
      seat('ales-codex1'),
      seat('ales-codex2'),
    ], { prefer: { claude: ['codex3'] }, pools, autoPick: true });
    expect(onlyOwn?.name).toBe('ales-codex1');
    expect(sameOwnerPoolReviewer(ales, seat('ales-codex1'), pools)).toBe(true);
    expect(sameOwnerPoolReviewer(ales, seat('codex3'), { 'ales-*': ['ales-codex1', 'codex3'] })).toBe(false);
    expect(sameOwnerPoolReviewer(ales, seat('ales-codex2'), pools)).toBe(false);
  });

  it('does not let the pool waive a deny list or the author', () => {
    const ales = seat('ales-claude1', { runtime: 'claude-code' });
    const picked = choose(ales, [seat('codex1'), seat('codex3')], {
      pools: { 'ales-*': ['codex1', 'ales-claude1'] },
      defaultReviewer: 'codex3',
      autoPick: false,
    });
    expect(picked?.name).toBe('codex3');

    const self = seat('ales-codex1');
    const notSelf = choose(self, [seat('codex3')], {
      pools: { 'ales-*': ['ales-codex1'] },
      defaultReviewer: 'codex3',
      autoPick: false,
    });
    expect(notSelf?.name).toBe('codex3');
  });

  it('prefers codex2/codex3 for Claude-authored work over an idle ladder seat', () => {
    const picked = choose(claude, [
      seat('claude2', { runtime: 'claude-code' }),
      seat('codex2', { status: 'working' }),
      seat('codex3'),
    ], { prefer: { claude: ['codex2', 'codex3'] }, routeTarget: 'claude2', routeReviewers: ['claude2'] });
    expect(picked?.name).toBe('codex3');
  });

  it('prefers claude1/claude2 for Codex-authored work', () => {
    const picked = choose(codexAuthor, [
      seat('codex3'),
      seat('claude1', { runtime: 'claude-code', status: 'working' }),
      seat('claude2', { runtime: 'claude-code' }),
    ], { prefer: { codex: ['claude1', 'claude2'] } });
    expect(picked?.name).toBe('claude2');
  });

  it('uses the route, then the default, when no prefer tier is configured', () => {
    const author = seat('ales');
    const routed = choose(author, [seat('codex2'), seat('codex3'), seat('fable')], {
      routeTarget: 'codex2',
      routeReviewers: ['codex2'],
      defaultReviewer: 'codex3',
    });
    expect(routed?.name).toBe('codex2');

    const fallback = choose(author, [seat('codex1'), seat('codex3'), seat('fable')], {
      routeTarget: 'codex1',
      routeReviewers: ['codex1'],
      defaultReviewer: 'codex3',
    });
    expect(fallback?.name).toBe('codex3');
  });

  it('picks the least loaded seat inside the winning tier', () => {
    const agents = [
      seat('codex2'),
      seat('codex3'),
      seat('claude2', { runtime: 'claude-code' }),
    ];
    const prefer = { claude: ['codex2', 'codex3'] };
    const idleBeatsBusy = choose(claude, agents, { prefer }, { codex2: { busy: true }, codex3: { busy: false, openReviews: 4 } });
    expect(idleBeatsBusy?.name).toBe('codex3');

    const fewerReviews = choose(claude, agents, { prefer }, { codex2: { openReviews: 2 }, codex3: { openReviews: 1 } });
    expect(fewerReviews?.name).toBe('codex3');

    const fewerTasks = choose(claude, agents, { prefer }, { codex2: { runningTasks: 3 }, codex3: { runningTasks: 1 } });
    expect(fewerTasks?.name).toBe('codex3');

    const olderAssignment = choose(claude, agents, { prefer }, {
      codex2: { lastAssignedAt: 0 },
      codex3: { lastAssignedAt: 5_000 },
    });
    expect(olderAssignment?.name).toBe('codex2');
  });

  it('breaks a full tie by name', () => {
    const picked = pickLeastLoaded(
      [seat('codex3'), seat('codex2')],
      () => ({ busy: false, openReviews: 0, runningTasks: 0, lastAssignedAt: 0 }),
    );
    expect(picked?.name).toBe('codex2');
    expect(pickLeastLoaded([], () => ({ busy: false, openReviews: 0, runningTasks: 0, lastAssignedAt: 0 }))).toBeNull();
  });
});

describe('reviewStatusForVerdict', () => {
  it('maps the exact-SHA verdict and leaves a missing verdict pending', () => {
    expect(reviewStatusForVerdict('pass')).toBe('approved');
    expect(reviewStatusForVerdict('needs-fixes')).toBe('rejected');
    expect(reviewStatusForVerdict('reject')).toBe('rejected');
    expect(reviewStatusForVerdict(null)).toBe('pending');
    expect(reviewStatusForVerdict(undefined)).toBe('pending');
  });
});

describe('shouldReassign', () => {
  const base = {
    hasVerdict: false,
    waitedMs: 16 * 60 * 1000,
    limitMs: 15 * 60 * 1000,
    currentBusy: true,
    reassignCount: 0,
    nextId: 'codex2',
    currentId: 'codex3',
    nextIdle: false,
  };

  it('moves once off a busy seat, then only when the next seat is idle', () => {
    expect(shouldReassign(base)).toBe(true);
    expect(shouldReassign({ ...base, reassignCount: 1, nextIdle: false })).toBe(false);
    expect(shouldReassign({ ...base, reassignCount: 1, nextIdle: true })).toBe(true);
    expect(shouldReassign({ ...base, hasVerdict: true })).toBe(false);
    expect(shouldReassign({ ...base, currentBusy: false })).toBe(false);
    expect(shouldReassign({ ...base, waitedMs: 14 * 60 * 1000 })).toBe(false);
    expect(shouldReassign({ ...base, limitMs: 0 })).toBe(false);
    expect(shouldReassign({ ...base, nextId: 'codex3' })).toBe(false);
    expect(shouldReassign({ ...base, nextId: null })).toBe(false);
  });
});

describe('live reviewer load', () => {
  let tmp: string;

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('counts open reviews, running tasks, and the pane status', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-rev-'));
    db.initDb(path.join(tmp, 't.db'));
    ensureReleaseFreezeTable();
    const busy = db.insertAgent({
      name: 'codex2', runtime: 'codex', tmux_session: 'tmux-codex2', workspace: null, mode: 'spawned', status: 'working',
    });
    const idle = db.insertAgent({
      name: 'codex3', runtime: 'codex', tmux_session: 'tmux-codex3', workspace: null, mode: 'spawned', status: 'idle',
    });
    const broken = db.insertAgent({
      name: 'claude2', runtime: 'claude-code', tmux_session: 'tmux-claude2', workspace: null, mode: 'spawned', status: 'error',
    });
    const fileSeat = db.insertAgent({
      name: 'notes', runtime: 'codex', tmux_session: 'tmux-notes', workspace: null, mode: 'file', status: 'idle',
    });
    const pm = db.insertAgent({
      name: 'pm', runtime: 'codex', tmux_session: 'tmux-pm', workspace: null, mode: 'spawned', status: 'working', role: 'orchestrator',
    });
    if (!busy.ok || !idle.ok || !broken.ok || !fileSeat.ok || !pm.ok) throw new Error('seed');
    const task = db.insertTask({ agent_id: busy.data.id, prompt: 'work' });
    if (!task.ok) throw new Error(task.error);
    db.updateTaskStatus(task.data.id, 'running');
    const sha = 'a'.repeat(40);
    db.getDb().prepare(
      `INSERT INTO release_freezes (sha, reviewer_agent_id, verdict, status) VALUES (?, ?, NULL, 'open')`,
    ).run(sha, busy.data.id);
    db.getDb().prepare(
      `INSERT INTO release_freezes (sha, reviewer_agent_id, verdict, status) VALUES (?, ?, 'pass', 'open')`,
    ).run(`${'b'.repeat(40)}`, busy.data.id);
    emit('pipeline.review', 'run', `${sha}:assign`, {
      sha, reviewer_id: busy.data.id, assigned_at_ms: 1_700_000_000_000, reassigned: false,
    }, null);
    emit('pipeline.review', 'run', `${sha}:reassign`, {
      sha, reviewer_id: idle.data.id, assigned_at_ms: 1_700_000_100_000, reassigned: true,
    }, null);
    const taskForRun = db.insertTask({ agent_id: busy.data.id, prompt: 'reviewed' });
    if (!taskForRun.ok) throw new Error(taskForRun.error);
    const run = db.insertRun({ task_id: taskForRun.data.id, agent_id: busy.data.id });
    if (!run.ok) throw new Error(run.error);
    db.finishRun(run.data.id, 0);
    const decided = 'c'.repeat(40);
    db.getDb().prepare(
      `INSERT INTO release_freezes (sha, run_id, reviewer_agent_id, verdict, status) VALUES (?, ?, ?, NULL, 'open')`,
    ).run(decided, run.data.id, busy.data.id);
    db.getDb().prepare(
      `INSERT INTO code_reviews (id, run_id, reviewer_type, reviewer_agent_id, status, verdict)
       VALUES ('rv-decided', ?, 'cross-model', ?, 'done', 'pass')`,
    ).run(run.data.id, busy.data.id);
    const stored = db.getRun(run.data.id);
    if (!stored.ok) throw new Error(stored.error);
    expect(stored.data.review_status).toBe('pending');

    expect(loadFor(busy.data)).toMatchObject({ busy: true, openReviews: 1, runningTasks: 1, lastAssignedAt: 1_700_000_000_000 });
    expect(loadFor(idle.data).busy).toBe(false);
    expect(loadFor(broken.data).busy).toBe(true);
    expect(assignmentFacts(sha)).toEqual({ at: 1_700_000_100_000, reviewerId: idle.data.id, reassigns: 1 });

    const loads = reviewerLoads();
    expect(loads.map((row) => row.name)).toEqual(['codex2', 'claude2', 'codex3']);
    expect(loads.find((row) => row.name === 'codex2')).toMatchObject({ busy: true, queue: 1 });
    expect(loads.find((row) => row.name === 'codex3')).toMatchObject({ busy: false, queue: 0 });
  });
});

describe('capacity, allowlist and service profiles', () => {
  const claude = seat('claude1', { runtime: 'claude-code' });

  it('skips a seat whose plan is below the floor; an unprobed seat stays eligible', () => {
    const codex2 = seat('codex2');
    const codex3 = seat('codex3');
    expect(choose(claude, [codex2, codex3], { prefer: { claude: ['codex2', 'codex3'] } }, { codex2: { leftPct: 4 } })?.name).toBe('codex3');
    expect(choose(claude, [codex2, codex3], { prefer: { claude: ['codex2', 'codex3'] } }, { codex2: { leftPct: null } })?.name).toBe('codex2');
    expect(choose(claude, [codex2], { prefer: { claude: ['codex2'] } }, { codex2: { leftPct: 9 } })).toBeNull();
    expect(choose(claude, [codex2], { prefer: { claude: ['codex2'] }, minCapacityPct: 5 }, { codex2: { leftPct: 9 } })?.name).toBe('codex2');
  });

  it('limits the open ladder to reviewer_allow but keeps prefer tiers and pools', () => {
    const codex4 = seat('codex4');
    const alesCodex = seat('ales-codex2');
    expect(choose(claude, [codex4, alesCodex], { allow: ['codex4'] })?.name).toBe('codex4');
    expect(choose(claude, [alesCodex], { allow: ['codex4'] })).toBeNull();
    expect(choose(claude, [alesCodex], { allow: ['codex4'], prefer: { claude: ['ales-codex2'] } })?.name).toBe('ales-codex2');
  });

  it('treats seats on a service profile as independent of each other', () => {
    const author = seat('claude3', { runtime: 'claude-code', profile: 'denis20x' });
    const codex4 = seat('codex4', { profile: 'denis20x' });
    expect(samePerson(author, codex4)).toBe(true);
    expect(samePerson(author, codex4, ['denis20x'])).toBe(false);
    expect(samePerson(seat('ales-claude1', { profile: 'ales' }), seat('ales-codex2', { profile: 'ales' }), ['denis20x'])).toBe(true);
    expect(choose(author, [codex4], { prefer: { claude: ['codex4'] } })).toBeNull();
    expect(choose(author, [codex4], { prefer: { claude: ['codex4'] }, serviceProfiles: ['denis20x'] })?.name).toBe('codex4');
    expect(sameOwnerPoolReviewer(author, codex4, { 'claude*': ['codex4'] })).toBe(true);
    expect(sameOwnerPoolReviewer(author, codex4, { 'claude*': ['codex4'] }, ['denis20x'])).toBe(false);
  });
});
