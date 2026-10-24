/**
 * Whether a SHA may be recorded as a stager job.
 * The check reuses the staging tip and the forward-only comparison.
 * Recording the job does not run the staging scripts.
 */

import { getFreeze, viewShaChecks } from './release-freezes.js';
import { resolveStagingTip, STAGE_NEEDS_PASS } from './releases.js';
import { evaluateForward } from './staging-forward.js';
import { alreadyOnStaging } from './sha-stage-block.js';
import { behindMainLine, needsGreenQuick, QUICK_CHECK_RUNNING } from './lane-status.js';

export type QuickWord = 'green' | 'red' | 'pending' | 'missing' | 'unconfigured' | 'unknown' | null;

export function opsStageBlockFromChecks(input: {
  sha: string;
  quick: QuickWord;
  verdict: string | null;
  stageBlock: string | null;
  behindMain?: boolean;
}): string | null {
  const sha8 = input.sha.slice(0, 8);
  if (input.quick === 'pending') return QUICK_CHECK_RUNNING;
  if (input.quick !== 'green') return needsGreenQuick(sha8);
  if (input.verdict !== 'pass') return STAGE_NEEDS_PASS;
  if (input.stageBlock) return input.stageBlock;
  if (input.behindMain) return behindMainLine(1);
  return null;
}

export async function opsStageRefusal(sha: string): Promise<string | null> {
  const freeze = getFreeze(sha);
  if (!freeze) return `no freeze for ${sha.slice(0, 8)}`;
  if (!freeze.project) return 'no project for this SHA';
  const view = await viewShaChecks(freeze);
  if (view.quick !== 'green') {
    return view.quick === 'pending' ? QUICK_CHECK_RUNNING : needsGreenQuick(sha.slice(0, 8));
  }
  if (freeze.verdict !== 'pass') return STAGE_NEEDS_PASS;
  const resolved = await resolveStagingTip(freeze.project, { fresh: true });
  const tipUnknown = resolved.state === 'unknown';
  const forward = await evaluateForward({
    project: freeze.project,
    requestedSha: sha,
    staging: resolved.tip,
    tipUnknown,
    actorIsAdmin: false,
  });
  if (!forward.ok) return forward.error;
  if (resolved.tip?.sha && resolved.tip.sha.toLowerCase() === sha.toLowerCase()) return alreadyOnStaging(sha);
  return null;
}
