/**
 * One Stage guard for every path that can put a SHA on staging.
 *
 * Containing current main is required. A SHA that already sits on main is
 * still stageable when it moves staging forward, including a freeze closed
 * as merged — that is the normal path after the lane lands. Refuse only when
 * the SHA is behind main (it does not contain main), would roll staging
 * back, is already the staging tip (nothing new), is superseded by a newer
 * freeze in its lane, or the freeze is closed as rejected or abandoned.
 * `force_rollback` skips only the ancestor check.
 */

import { commitsBehind } from './lane-main.js';
import { behindMainLine } from './lane-status.js';
import {
  getFreeze, listFreezes, releaseBehindMain, staleStageBlock, staleStageMessage, type ReleaseFreeze,
} from './release-freezes.js';
import { currentStagingTip, resolveStagingTip, stageGateBlock } from './releases.js';
import { evaluateForward, type StagingTip } from './staging-forward.js';

export interface StageFacts {
  sha: string;
  status?: string | null;
  lane?: string | null;
  supersededBy?: string | null;
  /** Ignored. Being on main is required, not a refusal. */
  onMain?: boolean | null;
  behind?: boolean | null;
  inStaging?: boolean | null;
  /** Ignored. Production containment is not a staging refusal. */
  inProd?: boolean | null;
  /** Set when staging this SHA would move staging backwards. */
  forward?: string | null;
}

export function alreadyOnStaging(sha: string): string {
  return `Freeze ${sha.slice(0, 8)} is already on staging`;
}

/**
 * Fact-only form of the guard, for a caller that already measured the SHA.
 * Same sentences as `stageEligibility`. Merged and on-main are not refusals.
 */
export function stageRefusal(facts: StageFacts): string | null {
  const status = facts.status ?? '';
  if (status === 'rejected') return `Freeze ${facts.sha.slice(0, 8)} was rejected`;
  if (status === 'abandoned') return `Freeze ${facts.sha.slice(0, 8)} was abandoned`;
  if (status === 'stale') return staleStageMessage({ sha: facts.sha, lane: facts.lane ?? null }, facts.supersededBy ?? null);
  if (facts.behind === true || status === 'behind-main') return behindMainLine(1);
  if (facts.forward) return facts.forward;
  if (facts.inStaging === true) return alreadyOnStaging(facts.sha);
  return null;
}

export interface StageEligibilityOpts {
  /**
   * Deploy box: measure against `currentStagingTip` (this box's health command
   * or deployed row), not the release peer.
   */
  localTip?: boolean;
  /** Caller already resolved the tip. `null` means there is no known tip. */
  tipResolved?: boolean;
  tip?: StagingTip | null;
  forceRollback?: boolean;
  forceReason?: string | null;
  actorIsAdmin?: boolean;
  /** Card and `stage()` include the test gate. A release request does not. */
  includeGate?: boolean;
  /** Mark a moved lane tip stale. Card reads stay read-only. */
  markStale?: boolean;
  /** Patch the freeze and ping the lane when the SHA is behind main. */
  recordBehind?: boolean;
}

export interface StageEligibility {
  error: string | null;
  /** Set when an admin force-rollback is allowed through. */
  rollbackReason: string | null;
}

const CLEAR: StageEligibility = { error: null, rollbackReason: null };

function refused(error: string): StageEligibility {
  return { error, rollbackReason: null };
}

function closedStatus(freeze: ReleaseFreeze): string | null {
  const status = freeze.status as string;
  if (status === 'rejected') return `Freeze ${freeze.sha.slice(0, 8)} was rejected`;
  if (status === 'abandoned') return `Freeze ${freeze.sha.slice(0, 8)} was abandoned`;
  return null;
}

/** A later freeze on the same lane. Rejected and abandoned rows do not count. */
function newerInLane(freeze: ReleaseFreeze): string | null {
  if (!freeze.project || !freeze.lane) return null;
  let newer: string | null = null;
  try {
    for (const other of listFreezes()) {
      if (other.sha === freeze.sha || other.project !== freeze.project || other.lane !== freeze.lane) continue;
      const status = other.status as string;
      if (status === 'rejected' || status === 'abandoned') continue;
      if (other.created_at > freeze.created_at) newer = other.sha;
    }
  } catch { /* freeze table unavailable */ }
  return newer;
}

function behindLine(project: string, sha: string, freeze: ReleaseFreeze | null): string | null {
  let n: number | null = null;
  try { n = commitsBehind(project, sha); } catch { n = null; }
  if (freeze?.status === 'behind-main') {
    if (n != null && n > 0) return behindMainLine(n);
    return 'behind main: merge main';
  }
  if (n != null && n > 0) return behindMainLine(n);
  return null;
}

/**
 * Whether this SHA may be staged. Null error means yes.
 * Dev box passes the peer tip (`tipResolved`). Deploy box passes `localTip`.
 */
export async function stageEligibility(sha: string, project: string | null, opts: StageEligibilityOpts = {}): Promise<StageEligibility> {
  if (!project) return CLEAR;
  let freeze: ReleaseFreeze | null = null;
  try { freeze = getFreeze(sha); } catch { freeze = null; }

  if (freeze) {
    const closed = closedStatus(freeze);
    if (closed) return refused(closed);
    if (opts.markStale) {
      const stale = staleStageBlock(freeze);
      if (stale) return refused(stale);
      try { freeze = getFreeze(sha) ?? freeze; } catch { /* keep the row we had */ }
    } else if (freeze.status === 'stale') {
      return refused(staleStageMessage(freeze, freeze.superseded_by));
    }
    const newer = newerInLane(freeze);
    if (newer) return refused(staleStageMessage(freeze, newer));
  }

  if (opts.recordBehind) {
    try {
      const behind = releaseBehindMain(project, sha);
      if (behind) return refused(behind);
    } catch { /* the count below still runs */ }
  }
  const behind = behindLine(project, sha, freeze);
  if (behind) return refused(behind);

  let tip: StagingTip | null = null;
  if (opts.localTip) tip = currentStagingTip(project);
  else if (opts.tipResolved) tip = opts.tip ?? null;
  else {
    try {
      const resolved = await resolveStagingTip(project);
      tip = resolved.state === 'unknown' ? null : resolved.tip;
    } catch { tip = null; }
  }

  const forward = evaluateForward({
    project,
    requestedSha: sha,
    staging: tip,
    forceRollback: opts.forceRollback,
    forceReason: opts.forceReason,
    actorIsAdmin: opts.actorIsAdmin,
  });
  if (!forward.ok) return refused(forward.error);
  if (tip?.sha && tip.sha.toLowerCase() === sha.toLowerCase()) return refused(alreadyOnStaging(sha));

  if (opts.includeGate && freeze) {
    try {
      const gate = stageGateBlock(freeze);
      if (gate) return refused(gate);
    } catch { /* unreadable gate: do not invent a lock */ }
  }
  return { error: null, rollbackReason: forward.rollback ? forward.reason : null };
}

type ShaFreeze = Pick<ReleaseFreeze, 'sha' | 'project' | 'lane' | 'gate' | 'status' | 'superseded_by'> & {
  freeze_path?: string | null;
};

/** Card sentence for one freeze SHA. Same guard as Stage, plus the test gate. */
export async function shaStageBlock(freeze: ShaFreeze): Promise<string | null> {
  const result = await stageEligibility(freeze.sha, freeze.project, { includeGate: true, markStale: false });
  return result.error;
}
