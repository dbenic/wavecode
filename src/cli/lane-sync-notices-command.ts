import type { Result } from '../server/db.js';
import { pauseDeferredLanes, pauseSyncNotices, resumeDeferredLanes, resumeSyncNotices } from '../server/lane-sync-notices.js';

export interface LaneSyncCliOpts {
  agent?: string;
  deferred?: boolean;
  reason?: string;
}

/**
 * `wavecode lane sync-notices pause|resume <lane...>`
 * or `--agent <id> --deferred --reason "..."`.
 * Returns the lane ids whose flag changed. The CLI prints them, one per line.
 */
export function runLaneSyncNoticesCli(action: 'pause' | 'resume', lanes: string[], opts: LaneSyncCliOpts): Result<string[]> {
  const named = (lanes ?? []).map((lane) => lane.trim()).filter(Boolean);
  const agent = opts.agent?.trim() ?? '';
  const deferred = opts.deferred === true;
  if (named.length > 0 && (agent || deferred)) {
    return { ok: false, error: 'name lanes or pass --agent and --deferred, not both' };
  }
  if (named.length === 0 && !agent && !deferred) {
    return { ok: false, error: 'name at least one lane, or pass --agent and --deferred' };
  }
  if (named.length === 0 && agent && !deferred) return { ok: false, error: '--deferred is required with --agent' };
  if (named.length === 0 && deferred && !agent) return { ok: false, error: '--agent is required with --deferred' };
  const reason = opts.reason ?? '';
  if (named.length > 0) {
    return action === 'pause'
      ? pauseSyncNotices(named, 'cli', reason, null)
      : resumeSyncNotices(named, 'cli', reason, null);
  }
  return action === 'pause'
    ? pauseDeferredLanes(agent, 'cli', reason, null)
    : resumeDeferredLanes(agent, 'cli', reason, null);
}
