/**
 * The board: what every agent is doing and what every reviewed lane needs,
 * computed from the database alone. Nothing here asks an agent anything.
 * The overlord (overlord.ts) reads this; the Overview page shows it.
 */

import { getConfig } from './config.js';
import { getDb, getTask, listAgents, listAgentMessages, listRuns, type Agent, type Task } from './db.js';
import { usageFor } from './usage-probe.js';
import { listPeerQuestions } from './peers.js';
import { candidateFor, listCandidates, listFreezes, reconcileMerged, type ReleaseFreeze } from './release-freezes.js';
import { listReleases, verificationFor, type ReleaseRequest } from './releases.js';

export interface AgentBoardRow {
  id: string;
  name: string;
  alias: string | null;
  runtime: string;
  model: string | null;
  status: Agent['status'];
  /** when the status last changed (ISO, UTC) */
  status_since: string | null;
  /** minutes in the current status */
  for_min: number | null;
  current: { task_id: string; num: number | null; prompt: string; run_id: string; started_at: string } | null;
  last_reply: { at: string; text: string } | null;
  /** 'awaiting peer answer' | 'review pending' | 'needs reviewer' | 'hung' | 'crashed' | null */
  blocked_on: string | null;
  usage: string | null;
  /** subscription budget from the usage probe: % left of the weekly and the 5-hour window */
  budget: { weekly_left: number | null; five_h_left: number | null; resets: string | null };
  /** release freezes this agent authored that are still open */
  open_freezes: number;
}

/** Something that needs a fix and, ideally, an agent queued to do it. */
export interface FixRow {
  sha: string;
  run_id: string;
  project: string | null;
  desk: number | null;
  lane: string | null;
  author: string | null;
  author_agent_id: string | null;
  reviewer: string | null;
  reason: 'needs fixes' | 'release failed' | 'rejected';
  detail: string | null;
  since: string;
  /** the task queued for the fix (prompt carries `[fix <sha8>]`), or null when nobody is on it */
  assigned: { task_id: string; num: number | null; status: Task['status']; agent_id: string | null; agent_name: string | null } | null;
}

export interface LaneBoardRow {
  sha: string;
  run_id: string | null;
  project: string | null;
  desk: number | null;
  lane: string | null;
  author: string | null;
  reviewer: string | null;
  verdict: string | null;
  gate: string | null;
  status: ReleaseFreeze['status'];
  superseded_by: string | null;
  promotable: boolean;
  /** the unreleased release candidate branch this SHA already sits in (projects.<p>.candidate_refs), if any */
  candidate: string | null;
  /** first lines of the freeze note (scope of the change), for grouping decisions */
  summary: string | null;
  staging: { status: string; version: string | null; at: string; by: string | null; verified_by: string | null; verified_at: string | null } | null;
  production: { status: string; version: string | null; at: string; by: string | null; verified_by: string | null; verified_at: string | null } | null;
  /** deterministic next step, before any model opinion */
  next: string;
  updated_at: string;
}

export interface AttentionRow {
  kind: 'needs_reviewer' | 'hung' | 'crashed' | 'stale' | 'release_failed' | 'awaiting_answer' | 'promotable' | 'idle_with_open_work' | 'fix_unassigned';
  text: string;
  agent_id?: string;
  run_id?: string;
  sha?: string;
}

/** A composed release candidate (projects.<p>.candidate_refs): the unit that goes to production. */
export interface CandidateRow {
  project: string;
  name: string;
  tip: string;
  committed_at: string | null;
  /** lanes (freeze SHAs) the candidate contains, per the board */
  lanes: Array<{ sha: string; desk: number | null; lane: string | null; verdict: string | null; author: string | null }>;
  staging: LaneBoardRow['staging'];
  production: LaneBoardRow['production'];
  verified: { by: string; at: string; note: string | null } | null;
  next: string;
}

export interface Board {
  at: string;
  host: string;
  agents: AgentBoardRow[];
  lanes: LaneBoardRow[];
  candidates: CandidateRow[];
  fixes: FixRow[];
  attention: AttentionRow[];
  counts: { working: number; idle: number; error: number; open_lanes: number; promotable: number; releases_open: number; open_fixes: number; unassigned_fixes: number };
}

/** The marker a fix task carries in its prompt so the board can tie it to the SHA. */
export function fixMarker(sha: string): string {
  return `[fix ${sha.slice(0, 8)}]`;
}

function assignedFixTask(sha: string, since: string): FixRow['assigned'] {
  const row = getDb().prepare(
    `SELECT t.id, t.num, t.status, t.agent_id, a.name AS agent_name FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id
     WHERE t.prompt LIKE ? AND t.created_at >= ? ORDER BY t.created_at DESC LIMIT 1`,
  ).get(`%${fixMarker(sha)}%`, since.replace('T', ' ').replace('Z', '').slice(0, 19)) as { id: string; num: number | null; status: Task['status']; agent_id: string | null; agent_name: string | null } | undefined;
  return row ? { task_id: row.id, num: row.num, status: row.status, agent_id: row.agent_id, agent_name: row.agent_name } : null;
}

const IDLE_WITH_WORK_MIN = 20;

function iso(sqlite: string | null | undefined): string | null {
  if (!sqlite) return null;
  return sqlite.includes('T') ? sqlite : `${sqlite.replace(' ', 'T')}Z`;
}

function minutesSince(isoTs: string | null, now: number): number | null {
  if (!isoTs) return null;
  const t = Date.parse(isoTs);
  return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 60_000)) : null;
}

function lastEvent(type: string, entityId: string): { created_at: string } | null {
  return (getDb().prepare('SELECT created_at FROM events WHERE type = ? AND entity_id = ? ORDER BY id DESC LIMIT 1').get(type, entityId) as { created_at: string } | undefined) ?? null;
}

function lastStatusChange(agentId: string): string | null {
  return iso(lastEvent('agent.status_changed', agentId)?.created_at);
}

function lastAlert(agentId: string, statusSince: string | null): 'hung' | 'crashed' | null {
  for (const [type, kind] of [['agent.hung', 'hung'], ['agent.crashed', 'crashed']] as const) {
    const at = iso(lastEvent(type, agentId)?.created_at);
    if (at && (!statusSince || at > statusSince)) return kind;
  }
  return null;
}

function pendingReviewFor(agentId: string): { runId: string; needsReviewer: boolean } | null {
  const row = getDb().prepare(`
    SELECT r.id AS run_id,
      EXISTS(SELECT 1 FROM code_reviews c WHERE c.run_id = r.id AND c.status = 'pending' AND c.reviewer_type = 'cross-model' AND c.reviewer_agent_id IS NULL) AS needs
    FROM runs r WHERE r.agent_id = ? AND r.status = 'done' AND r.review_status = 'pending'
      AND NOT EXISTS (SELECT 1 FROM release_freezes f WHERE f.run_id = r.id)
    ORDER BY r.finished_at DESC LIMIT 1`).get(agentId) as { run_id: string; needs: number } | undefined;
  return row ? { runId: row.run_id, needsReviewer: !!row.needs } : null;
}

function releaseCell(r: ReleaseRequest | null): LaneBoardRow['staging'] {
  if (!r) return null;
  const v = verificationFor(r.sha);
  return { status: r.status, version: r.version, at: iso(r.updated_at)!, by: r.requested_by, verified_by: v?.verified_by ?? r.verified_by ?? null, verified_at: v ? iso(v.verified_at) : r.verified_at ? iso(r.verified_at) : null };
}

function nextStep(f: ReleaseFreeze, staging: ReleaseRequest | null, production: ReleaseRequest | null, candidate: string | null): { next: string; promotable: boolean } {
  if (f.status === 'merged') return { next: 'on main — merged or deployed outside this pipeline', promotable: false };
  if (candidate) return { next: `in candidate ${candidate} — ships with that release`, promotable: false };
  if (f.project && getConfig().projects?.[f.project]?.candidate_refs) {
    if (f.status !== 'open') return { next: f.status, promotable: false };
    if (f.verdict !== 'pass') return { next: f.verdict ? 'needs fixes — author fixes, refreezes, reviewer re-reviews' : 'waiting for an independent verdict', promotable: false };
    return { next: 'reviewed — waiting to be composed into the next candidate', promotable: false };
  }
  if (f.status === 'stale') return { next: `stale — superseded by ${f.superseded_by?.slice(0, 8) ?? 'a newer freeze'}; the new SHA carries the work`, promotable: false };
  if (f.status === 'promoted') return { next: production?.status === 'deployed' ? 'in production' : 'promoted — waiting for the deployer', promotable: false };
  if (f.status === 'rejected') return { next: 'rejected', promotable: false };
  if (production && (production.status === 'sent' || production.status === 'requested')) return { next: 'production GO sent — waiting for the deployer', promotable: false };
  if (production?.status === 'failed') return { next: `production failed: ${production.error ?? 'see report'} — fix, refreeze or retry`, promotable: f.verdict === 'pass' };
  if (f.verdict !== 'pass') return { next: f.verdict ? 'needs fixes — author fixes, refreezes, reviewer re-reviews' : 'waiting for an independent verdict', promotable: false };
  if (f.gate === 'RED') return { next: 'PASS but the remote gate is RED — not promotable until green', promotable: false };
  if (staging && (staging.status === 'sent' || staging.status === 'requested')) return { next: 'staging in progress', promotable: true };
  if (staging?.status === 'deployed' && staging.verified_by) return { next: `verified on staging by ${staging.verified_by} — ready for production`, promotable: true };
  if (staging?.status === 'deployed') return { next: 'on staging — verify it, then deploy to production', promotable: true };
  if (staging?.status === 'failed') return { next: `staging failed: ${staging.error ?? 'see report'}`, promotable: true };
  return { next: 'reviewed — stage it, then promote', promotable: true };
}

export function buildBoard(now = Date.now()): Board {
  const cfg = getConfig();
  // A SHA already on main closes its lane and its fix, whatever the last verdict said
  try { reconcileMerged(now); } catch (e) { /* git unavailable: the board still builds */ void e; }
  const atIso = new Date(now).toISOString();
  const openQuestions = listPeerQuestions({ limit: 200 }).filter((q) => q.status === 'sent' || q.status === 'queued');
  const freezes = listFreezes();
  const openFreezesByAuthor = new Map<string, number>();
  for (const f of freezes) if (f.status === 'open' && f.author_agent_id) openFreezesByAuthor.set(f.author_agent_id, (openFreezesByAuthor.get(f.author_agent_id) ?? 0) + 1);

  const attention: AttentionRow[] = [];
  const agents: AgentBoardRow[] = listAgents()
    .filter((a) => !a.tmux_session.startsWith('wc-login-'))
    .map((a) => {
      const statusSince = lastStatusChange(a.id);
      const forMin = minutesSince(statusSince, now);
      const running = listRuns({ agent_id: a.id, status: 'running' })[0] ?? null;
      let current: AgentBoardRow['current'] = null;
      if (running) {
        const t = getTask(running.task_id);
        current = { task_id: running.task_id, num: t.ok ? ((t.data as { num?: number | null }).num ?? null) : null, prompt: t.ok ? t.data.prompt.slice(0, 200) : '', run_id: running.id, started_at: iso(running.started_at)! };
      }
      const reply = listAgentMessages({ from_agent_id: a.id, limit: 8 }).find((m) => m.message_type === 'reply');
      const alert = lastAlert(a.id, statusSince);
      const question = openQuestions.find((q) => q.from_agent_id === a.id);
      const review = pendingReviewFor(a.id);
      let blocked: string | null = null;
      if (alert) blocked = alert;
      else if (question) blocked = `awaiting peer answer (${question.peer}/${question.agent})`;
      else if (review?.needsReviewer) blocked = 'needs reviewer';
      else if (review) blocked = 'review pending';
      const usage = usageFor(a.runtime, a.profile);
      const weekly = usage?.metrics.find((m) => m.label === 'weekly') ?? null;
      const fiveH = usage?.metrics.find((m) => m.label === '5h') ?? null;
      if (alert) attention.push({ kind: alert, text: `@${a.alias ?? a.name} ${alert}`, agent_id: a.id });
      if (question) attention.push({ kind: 'awaiting_answer', text: `@${a.alias ?? a.name} waits for ${question.peer}/${question.agent} (${minutesSince(iso(question.created_at), now) ?? '?'} min)`, agent_id: a.id });
      if (review?.needsReviewer) attention.push({ kind: 'needs_reviewer', text: `@${a.alias ?? a.name}'s run needs a reviewer`, agent_id: a.id, run_id: review.runId });
      if (a.status === 'idle' && current && forMin !== null && forMin >= IDLE_WITH_WORK_MIN) {
        attention.push({ kind: 'idle_with_open_work', text: `@${a.alias ?? a.name} idle ${forMin} min with task #${current.num ?? '?'} still open`, agent_id: a.id, run_id: current.run_id });
      }
      return {
        id: a.id, name: a.name, alias: a.alias ?? null, runtime: a.runtime, model: (a as { model?: string | null }).model ?? null,
        status: a.status, status_since: statusSince, for_min: forMin, current,
        last_reply: reply ? { at: iso(reply.created_at)!, text: reply.message.slice(0, 240) } : null,
        blocked_on: blocked, usage: usage?.summary ?? null,
        budget: { weekly_left: weekly?.left_pct ?? null, five_h_left: fiveH?.left_pct ?? null, resets: weekly?.resets ?? null },
        open_freezes: openFreezesByAuthor.get(a.id) ?? 0,
      };
    });

  const lanes: LaneBoardRow[] = freezes
    .filter((f) => f.run_id && (f.status === 'open' || f.status === 'stale' || (f.status === 'promoted' && minutesSince(iso(f.updated_at), now)! < 24 * 60)))
    .map((f) => {
      const rels = listReleases({ sha: f.sha, limit: 20 });
      const staging = rels.find((r) => r.target === 'staging') ?? null;
      const production = rels.find((r) => r.target === 'production') ?? null;
      let candidate: string | null = null;
      try { candidate = f.status === 'open' || f.status === 'stale' ? candidateFor(f.project, f.sha, now)?.name ?? null : null; } catch { candidate = null; }
      const { next, promotable } = nextStep(f, staging, production, candidate);
      if (f.status === 'stale' && !candidate) attention.push({ kind: 'stale', text: `${f.project ?? ''} ${f.lane ?? ''} ${f.sha.slice(0, 8)} is stale`, sha: f.sha, run_id: f.run_id! });
      if (promotable && f.status === 'open') attention.push({ kind: 'promotable', text: `${f.project ?? ''}${f.desk ? ` Desk #${f.desk}` : ''} ${f.sha.slice(0, 8)}: ${next}`, sha: f.sha, run_id: f.run_id! });
      for (const r of [staging, production]) if (r?.status === 'failed') attention.push({ kind: 'release_failed', text: `${r.target} failed for ${f.sha.slice(0, 8)}: ${r.error ?? ''}`, sha: f.sha, run_id: f.run_id! });
      const summaryRow = f.run_id ? (getDb().prepare('SELECT summary FROM runs WHERE id = ?').get(f.run_id) as { summary: string | null } | undefined) : undefined;
      return {
        sha: f.sha, run_id: f.run_id, project: f.project, desk: f.desk, lane: f.lane, author: f.author_name, reviewer: f.reviewer_name,
        verdict: f.verdict, gate: f.gate, status: f.status, superseded_by: f.superseded_by, promotable, candidate,
        summary: summaryRow?.summary ? summaryRow.summary.replace(/\s+/g, ' ').slice(0, 600) : null,
        staging: releaseCell(staging), production: releaseCell(production), next, updated_at: iso(f.updated_at)!,
      };
    });

  // Open fixes: a lane whose latest verdict is NEEDS FIXES (and no newer freeze replaced it), a failed release, a rejected freeze with a reason
  const fixes: FixRow[] = [];
  const inCandidate = new Set(lanes.filter((l) => l.candidate).map((l) => l.sha));
  for (const f of freezes) {
    if (!f.run_id) continue;
    if (inCandidate.has(f.sha)) continue; // ships with the candidate: not an open fix
    const rels = listReleases({ sha: f.sha, limit: 20 });
    const failed = rels.find((r) => r.status === 'failed');
    let reason: FixRow['reason'] | null = null;
    let detail: string | null = null;
    if (f.status === 'open' && (f.verdict === 'needs-fixes' || f.verdict === 'reject')) { reason = 'needs fixes'; detail = f.verdict_path; }
    else if (f.status !== 'stale' && f.status !== 'rejected' && failed) { reason = 'release failed'; detail = `${failed.target}: ${failed.error ?? 'see report'}`; }
    else if (f.status === 'rejected' && f.decision_reason && minutesSince(iso(f.updated_at), now)! < 7 * 24 * 60) { reason = 'rejected'; detail = f.decision_reason; }
    if (!reason) continue;
    const since = iso(f.updated_at)!;
    const assigned = assignedFixTask(f.sha, since);
    if (assigned?.status === 'done') continue; // fixed: the next freeze on the lane will show as a new card
    fixes.push({ sha: f.sha, run_id: f.run_id, project: f.project, desk: f.desk, lane: f.lane, author: f.author_name, author_agent_id: f.author_agent_id, reviewer: f.reviewer_name, reason, detail, since, assigned });
    if (!assigned) attention.push({ kind: 'fix_unassigned', text: `${f.project ?? ''}${f.desk ? ` Desk #${f.desk}` : ''} ${f.sha.slice(0, 8)} ${reason} — nobody assigned`, sha: f.sha, run_id: f.run_id, agent_id: f.author_agent_id ?? undefined });
  }

  const candidates: CandidateRow[] = [];
  for (const project of Object.keys(cfg.projects ?? {})) {
    let refs: ReturnType<typeof listCandidates> = [];
    try { refs = listCandidates(project, now); } catch { refs = []; }
    for (const c of refs) {
      const rels = listReleases({ sha: c.tip, limit: 20 });
      const staging = rels.find((r) => r.target === 'staging') ?? null;
      const production = rels.find((r) => r.target === 'production') ?? null;
      const v = verificationFor(c.tip);
      const contained = lanes.filter((l) => l.candidate === c.name).map((l) => ({ sha: l.sha, desk: l.desk, lane: l.lane, verdict: l.verdict, author: l.author }));
      let next: string;
      if (production && (production.status === 'sent' || production.status === 'requested')) next = 'production GO sent — waiting for the deployer';
      else if (production?.status === 'deployed') next = 'deployed to production — main will catch up on merge';
      else if (production?.status === 'failed') next = `production failed: ${production.error ?? 'see report'}`;
      else if (v) next = `verified on staging by ${v.verified_by} — ready for the production GO`;
      else if (staging?.status === 'deployed') next = 'on staging — verify, then GO';
      else if (staging && (staging.status === 'sent' || staging.status === 'requested')) next = 'staging in progress';
      else next = 'composed — staged by the deployer on its own; verify on staging, then GO';
      candidates.push({ project, name: c.name, tip: c.tip, committed_at: c.committed_at, lanes: contained, staging: releaseCell(staging), production: releaseCell(production), verified: v ? { by: v.verified_by, at: iso(v.verified_at)!, note: v.note } : null, next });
      if (v && !production) attention.push({ kind: 'promotable', text: `${project} ${c.name} verified on staging by ${v.verified_by} — ready for the production GO`, sha: c.tip });
    }
  }

  const releasesOpen = listReleases({ limit: 100 }).filter((r) => r.status === 'sent' || r.status === 'requested').length;
  return {
    at: atIso,
    host: cfg.server?.host ?? 'wavecode',
    agents,
    lanes,
    candidates,
    fixes,
    attention,
    counts: {
      working: agents.filter((a) => a.status === 'working').length,
      idle: agents.filter((a) => a.status === 'idle').length,
      error: agents.filter((a) => a.status === 'error').length,
      open_lanes: lanes.filter((l) => l.status === 'open').length,
      promotable: lanes.filter((l) => l.promotable && l.status === 'open').length,
      releases_open: releasesOpen,
      open_fixes: fixes.length,
      unassigned_fixes: fixes.filter((x) => !x.assigned).length,
    },
  };
}
