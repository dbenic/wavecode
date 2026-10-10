/**
 * The board: what every agent is doing and what every reviewed lane needs,
 * computed from the database alone. Nothing here asks an agent anything.
 * The overlord (overlord.ts) reads this; the Overview page shows it.
 */

import { getConfig } from './config.js';
import { getDb, getTask, listAgents, listAgentMessages, listRuns, type Agent } from './db.js';
import { usageFor } from './usage-probe.js';
import { listPeerQuestions } from './peers.js';
import { listFreezes, type ReleaseFreeze } from './release-freezes.js';
import { listReleases, type ReleaseRequest } from './releases.js';

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
  /** release freezes this agent authored that are still open */
  open_freezes: number;
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
  staging: { status: string; version: string | null; at: string; by: string | null } | null;
  production: { status: string; version: string | null; at: string; by: string | null } | null;
  /** deterministic next step, before any model opinion */
  next: string;
  updated_at: string;
}

export interface AttentionRow {
  kind: 'needs_reviewer' | 'hung' | 'crashed' | 'stale' | 'release_failed' | 'awaiting_answer' | 'promotable' | 'idle_with_open_work';
  text: string;
  agent_id?: string;
  run_id?: string;
  sha?: string;
}

export interface Board {
  at: string;
  host: string;
  agents: AgentBoardRow[];
  lanes: LaneBoardRow[];
  attention: AttentionRow[];
  counts: { working: number; idle: number; error: number; open_lanes: number; promotable: number; releases_open: number };
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
  return r ? { status: r.status, version: r.version, at: iso(r.updated_at)!, by: r.requested_by } : null;
}

function nextStep(f: ReleaseFreeze, staging: ReleaseRequest | null, production: ReleaseRequest | null): { next: string; promotable: boolean } {
  if (f.status === 'stale') return { next: `stale — lane moved to ${f.superseded_by?.slice(0, 8) ?? 'a newer commit'}; freeze and review the new SHA`, promotable: false };
  if (f.status === 'promoted') return { next: production?.status === 'deployed' ? 'in production' : 'promoted — waiting for the deployer', promotable: false };
  if (f.status === 'rejected') return { next: 'rejected', promotable: false };
  if (production && (production.status === 'sent' || production.status === 'requested')) return { next: 'production GO sent — waiting for the deployer', promotable: false };
  if (production?.status === 'failed') return { next: `production failed: ${production.error ?? 'see report'} — fix, refreeze or retry`, promotable: f.verdict === 'pass' };
  if (f.verdict !== 'pass') return { next: f.verdict ? 'needs fixes — author fixes, refreezes, reviewer re-reviews' : 'waiting for an independent verdict', promotable: false };
  if (f.gate === 'RED') return { next: 'PASS but the remote gate is RED — not promotable until green', promotable: false };
  if (staging && (staging.status === 'sent' || staging.status === 'requested')) return { next: 'staging in progress', promotable: true };
  if (staging?.status === 'deployed') return { next: 'staged and reviewed — ready to promote', promotable: true };
  if (staging?.status === 'failed') return { next: `staging failed: ${staging.error ?? 'see report'}`, promotable: true };
  return { next: 'reviewed — stage it, then promote', promotable: true };
}

export function buildBoard(now = Date.now()): Board {
  const cfg = getConfig();
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
        blocked_on: blocked, usage: usage?.summary ?? null, open_freezes: openFreezesByAuthor.get(a.id) ?? 0,
      };
    });

  const lanes: LaneBoardRow[] = freezes
    .filter((f) => f.run_id && (f.status === 'open' || f.status === 'stale' || (f.status === 'promoted' && minutesSince(iso(f.updated_at), now)! < 24 * 60)))
    .map((f) => {
      const rels = listReleases({ sha: f.sha, limit: 20 });
      const staging = rels.find((r) => r.target === 'staging') ?? null;
      const production = rels.find((r) => r.target === 'production') ?? null;
      const { next, promotable } = nextStep(f, staging, production);
      if (f.status === 'stale') attention.push({ kind: 'stale', text: `${f.project ?? ''} ${f.lane ?? ''} ${f.sha.slice(0, 8)} is stale`, sha: f.sha, run_id: f.run_id! });
      if (promotable && f.status === 'open') attention.push({ kind: 'promotable', text: `${f.project ?? ''}${f.desk ? ` Desk #${f.desk}` : ''} ${f.sha.slice(0, 8)}: ${next}`, sha: f.sha, run_id: f.run_id! });
      for (const r of [staging, production]) if (r?.status === 'failed') attention.push({ kind: 'release_failed', text: `${r.target} failed for ${f.sha.slice(0, 8)}: ${r.error ?? ''}`, sha: f.sha, run_id: f.run_id! });
      return {
        sha: f.sha, run_id: f.run_id, project: f.project, desk: f.desk, lane: f.lane, author: f.author_name, reviewer: f.reviewer_name,
        verdict: f.verdict, gate: f.gate, status: f.status, superseded_by: f.superseded_by, promotable,
        staging: releaseCell(staging), production: releaseCell(production), next, updated_at: iso(f.updated_at)!,
      };
    });

  const releasesOpen = listReleases({ limit: 100 }).filter((r) => r.status === 'sent' || r.status === 'requested').length;
  return {
    at: atIso,
    host: cfg.server?.host ?? 'wavecode',
    agents,
    lanes,
    attention,
    counts: {
      working: agents.filter((a) => a.status === 'working').length,
      idle: agents.filter((a) => a.status === 'idle').length,
      error: agents.filter((a) => a.status === 'error').length,
      open_lanes: lanes.filter((l) => l.status === 'open').length,
      promotable: lanes.filter((l) => l.promotable && l.status === 'open').length,
      releases_open: releasesOpen,
    },
  };
}
