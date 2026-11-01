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
 * Tiers, first non-empty wins: idle reviewer seats (`agents.role = 'reviewer'`,
 * other profile and other vendor than the author first, then other profile,
 * then any), the preferred independent seats, then any other independent
 * eligible reviewer (route, default, tagged, then the rest), and only then a
 * same-person seat named in `reviewer_pool_by_author_glob`. A same-person
 * seat is never chosen unless that pool names it. Inside a tier, least
 * loaded: pane idle before busy, then fewer open reviews, then fewer running
 * tasks, then least recent assignment.
 *
 * Never chosen (`reviewerExclusion`, one list for the picker and for a seat the
 * author names): a seat out of rotation (`seatOutOfRotation`: on an API key,
 * logged out, or plan under the capacity floor), a silent seat
 * (`silentReviewers`: its last three assigned reviews went unanswered, until
 * the silence expires), and a seat that already held the review being moved.
 */

import { getConfig } from './config.js';
import { getDb, listAgents, type Agent } from './db.js';
import { seatOut } from './seat-credentials.js';
import { usageFor } from './usage-probe.js';

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
  /** Plan capacity left on the seat's profile (the smaller of the 5-hour and weekly windows). Null when never probed. */
  leftPct?: number | null;
}

/** Default floor for `review.min_capacity_pct`. */
export const DEFAULT_MIN_CAPACITY_PCT = 10;

/**
 * Capacity left on the seat's plan, from the usage probe: the smallest
 * `left_pct` over the 5-hour and weekly windows. Context-window and credit
 * rows are not capacity. Null when the profile was never probed.
 */
export function capacityLeftPct(agent: { runtime: string; profile?: string | null }): number | null {
  let usage: ReturnType<typeof usageFor> = null;
  try { usage = usageFor(agent.runtime, agent.profile ?? null); } catch { usage = null; }
  if (!usage) return null;
  const values = usage.metrics
    .filter((m) => m.label === '5h' || m.label === 'weekly' || m.label === 'weekly-model')
    .map((m) => m.left_pct)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return values.length ? Math.min(...values) : null;
}

export function minCapacityPct(): number {
  try {
    const pct = getConfig().review?.min_capacity_pct;
    return typeof pct === 'number' && Number.isFinite(pct) ? pct : DEFAULT_MIN_CAPACITY_PCT;
  } catch {
    return DEFAULT_MIN_CAPACITY_PCT;
  }
}

/** True when the seat's plan is below the floor. An unprobed profile is not excluded. */
export function belowCapacity(load: Pick<ReviewerLoad, 'leftPct'>, floor: number): boolean {
  return typeof load.leftPct === 'number' && load.leftPct < floor;
}

/**
 * Why a seat is out of the reviewer rotation, or null when it may review:
 * the seat-credentials rule every surface uses (`seatOut`: runs on an API
 * key, logged out, plan under the dispatch floor), then the review's own
 * capacity floor (`review.min_capacity_pct`: the review would stall at the
 * usage-limit screen).
 */
export function seatOutOfRotation(agent: Pick<Agent, 'id' | 'runtime' | 'profile'>, load: Pick<ReviewerLoad, 'leftPct'>, floor: number): string | null {
  let out: ReturnType<typeof seatOut> = null;
  try { out = seatOut(agent); } catch { out = null; } // config not loaded (tests, embedded use)
  if (out) return out.reason === 'key' ? `runs on an API key (${out.detail})` : out.reason === 'login' ? `logged out (${out.detail})` : out.detail;
  if (belowCapacity(load, floor)) return `plan at ${load.leftPct}% (floor ${floor}%)`;
  return null;
}

/** A seat whose last reviews this many in a row went unanswered is skipped by the picker. */
export const SILENT_REVIEW_STREAK = 3;
/** Silence lasts this many windows past the newest unanswered one, at most `SILENCE_MAX_MS`; then the seat is tried again. */
export const SILENCE_WINDOWS = 6;
export const SILENCE_MAX_MS = 2 * 60 * 60 * 1000;

export interface SilentSeat {
  /** Unanswered reviews in a row, newest first (counting stops at the streak). */
  streak: number;
  /** Epoch ms when the newest counted review's window ran out. */
  since: number;
  /** Epoch ms when the seat is eligible again, unless it answers earlier. */
  until: number;
}

/** What the silence rule reads besides the review events; one read per pass. */
export interface SilenceFacts {
  /** `sha:reviewerId` for every verdict a seat wrote on a SHA, whenever it came. */
  answered: Set<string>;
  /** Status and project of every freeze, by SHA. */
  freezes: Map<string, { status: string; project: string | null }>;
}

export function silenceFacts(): SilenceFacts {
  const answered = new Set<string>();
  const freezes = new Map<string, { status: string; project: string | null }>();
  try {
    const rows = getDb().prepare('SELECT sha, reviewer_agent_id FROM freeze_verdicts WHERE reviewer_agent_id IS NOT NULL')
      .all() as { sha: string; reviewer_agent_id: string }[];
    for (const row of rows) answered.add(`${row.sha}:${row.reviewer_agent_id}`);
  } catch { /* table not there yet */ }
  try {
    const rows = getDb().prepare('SELECT sha, status, project, reviewer_agent_id, verdict FROM release_freezes')
      .all() as { sha: string; status: string; project: string | null; reviewer_agent_id: string | null; verdict: string | null }[];
    for (const row of rows) {
      freezes.set(row.sha, { status: row.status, project: row.project });
      if (row.verdict && row.reviewer_agent_id) answered.add(`${row.sha}:${row.reviewer_agent_id}`);
    }
  } catch { /* table not there yet */ }
  return { answered, freezes };
}

/**
 * Seats silent on their reviews, with when the silence started and when it ends.
 *
 * A review (one `pipeline.review` assignment of a SHA to a seat, newest per SHA)
 * is **answered** when the seat wrote any verdict on that SHA, late or not. It is
 * **unanswered** when the seat wrote none and either the freeze is still open
 * (`open` / `behind-main`) with the window run out, or the review was moved away
 * from the seat. A review still inside its window, or on a freeze that closed
 * before the seat answered (superseded, promoted, rejected), is neither and is
 * skipped. The window is the review's own project's `review_reassign_minutes`
 * (`limit` as a function of the project; a number applies to all; 0 turns the
 * rule off; a freeze with no project is skipped).
 *
 * Newest first, the first answered review ends the streak. `SILENT_REVIEW_STREAK`
 * unanswered in a row make the seat silent until `SILENCE_WINDOWS` windows past
 * the newest one (at most `SILENCE_MAX_MS`): a silent seat gets no review, so
 * without that expiry nothing could ever end its streak.
 */
export function silentReviewers(
  events: ReviewEvent[] = reviewEvents(),
  limit: number | ((project: string | null) => number) = projectReassignMs,
  now = Date.now(),
  facts: SilenceFacts = silenceFacts(),
): Map<string, SilentSeat> {
  const silent = new Map<string, SilentSeat>();
  if (events.length === 0) return silent;
  const limitFor = (project: string | null): number => (typeof limit === 'number' ? limit : project ? limit(project) : 0);
  const holder = new Map<string, string>(); // sha → the seat holding the review now (latest assignment wins)
  const bySeat = new Map<string, ReviewEvent[]>();
  for (const row of [...events].sort((a, b) => a.at - b.at)) { // by assignment time; a stable sort keeps the event order on ties
    holder.set(row.sha, row.reviewerId);
    const list = bySeat.get(row.reviewerId) ?? [];
    list.push(row);
    bySeat.set(row.reviewerId, list);
  }
  for (const [seat, rows] of bySeat) {
    const seen = new Set<string>();
    let streak = 0;
    let since = 0;
    let until = 0;
    for (let i = rows.length - 1; i >= 0 && streak < SILENT_REVIEW_STREAK; i--) {
      const row = rows[i];
      if (seen.has(row.sha)) continue;
      seen.add(row.sha);
      const freeze = facts.freezes.get(row.sha);
      const limitMs = limitFor(freeze?.project ?? null);
      if (!(limitMs > 0)) continue; // the rule is off for this review's project
      if (facts.answered.has(`${row.sha}:${seat}`)) break; // any verdict is an answer
      if (holder.get(row.sha) === seat) {
        const open = freeze?.status === 'open' || freeze?.status === 'behind-main';
        if (!open) continue; // closed before the seat answered: not its silence
        if (now - row.at < limitMs) continue; // still inside the window
      }
      streak += 1;
      if (streak === 1) {
        since = Math.min(row.at + limitMs, now);
        until = row.at + limitMs + Math.min(SILENCE_WINDOWS * limitMs, SILENCE_MAX_MS);
      }
    }
    if (streak >= SILENT_REVIEW_STREAK && now < until) silent.set(seat, { streak, since, until });
  }
  return silent;
}

/** The ids from `silentReviewers`. */
export function silentReviewerIds(
  events: ReviewEvent[] = reviewEvents(),
  limit: number | ((project: string | null) => number) = projectReassignMs,
  now = Date.now(),
  facts: SilenceFacts = silenceFacts(),
): Set<string> {
  return new Set(silentReviewers(events, limit, now, facts).keys());
}

/** Seats that held this SHA's review at some point (the review events have the history). */
export function pastHolders(sha: string, events: ReviewEvent[]): Set<string> {
  const out = new Set<string>();
  for (const row of events) if (row.sha === sha) out.add(row.reviewerId);
  return out;
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

function identityKeys(agent: { name: string; alias?: string | null; profile?: string | null }, serviceProfiles?: ReadonlySet<string>): Set<string> {
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
  // A service pool profile (`pipeline.service_profiles`) is not a person: codex4 and claude3 on
  // the same shared login are independent seats.
  if (agent.profile && !serviceProfiles?.has(agent.profile.toLowerCase())) keys.add(`profile:${agent.profile.toLowerCase()}`);
  return keys;
}

/** True when two seats belong to the same person, including the seat itself. */
export function samePerson(
  a: { name: string; alias?: string | null; profile?: string | null },
  b: { name: string; alias?: string | null; profile?: string | null },
  serviceProfiles?: Iterable<string>,
): boolean {
  const shared = serviceProfiles ? new Set([...serviceProfiles].map((p) => p.toLowerCase())) : undefined;
  const left = identityKeys(a, shared);
  for (const key of identityKeys(b, shared)) if (left.has(key)) return true;
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
  /** Seats below this plan capacity are excluded. Default `DEFAULT_MIN_CAPACITY_PCT`. */
  minCapacityPct?: number;
  /** When non-empty, the open ladder is limited to these handles (prefer tiers and pools stay eligible). */
  allow?: string[];
  /** Profiles whose seats are independent of each other (`pipeline.service_profiles`). */
  serviceProfiles?: string[];
  /** Agent ids the picker skips because their last reviews went unanswered (`silentReviewerIds`). */
  silent?: ReadonlySet<string>;
  /** Agent ids that already held this review (`pastHolders`): a moved review never goes back to one. */
  exclude?: ReadonlySet<string>;
}

function listed(agent: Agent, names: Set<string>): boolean {
  return handles(agent).some((h) => names.has(h));
}

function poolFor(input: Pick<AssignInput, 'author' | 'pools'>): Set<string> {
  const pool = poolNamesFor(input.author.name, input.pools);
  if (input.author.alias) {
    for (const name of poolNamesFor(input.author.alias, input.pools)) pool.add(name);
  }
  return pool;
}

/**
 * Why this seat may not review the author's work, or null when it may. The one
 * exclusion list: the picker drops such seats, and a seat the author names
 * (`Reviewer: @x`) is refused with this reason in the lane note. The phrase
 * follows "@x ": `is the author`, `is the author's own seat`, `is denied`,
 * `is not a review seat`, `is out of rotation (…)`, `left its last reviews
 * unanswered`, `already held this review`.
 */
export function reviewerExclusion(input: AssignInput, agent: Agent): string | null {
  if (agent.id === input.author.id) return 'is the author';
  if (handles(agent).some((h) => handles(input.author).includes(h))) return 'is the author';
  if (agent.mode === 'file' || agent.role === 'orchestrator') return 'is not a review seat';
  const deny = new Set(input.deny.map((s) => s.toLowerCase()));
  if (handles(agent).some((h) => deny.has(h))) return 'is denied';
  // The author's other seat (same profile or person stem) unless the author-glob pool names it.
  if (samePerson(input.author, agent, input.serviceProfiles ?? []) && !listed(agent, poolFor(input))) return "is the author's own seat";
  // A seat whose plan is nearly spent would stall the review at the usage-limit screen.
  const out = seatOutOfRotation(agent, input.load(agent), input.minCapacityPct ?? DEFAULT_MIN_CAPACITY_PCT);
  if (out) return `is out of rotation (${out})`;
  // A seat that left its last reviews unanswered would hold this one too.
  if (input.silent?.has(agent.id)) return 'left its last reviews unanswered';
  if (input.exclude?.has(agent.id)) return 'already held this review';
  return null;
}

/**
 * One reviewer, or null when every candidate is excluded.
 * The route target is not chosen ahead of a non-empty prefer tier.
 */
export function selectReviewer(input: AssignInput): Agent | null {
  const pool = poolFor(input);
  const routeNames = new Set(input.routeReviewers.map((s) => s.toLowerCase()));
  if (input.routeTarget) routeNames.add(input.routeTarget.toLowerCase());
  const preferKey = vendorOf(input.author.runtime);
  const prefer = new Set(
    (input.prefer[preferKey] ?? Object.entries(input.prefer).find(([key]) => key.toLowerCase() === preferKey)?.[1] ?? [])
      .map((s) => s.toLowerCase()),
  );
  const wanted = input.defaultReviewer?.toLowerCase() ?? '';
  const allow = new Set((input.allow ?? []).map((s) => s.toLowerCase()));
  const service = input.serviceProfiles ?? [];
  const isSamePerson = (agent: Agent): boolean => samePerson(input.author, agent, service);

  const excluded = (agent: Agent): boolean => reviewerExclusion(input, agent) !== null;
  const isDefault = (agent: Agent): boolean =>
    !!wanted && (handles(agent).includes(wanted) || agent.runtime.toLowerCase() === wanted);
  // The open ladder (anyone, then the tagged subset) needs auto-pick, and is
  // limited to `reviewer_allow` when that list is set.
  // A configured default is eligible even when auto-pick is off.
  const fromLadder = (agent: Agent): boolean =>
    (input.autoPick && (allow.size === 0 || listed(agent, allow))) || isDefault(agent);

  // A reviewer seat is a reviewer by role: eligible whatever the allowlist and auto-pick say.
  const reviewerSeat = (agent: Agent): boolean => agent.role === 'reviewer';
  const eligible = input.agents.filter((agent) => {
    if (excluded(agent)) return false;
    return reviewerSeat(agent) || fromLadder(agent) || listed(agent, routeNames) || listed(agent, prefer) || listed(agent, pool);
  });

  const independent = (agent: Agent): boolean => !isSamePerson(agent);
  const idle = (agent: Agent): boolean => !input.load(agent).busy;
  const otherProfile = (agent: Agent): boolean => (agent.profile ?? 'home') !== (input.author.profile ?? 'home');
  const otherVendor = (agent: Agent): boolean => vendorOf(agent.runtime) !== preferKey;
  const idleReviewer = (agent: Agent): boolean => independent(agent) && reviewerSeat(agent) && idle(agent);
  const routeTarget = input.routeTarget?.toLowerCase() ?? '';
  const tiers = [
    eligible.filter((agent) => idleReviewer(agent) && otherProfile(agent) && otherVendor(agent)),
    eligible.filter((agent) => idleReviewer(agent) && otherProfile(agent)),
    eligible.filter(idleReviewer),
    eligible.filter((agent) => independent(agent) && listed(agent, prefer)),
    eligible.filter((agent) => independent(agent) && !!routeTarget && listed(agent, new Set([routeTarget]))),
    eligible.filter((agent) => independent(agent) && isDefault(agent)),
    eligible.filter((agent) => independent(agent) && input.reviewTagIds.has(agent.id)),
    eligible.filter(independent),
    eligible.filter((agent) => isSamePerson(agent) && listed(agent, pool)),
  ];
  const best = tiers.find((tier) => tier.length > 0) ?? [];
  return pickLeastLoaded(best, input.load);
}

/** A pooled same-person seat. Independent names in the pool are not this case. */
export function sameOwnerPoolReviewer(
  author: { name: string; alias?: string | null; profile?: string | null },
  reviewer: { name: string; alias?: string | null; profile?: string | null },
  pools: Record<string, string[]>,
  serviceProfiles?: string[],
): boolean {
  if (!samePerson(author, reviewer, serviceProfiles)) return false;
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

/** A freeze's review moves at most this many times; then it waits for a person. */
export const MAX_REVIEW_REASSIGNS = 2;

/**
 * Move a review with no verdict after the window, whether the seat is busy or
 * idle (an idle seat that has not started the review it was sent is silent
 * too: on 1 Nov 2026 five freezes waited 19 hours on a named idle seat), and
 * whether it was picked or named. At most `MAX_REVIEW_REASSIGNS` times per
 * freeze (a review nobody answers must not bounce between idle seats every
 * window), and after the first move only when the next seat is idle.
 */
export function shouldReassign(opts: {
  hasVerdict: boolean;
  waitedMs: number;
  limitMs: number;
  reassignCount: number;
  nextId: string | null;
  currentId: string;
  nextIdle: boolean;
}): boolean {
  if (opts.hasVerdict) return false;
  if (!(opts.limitMs > 0) || opts.waitedMs < opts.limitMs) return false;
  if (opts.reassignCount >= MAX_REVIEW_REASSIGNS) return false;
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

export function loadFor(agent: Agent, events?: ReviewEvent[]): ReviewerLoad {
  return {
    busy: agent.status === 'working' || agent.status === 'error',
    openReviews: openReviews(agent.id),
    runningTasks: runningTasks(agent.id),
    lastAssignedAt: lastAssignedAt(agent.id, events),
    leftPct: capacityLeftPct(agent),
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

export interface ReviewEvent {
  sha: string;
  reviewerId: string;
  at: number;
  reassigned: boolean;
}

/**
 * One pass's view of reviewer load: the review events are read once and each
 * seat's load once. Choosing a reviewer sorts the candidates by load, so a pass
 * over many freezes used to re-read and re-parse the events hundreds of times
 * per freeze — on 26 Oct 2026 that froze the daemon for five minutes after
 * every reconcile pass.
 */
export function loadMemo(events = reviewEvents()): (agent: Agent) => ReviewerLoad {
  const memo = new Map<string, ReviewerLoad>();
  return (agent) => {
    const hit = memo.get(agent.id);
    if (hit) return hit;
    const load = loadFor(agent, events);
    memo.set(agent.id, load);
    return load;
  };
}

/**
 * One reconcile pass's shared view of the review history: the events read once,
 * each seat's load once, and the silent set once (on first use). Before this
 * every freeze in a pass re-read the events and re-derived the silent seats, the
 * same shape as the 26 Oct 2026 freeze (`loadMemo`).
 */
export interface ReviewPass {
  events: ReviewEvent[];
  load: (agent: Agent) => ReviewerLoad;
  /** Seats silent under their own reviews' project windows. */
  readonly silent: ReadonlySet<string>;
}

export function reviewPass(now = Date.now(), events: ReviewEvent[] = reviewEvents()): ReviewPass {
  let silent: Set<string> | null = null;
  return {
    events,
    load: loadMemo(events),
    get silent(): ReadonlySet<string> {
      silent ??= silentReviewerIds(events, projectReassignMs, now);
      return silent;
    },
  };
}

export function reviewEvents(): ReviewEvent[] {
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

export function assignmentFacts(sha: string, events = reviewEvents()): { at: number; reviewerId: string; reassigns: number } | null {
  const rows = events.filter((row) => row.sha === sha);
  if (rows.length === 0) return null;
  const last = rows[rows.length - 1];
  return { at: last.at, reviewerId: last.reviewerId, reassigns: rows.filter((row) => row.reassigned).length };
}

function lastAssignedAt(agentId: string, events = reviewEvents()): number {
  let latest = 0;
  for (const row of events) {
    if (row.reviewerId === agentId && row.at > latest) latest = row.at;
  }
  return latest;
}

/** Seats the Reviews header lists: queue depth and whether the pane is busy. */
export function reviewerLoads(): ReviewerLoadView[] {
  let agents: Agent[] = [];
  try { agents = listAgents(); } catch { agents = []; }
  const events = reviewEvents();
  return agents
    .filter((agent) => agent.mode !== 'file' && agent.role !== 'orchestrator' && !reviewerDenied(agent))
    .map((agent) => {
      const load = loadFor(agent, events);
      return { id: agent.id, name: agent.name, alias: agent.alias ?? null, busy: load.busy, queue: load.openReviews };
    })
    .sort((a, b) => b.queue - a.queue || a.name.localeCompare(b.name));
}

/** Default for `pipeline.review_reassign_minutes`. */
export const DEFAULT_REVIEW_REASSIGN_MINUTES = 10;

export function projectReassignMs(project: string | null): number {
  let raw: number | undefined;
  try { raw = project ? getConfig().projects?.[project]?.pipeline?.review_reassign_minutes : undefined; } catch { raw = undefined; }
  const minutes = typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_REVIEW_REASSIGN_MINUTES;
  return Math.max(0, minutes) * 60 * 1000;
}
