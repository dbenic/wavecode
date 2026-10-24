/**
 * Read-only Ops lanes collector.
 * Every poll reads `<dir>/<bot>.json` and nothing else. It does not follow
 * last_receipt_path, and it does not write. A missing directory is a field
 * on the snapshot.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';
import logger from './logger.js';
import { parseHeartbeat, unreadLane, type OpsLaneRow } from './ops-lanes-classify.js';
import { resolveOpsLanes, type ResolvedOpsLanes } from './ops-lanes-config.js';

/** Heartbeats are small JSON files. Anything larger is invalid and is not read. */
export const MAX_HEARTBEAT_BYTES = 64 * 1024;

const BOT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface OpsReport {
  collected_at: string | null;
  poll_s: number;
  stale_min: number;
  dir_error: 'missing' | 'unavailable' | null;
  lanes: OpsLaneRow[];
}

export type HeartbeatLoad = { raw: string } | { error: 'missing' | 'invalid' };

export interface OpsDeps {
  now?: () => number;
  config?: ResolvedOpsLanes;
  readHeartbeat?: (dir: string, bot: string) => Promise<HeartbeatLoad>;
}

let snapshot: OpsReport | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<OpsReport> | null = null;

function resolvedConfig(override?: ResolvedOpsLanes): ResolvedOpsLanes {
  if (override) return override;
  try {
    return resolveOpsLanes(getConfig());
  } catch {
    return resolveOpsLanes(undefined);
  }
}

export function emptyReport(cfg: ResolvedOpsLanes): OpsReport {
  const nowMs = Date.now();
  return {
    collected_at: null,
    poll_s: cfg.pollS,
    stale_min: cfg.staleMin,
    dir_error: null,
    lanes: cfg.bots.map((bot) => unreadLane(bot, 'unknown', nowMs, cfg.staleS)),
  };
}

/** Last snapshot. Before the first collect, the configured lanes with unknown fields. */
export function opsLanesSnapshot(): OpsReport {
  return snapshot ?? emptyReport(resolvedConfig());
}

function dirFailure(err: unknown): 'missing' | 'unavailable' {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unavailable';
}

async function readHeartbeatFile(dir: string, bot: string): Promise<HeartbeatLoad> {
  if (!BOT_NAME_RE.test(bot)) return { error: 'invalid' };
  const filePath = path.join(dir, `${bot}.json`);
  try {
    const st = await fs.promises.stat(filePath);
    if (!st.isFile() || st.size > MAX_HEARTBEAT_BYTES) return { error: 'invalid' };
    return { raw: await fs.promises.readFile(filePath, 'utf8') };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { error: 'missing' };
    return { error: 'invalid' };
  }
}

async function resolveDir(dir: string): Promise<{ dir: string } | { error: 'missing' | 'unavailable' }> {
  if (!dir.trim()) return { error: 'missing' };
  try {
    return { dir: await fs.promises.realpath(dir) };
  } catch (err) {
    return { error: dirFailure(err) };
  }
}

async function collectNow(deps: OpsDeps): Promise<OpsReport> {
  try {
    return await collectReport(deps);
  } catch (err) {
    logger.warn({ error: (err as Error).message }, 'Ops lanes collect failed');
    return snapshot ?? emptyReport(resolvedConfig(deps.config));
  }
}

async function collectReport(deps: OpsDeps): Promise<OpsReport> {
  const cfg = resolvedConfig(deps.config);
  const nowMs = deps.now?.() ?? Date.now();
  const read = deps.readHeartbeat ?? readHeartbeatFile;
  const located = deps.readHeartbeat ? { dir: cfg.dir } : await resolveDir(cfg.dir);
  const dirError = 'error' in located ? located.error : null;
  const lanes: OpsLaneRow[] = [];
  for (const bot of cfg.bots) {
    if ('error' in located) {
      lanes.push(unreadLane(bot, 'missing', nowMs, cfg.staleS));
      continue;
    }
    const loaded = await read(located.dir, bot);
    if ('error' in loaded) {
      lanes.push(unreadLane(bot, loaded.error, nowMs, cfg.staleS));
      continue;
    }
    lanes.push(parseHeartbeat(bot, loaded.raw, nowMs, cfg.staleS));
  }
  const report: OpsReport = {
    collected_at: new Date(nowMs).toISOString(),
    poll_s: cfg.pollS,
    stale_min: cfg.staleMin,
    dir_error: dirError,
    lanes,
  };
  snapshot = report;
  return report;
}

function usesTestDeps(deps: OpsDeps): boolean {
  return Boolean(deps.now || deps.config || deps.readHeartbeat);
}

export function collectOnce(deps: OpsDeps = {}): Promise<OpsReport> {
  if (!usesTestDeps(deps) && inflight) return inflight;
  const run = collectNow(deps).finally(() => {
    if (inflight === run) inflight = null;
  });
  if (!usesTestDeps(deps)) inflight = run;
  return run;
}

export function startOpsLanes(): void {
  if (timer) return;
  const ms = resolvedConfig().pollS * 1000;
  void collectOnce();
  timer = setInterval(() => { void collectOnce(); }, ms);
  timer.unref?.();
}

export function stopOpsLanes(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function resetOpsLanesForTest(): void {
  stopOpsLanes();
  snapshot = null;
  inflight = null;
}
