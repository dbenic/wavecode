/**
 * Load-aware reviewer choice.
 *
 * The fixed author→reviewer map is one source of eligible names, not the
 * first pick. Eligible people come from that map and the reviewer ladder.
 * Hard exclusions: `review_deny` / `agent_deny`, the author, and the author's
 * other seats (same profile, or the same person stem — `ales-claude1` with
 * `ales-codex2`, `codex-antonio` with `claude-antonio`, `claude1` with
 * `claude1-codex`). A name listed in `reviewer_pool_by_author_glob` may still
 * review that author (`ales-*` may use `ales-codex1`).
 *
 * Tiers, first non-empty wins: the preferred independent seats, then any
 * other independent eligible reviewer (route, default, tagged, then the
 * rest), and only then a same-person seat named in `reviewer_pool_by_author_glob`.
 * A same-person seat is never chosen unless that pool names it. Inside a
 * tier, least loaded: pane idle before busy, then fewer open reviews, then
 * fewer running tasks, then least recent assignment.
 */

import { getConfig } from './config.js';
import { getDb, listAgents, type Agent } from './db.js';

/** Lowercased `review_deny` and `agent_deny` across every project. */
export function deniedReviewerHandles(): Set<string> {
  const deny = new Set<string>();
  try {
    for (const project of Object.values(getConfig().projects ?? {})) {
      const pipe = project.pipeline;
      for (const name of [...(pipe?.review_deny ?? []), ...(pipe?.agent_deny ?? [])]) {
        const handle = name.trim().toLowerCase();
        if (handle) deny.add(handle);
      }
    }
  } catch { /* config not loaded */ }
  return deny;
}

export function reviewerDenied(agent: { name: string; alias?: string | null }): boolean {
  const deny = deniedReviewerHandles();
  if (deny.size === 0) return false;
  if (deny.has(agent.name.toLowerCase())) return true;
  return !!agent.alias && deny.has(agent.alias.toLowerCase());
}

export const SAME_OWNER_POOL_NOTE = 'same-owner reviewer via pool';

export interface ReviewerLoad {
  busy: boolean;
  openReviews: number;
  runningTasks: number;
  /** Epoch ms of the last assignment. 0 means never assigned. */
  lastAssignedAt: number;
}

export interface ReviewerLoadView {
  id: string;
  name: string;
  alias: string | null;
  busy: boolean;
  queue: number;
}

const RUNTIME_WORD = '(?:claude|codex|chatgpt|aider|opus|grok)';

/** Person token in `ales-claude1` or `codex-antonio`. A bare `claude1` has none. */
export function personStem(name: string): string | null {
  const n = name.toLowerCase();
  const ownerFirst = n.match(new RegExp(`^([a-z0-9]+)[-_]${RUNTIME_WORD}`));
  if (ownerFirst && !new RegExp(`^${RUNTIME_WORD}$`).test(ownerFirst[1])) return ownerFirst[1];
  const runtimeFirst = n.match(new RegExp(`^${RUNTIME_WORD}[-_]([a-z0-9]+)$`));
  if (runtimeFirst) return runtimeFirst[1];
  return null;
}

function identityKeys(agent: { name: string; alias?: string | null; profile?: string | null }): Set<string> {
  const keys = new Set<string>();
  const add = (raw: string | null | undefined) => {
    if (!raw) return;
    const n = raw.toLowerCase();
    keys.add(`n:${n}`);
    const stem = personStem(n);
    if (stem) {
      keys.add(`p:${stem}`);
      keys.add(`n:${stem}`);
    }
  };
  add(agent.name);
  add(agent.alias);
  if (agent.profile) keys.add(`profile:${agent.profile.toLowerCase()}`);
  return keys;
}

/** True when two seats belong to the same person, including the seat itself. */
export function samePerson(
  a: { name: string; alias?: string | null; profile?: string | null },
  b: { name: string; alias?: string | null; profile?: string | null },
): boolean {
  const left = identityKeys(a);
  for (const key of identityKeys(b)) if (left.has(key)) return true;
  return false;
}

/** `claude-code` and `Claude` share the prefer key `claude`. */
export function vendorOf(runtime: string): string {
  const r = runtime.toLowerCase();
  if (r.startsWith('claude')) return 'claude';
  if (r.startsWith('codex')) return 'codex';
  if (r.startsWith('chatgpt')) return 'chatgpt';
  const head = r.split(/[^a-z0-9]/)[0];
  return head || r;
}

function globToRe(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
}

export function poolNamesFor(authorName: string, pools: Record<string, string[]>): Set<string> {
  const names = new Set<string>();
  for (const [glob, reviewers] of Object.entries(pools)) {
    let ok = false;
    try { ok = globToRe(glob).test(authorName); } catch { ok = false; }
    if (!ok) continue;
    for (const name of reviewers) names.add(name.toLowerCase());
  }
  return names;
}

function handles(agent: { name: string; alias?: string | null }): string[] {
  return [agent.name, agent.alias].filter((s): s is string => !!s).map((s) => s.toLowerCase());
}

export interface AssignInput {
  author: Agent;
  agents: Agent[];
  /** Lowercased `review_deny` plus `agent_deny`. */
  deny: string[];
  prefer: Record<string, string[]>;
  pools: Record<string, string[]>;
  /** Reviewer names the project routes name (the bench), plus this author's target. */
  routeReviewers: string[];
  /** This author's mapped reviewer, if the map has one. */
  routeTarget: string | null;
  defaultReviewer: string | null;
  autoPick: boolean;
  reviewTagIds: Set<string>;
  load: (agent: Agent) => ReviewerLoad;
}

function listed(agent: Agent, names: Set<string>): boolean {
  return handles(agent).some((h) => names.has(h));
}

/**
 * One reviewer, or null when every candidate is excluded.
 * The route target is not chosen ahead of a non-empty prefer tier.
 */
export function selectReviewer(input: AssignInput): Agent | null {
  const deny = new Set(input.deny.map((s) => s.toLowerCase()));
  const pool = poolNamesFor(input.author.name, input.pools);
  if (input.author.alias) {
    for (const name of poolNamesFor(input.author.alias, input.pools)) pool.add(name);
  }
  const routeNames = new Set(input.routeReviewers.map((s) => s.toLowerCase()));
  if (input.routeTarget) routeNames.add(input.routeTarget.toLowerCase());
  const preferKey = vendorOf(input.author.runtime);
  const prefer = new Set(
    (input.prefer[preferKey] ?? Object.entries(input.prefer).find(([key]) => key.toLowerCase() === preferKey)?.[1] ?? [])
      .map((s) => s.toLowerCase()),
  );
  const wanted = input.defaultReviewer?.toLowerCase() ?? '';

  const excluded = (agent: Agent): boolean => {
    if (agent.id === input.author.id) return true;
    if (handles(agent).some((h) => handles(input.author).includes(h))) return true;
    if (handles(agent).some((h) => deny.has(h))) return true;
    if (samePerson(input.author, agent) && !listed(agent, pool)) return true;
    return false;
  };
  const isDefault = (agent: Agent): boolean =>
    !!wanted && (handles(agent).includes(wanted) || agent.runtime.toLowerCase() === wanted);
  // The open ladder (anyone, then the tagged subset) needs auto-pick.
  // A configured default is eligible even when auto-pick is off.
  const fromLadder = (agent: Agent): boolean => input.autoPick || isDefault(agent);

  const eligible = input.agents.filter((agent) => {
    if (agent.mode === 'file' || agent.role === 'orchestrator') return false;
    if (excluded(agent)) return false;
    return fromLadder(agent) || listed(agent, routeNames) || listed(agent, prefer) || listed(agent, pool);
  });

  const independent = (agent: Agent): boolean => !samePerson(input.author, agent);
  const routeTarget = input.routeTarget?.toLowerCase() ?? '';
  const tiers = [
    eligible.filter((agent) => independent(agent) && listed(agent, prefer)),
    eligible.filter((agent) => independent(agent) && !!routeTarget && listed(agent, new Set([routeTarget]))),
    eligible.filter((agent) => independent(agent) && isDefault(agent)),
    eligible.filter((agent) => independent(agent) && input.reviewTagIds.has(agent.id)),
    eligible.filter(independent),
    eligible.filter((agent) => samePerson(input.author, agent) && listed(agent, pool)),
  ];
  const best = tiers.find((tier) => tier.length > 0) ?? [];
  return pickLeastLoaded(best, input.load);
}

/** A pooled same-person seat. Independent names in the pool are not this case. */
export function sameOwnerPoolReviewer(
  author: { name: string; alias?: string | null; profile?: string | null },
  reviewer: { name: string; alias?: string | null; profile?: string | null },
  pools: Record<string, string[]>,
): boolean {
  if (!samePerson(author, reviewer)) return false;
  const pool = poolNamesFor(author.name, pools);
  if (author.alias) {
    for (const name of poolNamesFor(author.alias, pools)) pool.add(name);
  }
  return handles(reviewer).some((handle) => pool.has(handle));
}

export function pickLeastLoaded(agents: Agent[], load: (agent: Agent) => ReviewerLoad): Agent | null {
  if (agents.length === 0) return null;
  return [...agents].sort((a, b) => {
    const left = load(a);
    const right = load(b);
    if (left.busy !== right.busy) return left.busy ? 1 : -1;
    if (left.openReviews !== right.openReviews) return left.openReviews - right.openReviews;
    if (left.runningTasks !== right.runningTasks) return left.runningTasks - right.runningTasks;
    if (left.lastAssignedAt !== right.lastAssignedAt) return left.lastAssignedAt - right.lastAssignedAt;
    return a.name.localeCompare(b.name);
  })[0];
}

export function shouldReassign(opts: {
  hasVerdict: boolean;
  waitedMs: number;
  limitMs: number;
  currentBusy: boolean;
  reassignCount: number;
  nextId: string | null;
  currentId: string;
  nextIdle: boolean;
}): boolean {
  if (opts.hasVerdict || !opts.currentBusy) return false;
  if (!(opts.limitMs > 0) || opts.waitedMs < opts.limitMs) return false;
  if (!opts.nextId || opts.nextId === opts.currentId) return false;
  if (opts.reassignCount >= 1 && !opts.nextIdle) return false;
  return true;
}

/**
 * The run column `review_status` stays `pending` after a verdict is written.
 * The verdict on the exact SHA is the source: pass approves, needs-fixes and
 * reject reject, and no verdict stays pending. Queue depth uses this, not the column.
 */
export function reviewStatusForVerdict(verdict: string | null | undefined): 'pending' | 'approved' | 'rejected' {
  if (verdict === 'pass') return 'approved';
  if (verdict === 'needs-fixes' || verdict === 'reject') return 'rejected';
  return 'pending';
}

export function loadFor(agent: Agent): ReviewerLoad {
  return {
    busy: agent.status === 'working' || agent.status === 'error',
    openReviews: openReviews(agent.id),
    runningTasks: runningTasks(agent.id),
    lastAssignedAt: lastAssignedAt(agent.id),
  };
}

/**
 * Open reviews for this seat. Pending means no reviewer verdict on the exact
 * SHA: the freeze verdict, else the latest done code review on that run.
 * `runs.review_status` is not read — it stays pending after a verdict.
 */
function openReviews(agentId: string): number {
  try {
    const row = getDb().prepare(
      `SELECT COUNT(*) AS n FROM release_freezes f
       WHERE f.reviewer_agent_id = ?
         AND f.status IN ('open', 'behind-main')
         AND COALESCE(
           f.verdict,
           (
             SELECT c.verdict FROM code_reviews c
             WHERE c.run_id = f.run_id AND c.status = 'done' AND c.verdict IS NOT NULL
             ORDER BY c.created_at DESC, c.rowid DESC LIMIT 1
           )
         ) IS NULL`,
    ).get(agentId) as { n: number };
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

function runningTasks(agentId: string): number {
  try {
    const row = getDb().prepare(
      `SELECT COUNT(*) AS n FROM tasks WHERE agent_id = ? AND status = 'running'`,
    ).get(agentId) as { n: number };
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

interface ReviewEvent {
  sha: string;
  reviewerId: string;
  at: number;
  reassigned: boolean;
}

function reviewEvents(): ReviewEvent[] {
  try {
    const rows = getDb().prepare(
      `SELECT entity_id, payload_json, created_at FROM events WHERE type = 'pipeline.review' ORDER BY id ASC`,
    ).all() as { entity_id: string; payload_json: string | null; created_at: string }[];
    const out: ReviewEvent[] = [];
    for (const row of rows) {
      let payload: { sha?: string; reviewer_id?: string; assigned_at_ms?: number; reassigned?: boolean } = {};
      try { payload = row.payload_json ? JSON.parse(row.payload_json) : {}; } catch { payload = {}; }
      const sha = payload.sha || row.entity_id.split(':')[0];
      if (!sha || !payload.reviewer_id) continue;
      const at = typeof payload.assigned_at_ms === 'number'
        ? payload.assigned_at_ms
        : Date.parse(row.created_at.includes('T') ? row.created_at : `${row.created_at.replace(' ', 'T')}Z`);
      out.push({
        sha,
        reviewerId: payload.reviewer_id,
        at: Number.isFinite(at) ? at : 0,
        reassigned: payload.reassigned === true,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function assignmentFacts(sha: string): { at: number; reviewerId: string; reassigns: number } | null {
  const rows = reviewEvents().filter((row) => row.sha === sha);
  if (rows.length === 0) return null;
  const last = rows[rows.length - 1];
  return { at: last.at, reviewerId: last.reviewerId, reassigns: rows.filter((row) => row.reassigned).length };
}

function lastAssignedAt(agentId: string): number {
  let latest = 0;
  for (const row of reviewEvents()) {
    if (row.reviewerId === agentId && row.at > latest) latest = row.at;
  }
  return latest;
}

/** Seats the Reviews header lists: queue depth and whether the pane is busy. */
export function reviewerLoads(): ReviewerLoadView[] {
  let agents: Agent[] = [];
  try { agents = listAgents(); } catch { agents = []; }
  return agents
    .filter((agent) => agent.mode !== 'file' && agent.role !== 'orchestrator' && !reviewerDenied(agent))
    .map((agent) => {
      const load = loadFor(agent);
      return { id: agent.id, name: agent.name, alias: agent.alias ?? null, busy: load.busy, queue: load.openReviews };
    })
    .sort((a, b) => b.queue - a.queue || a.name.localeCompare(b.name));
}

export function projectReassignMs(project: string | null): number {
  const raw = project ? getConfig().projects?.[project]?.pipeline?.review_reassign_minutes : undefined;
  const minutes = typeof raw === 'number' && Number.isFinite(raw) ? raw : 15;
  return Math.max(0, minutes) * 60 * 1000;
}
