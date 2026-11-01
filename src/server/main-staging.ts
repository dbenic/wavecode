/**
 * Staging follows main (docs/ops/development-model-plan-2026-11-01.md, phase 1).
 *
 * With `projects.<p>.pipeline.auto_stage_main: true`, every merge the queue lands is
 * followed by a staging release of the new main tip: staging is a mirror of main, nobody
 * locks it, nobody stages a lane. The request goes through `requestRelease` exactly like a
 * Stage press (forwarded to the release peer, or run by `releases.staging_command` on the
 * deploy box), in the name `wavecode`, with a note naming the lane that moved main.
 *
 * Coalesced and paced: one pending tip per project (a newer merge replaces it), at most
 * one request per `auto_stage_main_min_minutes` (default 10), never while a staging release
 * is still open, never when staging already shows that SHA, and not while the deploy box
 * cannot be asked for its tip (the pending tip waits for the next tick). Production is
 * never touched here; the candidate list and Denis's GO stay the only road to it.
 */

import { getConfig } from './config.js';
import type { WaveEvent } from './db.js';
import { emit, onEvent } from './event-bus.js';
import logger from './logger.js';
import { listReleases, requestRelease, resolveStagingTip } from './releases.js';

export const MAIN_STAGING_ACTOR = 'wavecode';
export const DEFAULT_MIN_MINUTES = 10;
export const MAIN_STAGING_TICK_MS = 60_000;

interface PendingTip {
  sha: string;
  lane: string | null;
  laneSha: string | null;
  notedAt: number;
}

const pending = new Map<string, PendingTip>();
const lastRequestAt = new Map<string, number>();
let unsubscribe: (() => void) | null = null;
let timer: NodeJS.Timeout | null = null;
let ticking = false;

export function mainStagingEnabled(project: string): boolean {
  try { return getConfig().projects?.[project]?.pipeline?.auto_stage_main === true; } catch { return false; }
}

export function mainStagingMinMs(project: string): number {
  let minutes = DEFAULT_MIN_MINUTES;
  try {
    const raw = getConfig().projects?.[project]?.pipeline?.auto_stage_main_min_minutes;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) minutes = raw;
  } catch { /* default */ }
  return minutes * 60_000;
}

/** Main moved (the queue landed a lane). Remember the newest tip; the tick stages it. */
export function noteMainAdvanced(
  project: string,
  sha: string,
  via: { lane?: string | null; laneSha?: string | null } = {},
  now = Date.now(),
): void {
  if (!/^[0-9a-f]{40}$/i.test(sha) || !mainStagingEnabled(project)) return;
  pending.set(project, { sha: sha.toLowerCase(), lane: via.lane ?? null, laneSha: via.laneSha ?? null, notedAt: now });
}

/** The main tip waiting to be staged for this project, if any (the board and tests read it). */
export function pendingMainTip(project: string): string | null {
  return pending.get(project)?.sha ?? null;
}

function openStaging(project: string): boolean {
  try {
    return listReleases({ project, target: 'staging', limit: 50 }).some((r) => r.status === 'requested' || r.status === 'sent');
  } catch {
    return false;
  }
}

/** One pass over the pending tips. Exported for the tests; the interval calls it every minute. */
export async function stageMainTick(now = Date.now()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    for (const [project, tip] of [...pending]) {
      if (!mainStagingEnabled(project)) { pending.delete(project); continue; }
      const last = lastRequestAt.get(project) ?? 0;
      if (now - last < mainStagingMinMs(project)) continue; // paced: the newer tip waits for the window
      if (openStaging(project)) continue; // one staging deploy at a time; the tip waits
      let resolved: Awaited<ReturnType<typeof resolveStagingTip>>;
      try { resolved = await resolveStagingTip(project, { fresh: true }); } catch { continue; }
      if (resolved.state === 'unknown') continue; // the deploy box could not be asked: keep the tip
      if (resolved.tip?.sha && resolved.tip.sha.toLowerCase() === tip.sha) { pending.delete(project); continue; }
      pending.delete(project);
      lastRequestAt.set(project, now);
      const note = tip.lane
        ? `main after queue merge of ${tip.lane}${tip.laneSha ? ` ${tip.laneSha.slice(0, 8)}` : ''}`
        : 'main advanced';
      const res = await requestRelease({ project, sha: tip.sha, target: 'staging', actorName: MAIN_STAGING_ACTOR, note });
      if (res.ok) {
        emit('staging.main_requested', 'release', res.data.id, { project, sha: tip.sha, lane: tip.lane, lane_sha: tip.laneSha, note }, null);
        logger.info({ project, sha: tip.sha, releaseId: res.data.id }, 'Staging follows main: release requested');
      } else {
        emit('staging.main_skipped', 'release', tip.sha, { project, sha: tip.sha, lane: tip.lane, error: res.error }, null);
        logger.warn({ project, sha: tip.sha, error: res.error }, 'Staging follows main: request refused');
      }
    }
  } finally {
    ticking = false;
  }
}

function onBusEvent(e: WaveEvent): void {
  if (e.type !== 'merge_queue.merged' || !e.payload_json) return;
  try {
    const p = JSON.parse(e.payload_json) as { project?: string; lane?: string | null; sha_in?: string; sha_out?: string };
    if (p.project && p.sha_out) noteMainAdvanced(p.project, p.sha_out, { lane: p.lane ?? null, laneSha: p.sha_in ?? null });
  } catch { /* not a payload we read */ }
}

export function startMainStaging(): void {
  if (unsubscribe) return;
  unsubscribe = onEvent(onBusEvent);
  timer = setInterval(() => {
    void stageMainTick().catch((e) => logger.warn({ error: (e as Error).message }, 'Staging follows main: tick failed'));
  }, MAIN_STAGING_TICK_MS);
  timer.unref?.();
}

export function stopMainStaging(): void {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  if (timer) { clearInterval(timer); timer = null; }
}

export function resetMainStagingForTest(): void {
  stopMainStaging();
  pending.clear();
  lastRequestAt.clear();
  ticking = false;
}
