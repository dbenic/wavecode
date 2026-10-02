/**
 * Reviewer assignment ladder: who reviews a finished run.
 *
 * Developers stay in charge; the system only fills gaps and says what it did.
 *
 *   1. explicit — the caller named one (`#review #12 @opus`, API body)
 *   2. task     — `tasks.reviewer` set when the task was created
 *   3. default  — config `review.default_reviewer` (name, then runtime)
 *   4. tag      — a FREE agent tagged `review`          (needs review.auto_pick)
 *   5. pool     — any FREE agent                         (needs review.auto_pick)
 *   —  none     — the run waits with a "needs a reviewer" item + candidates
 *
 * Rungs 1–3 use the agent even if it is busy (it was chosen on purpose; the
 * prompt queues in its pane). Rungs 4–5 need a free agent: idle, no lease, no
 * open run, profile-compatible with the task's creator, not a PM seat, and
 * never the author. Other vendor than the author is preferred everywhere
 * (different models have different blind spots), same vendor is the fallback.
 */

import { getConfig } from './config.js';
import {
  getAgent,
  getTask,
  hasOpenRun,
  listAgents,
  listAllAgentTags,
  resolveAgent,
  type Agent,
  type Run,
} from './db.js';
import { isProfileCompatible, lookupActor } from './profiles.js';

export type ReviewerRung = 'explicit' | 'task' | 'default' | 'tag' | 'pool';

export interface ReviewerPick {
  ok: true;
  agent: Agent;
  rung: ReviewerRung;
  /** One short clause for the thread: "free, other vendor". */
  reason: string;
  /** Other free agents that could take it instead (for the "Change" chips). */
  alternatives: Agent[];
}

export interface ReviewerNone {
  ok: false;
  reason: string;
  /** Agents a person could pick from (never the author). */
  candidates: Agent[];
}

export const REVIEW_TAG = 'review';
const MAX_ALTERNATIVES = 3;
const MAX_CANDIDATES = 6;

export function summarizeAgent(a: Agent): { id: string; name: string; alias: string | null; runtime: string } {
  return { id: a.id, name: a.name, alias: a.alias ?? null, runtime: a.runtime };
}

export function pickReviewer(
  run: Pick<Run, 'agent_id' | 'task_id'>,
  opts: { explicit?: string | null } = {},
): ReviewerPick | ReviewerNone {
  const cfg = getConfig();
  const authorId = run.agent_id;
  const author = getAgent(authorId);
  const authorRuntime = author.ok ? author.data.runtime : null;
  const task = getTask(run.task_id);
  const actor = lookupActor(task.ok ? task.data.created_by : null);

  const eligible = (a: Agent): boolean => a.id !== authorId && a.role !== 'orchestrator' && a.mode !== 'file';
  const free = (a: Agent): boolean =>
    eligible(a) && a.status === 'idle' && !a.owner_id && !hasOpenRun(a.id) && isProfileCompatible(a.profile, actor, cfg);
  const otherVendorFirst = (a: Agent, b: Agent): number =>
    Number(a.runtime === authorRuntime) - Number(b.runtime === authorRuntime) || a.name.localeCompare(b.name);
  const vendorNote = (a: Agent): string => (authorRuntime && a.runtime === authorRuntime ? 'same vendor' : 'other vendor');

  const agents = listAgents();
  const candidates = (): Agent[] => agents.filter(eligible).sort(otherVendorFirst).slice(0, MAX_CANDIDATES);

  // 1. explicit
  if (opts.explicit) {
    const r = resolveAgent(opts.explicit);
    if (!r.ok) return { ok: false, reason: r.error, candidates: candidates() };
    if (r.data.id === authorId) {
      return { ok: false, reason: `${r.data.alias ?? r.data.name} wrote this run and cannot review it`, candidates: candidates() };
    }
    return { ok: true, agent: r.data, rung: 'explicit', reason: 'named by you', alternatives: [] };
  }

  // 2. task
  if (task.ok && task.data.reviewer) {
    const r = getAgent(task.data.reviewer);
    if (r.ok && r.data.id !== authorId) {
      return { ok: true, agent: r.data, rung: 'task', reason: 'set on the task', alternatives: [] };
    }
  }

  // 3. config default (name, then runtime — prefer a free one of that runtime)
  const wanted = cfg.review.default_reviewer;
  if (wanted) {
    const byName = agents.find((a) => a.name === wanted && a.id !== authorId);
    if (byName) return { ok: true, agent: byName, rung: 'default', reason: 'config default_reviewer', alternatives: [] };
    const byRuntime = agents.filter((a) => a.runtime === wanted && eligible(a));
    if (byRuntime.length) {
      const agent = byRuntime.find(free) ?? byRuntime[0];
      return { ok: true, agent, rung: 'default', reason: `config default_reviewer (${wanted})`, alternatives: [] };
    }
  }

  if (!cfg.review.auto_pick) {
    return { ok: false, reason: 'no reviewer named and auto-pick is off', candidates: candidates() };
  }

  const freeAgents = agents.filter(free).sort(otherVendorFirst);
  const tags = safeTags();

  // 4. tagged review
  const tagged = freeAgents.filter((a) => tags.get(a.id)?.includes(REVIEW_TAG));
  if (tagged.length) {
    const agent = tagged[0];
    const alternatives = freeAgents.filter((a) => a.id !== agent.id).slice(0, MAX_ALTERNATIVES);
    return { ok: true, agent, rung: 'tag', reason: `free, tagged ${REVIEW_TAG}, ${vendorNote(agent)}`, alternatives };
  }

  // 5. pool
  if (freeAgents.length) {
    const agent = freeAgents[0];
    const alternatives = freeAgents.slice(1, 1 + MAX_ALTERNATIVES);
    return { ok: true, agent, rung: 'pool', reason: `free, ${vendorNote(agent)}`, alternatives };
  }

  return { ok: false, reason: 'no free agent to review (all busy, reserved or on another subscription)', candidates: candidates() };
}

function safeTags(): Map<string, string[]> {
  try {
    return listAllAgentTags();
  } catch {
    return new Map();
  }
}
