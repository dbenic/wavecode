/**
 * Stage lock for one freeze SHA. The lane board only knows configured lanes,
 * so a card whose lane is missing (or an older SHA on a known lane) used to
 * ship with `stage_block: null` and an enabled Stage button. This reads the
 * SHA itself: closed, merged, superseded, already contained, behind main,
 * then forward-only, then the gate.
 */

import { gitAncestorSync } from './git-memo.js';
import { commitsBehind, projectRepo } from './lane-main.js';
import { behindMainLine } from './lane-status.js';
import { isOnMain, staleStageMessage, type ReleaseFreeze } from './release-freezes.js';
import { listReleases, resolveStagingTip, stageGateBlock } from './releases.js';
import { readProdHealth, stagingForwardBlock } from './staging-forward.js';

export interface StageFacts {
  sha: string;
  status?: string | null;
  lane?: string | null;
  supersededBy?: string | null;
  onMain?: boolean | null;
  behind?: boolean | null;
  inStaging?: boolean | null;
  inProd?: boolean | null;
  /** Set when staging this SHA would move staging backwards. */
  forward?: string | null;
}

export function alreadyOnMain(sha: string): string {
  return `Freeze ${sha.slice(0, 8)} is already on main`;
}

export function alreadyOnStaging(sha: string): string {
  return `Freeze ${sha.slice(0, 8)} is already on staging`;
}

export function alreadyInProduction(sha: string): string {
  return `Freeze ${sha.slice(0, 8)} is already in production`;
}

/** Why Stage must refuse, before the test gate. Null when none of these apply. */
export function stageRefusal(facts: StageFacts): string | null {
  const status = facts.status ?? '';
  if (status === 'merged' || facts.onMain === true) return alreadyOnMain(facts.sha);
  if (status === 'rejected') return `Freeze ${facts.sha.slice(0, 8)} was rejected`;
  if (status === 'promoted') return `Freeze ${facts.sha.slice(0, 8)} was already promoted`;
  if (status === 'stale') return staleStageMessage({ sha: facts.sha, lane: facts.lane ?? null }, facts.supersededBy ?? null);
  if (facts.behind === true || status === 'behind-main') return behindMainLine(1);
  if (facts.inProd === true) return alreadyInProduction(facts.sha);
  if (facts.forward) return facts.forward;
  if (facts.inStaging === true) return alreadyOnStaging(facts.sha);
  return null;
}

type ShaFreeze = Pick<ReleaseFreeze, 'sha' | 'project' | 'lane' | 'gate' | 'status' | 'superseded_by'> & {
  freeze_path?: string | null;
};

/** Behind main, forward-only, and closed/contained, from this SHA. The lane name is not required. */
export async function shaStageBlock(freeze: ShaFreeze): Promise<string | null> {
  let onMain: boolean | null = null;
  let behind: boolean | null = freeze.status === 'behind-main' ? true : null;
  let inStaging: boolean | null = null;
  let inProd: boolean | null = null;
  let forward: string | null = null;
  const project = freeze.project;
  if (project) {
    try { onMain = isOnMain(project, freeze.sha); } catch { onMain = null; }
    try {
      const n = commitsBehind(project, freeze.sha);
      if (n != null) behind = n > 0 || behind === true;
    } catch { /* keep the status bit */ }
    try {
      const resolved = await resolveStagingTip(project);
      const tip = resolved.state === 'unknown' ? null : resolved.tip;
      const repo = projectRepo(project);
      if (tip?.sha && repo) inStaging = gitAncestorSync(repo, freeze.sha, tip.sha);
      if (tip?.sha) forward = await stagingForwardBlock(project, freeze.sha, tip);
    } catch { /* unknown tip: do not invent a forward block */ }
    try {
      const health = readProdHealth(project);
      const row = listReleases({ project, target: 'production', status: 'deployed', limit: 1 })[0]
        ?? listReleases({ target: 'production', status: 'deployed', limit: 20 }).find((r) => r.project == null || r.project === project)
        ?? null;
      const prodSha = health?.sha ?? (row ? (row.deployed_sha || row.sha) : null);
      const repo = projectRepo(project);
      if (prodSha && repo) inProd = gitAncestorSync(repo, freeze.sha, prodSha);
    } catch { inProd = null; }
  }
  const refusal = stageRefusal({
    sha: freeze.sha,
    status: freeze.status,
    lane: freeze.lane,
    supersededBy: freeze.superseded_by,
    onMain,
    behind,
    inStaging,
    inProd,
    forward,
  });
  if (refusal) return refusal;
  try { return stageGateBlock(freeze); } catch { return null; }
}
