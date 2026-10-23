import { WaveCodeApiError, WaveCodeClient } from '../mcp/client.js';
import type { Result } from '../server/db.js';
import { pauseDeferredLanes, pauseSyncNotices, resumeDeferredLanes, resumeSyncNotices } from '../server/lane-sync-notices.js';
import { resolveDaemonConnection } from './daemon-connection.js';

export interface LaneSyncCliOpts {
  agent?: string;
  deferred?: boolean;
  reason?: string;
}

export interface LaneSyncCliDeps {
  fetchImpl?: typeof fetch;
  resolveConnection?: () => { url: string; token: string | null };
}

/**
 * Named lanes go to the bulk endpoint as `{ lanes, reason }`, so a slash in
 * `claude1/foo` is not a path segment. A daemon that cannot be reached is
 * applied locally with the same list. `--agent --deferred` stays local.
 * Returns the lane ids whose flag changed.
 */
export async function runLaneSyncNoticesCommand(
  action: 'pause' | 'resume',
  lanes: string[],
  opts: LaneSyncCliOpts,
  deps: LaneSyncCliDeps = {},
): Promise<Result<string[]>> {
  const named = (lanes ?? []).map((lane) => lane.trim()).filter(Boolean);
  if (named.length > 0 && !opts.agent && opts.deferred !== true) {
    const posted = await postLaneList(action, named, opts.reason ?? '', deps);
    if (posted) return posted;
  }
  return runLaneSyncNoticesCli(action, lanes, opts);
}

async function postLaneList(
  action: 'pause' | 'resume',
  lanes: string[],
  reason: string,
  deps: LaneSyncCliDeps,
): Promise<Result<string[]> | null> {
  const conn = (deps.resolveConnection ?? resolveDaemonConnection)();
  try {
    const client = new WaveCodeClient({ baseUrl: conn.url, token: conn.token, fetchImpl: deps.fetchImpl });
    const data = await client.post<{ lanes?: string[] }>(`/lanes/sync-notices/${action}`, { lanes, reason });
    return { ok: true, data: data.lanes ?? [] };
  } catch (err) {
    if (err instanceof WaveCodeApiError) return { ok: false, error: err.message };
    return null;
  }
}

/**
 * Local apply. `wavecode lane sync-notices pause|resume <lane...>`
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
