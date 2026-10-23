import { WaveCodeApiError, WaveCodeClient } from '../mcp/client.js';
import type { Result } from '../server/db.js';
import { writeLine } from './stdio-guard.js';
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
 * Pause or resume through the daemon bulk route. Named lanes are `{ lanes, reason }`.
 * `--agent --deferred` is `{ agent_id, deferred: true, reason }`. The caller's token
 * is the daemon bearer, so a non-admin is 403 and nothing is written here.
 * Returns the lane ids whose flag changed.
 */
export async function runLaneSyncNoticesCommand(
  action: 'pause' | 'resume',
  lanes: string[],
  opts: LaneSyncCliOpts,
  deps: LaneSyncCliDeps = {},
): Promise<Result<string[]>> {
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
  const body: { lanes: string[]; reason: string } | { agent_id: string; deferred: true; reason: string } =
    named.length > 0
      ? { lanes: named, reason }
      : { agent_id: agent, deferred: true, reason };
  return postBulk(action, body, deps);
}

async function postBulk(
  action: 'pause' | 'resume',
  body: { lanes: string[]; reason: string } | { agent_id: string; deferred: true; reason: string },
  deps: LaneSyncCliDeps,
): Promise<Result<string[]>> {
  const conn = (deps.resolveConnection ?? resolveDaemonConnection)();
  try {
    const client = new WaveCodeClient({ baseUrl: conn.url, token: conn.token, fetchImpl: deps.fetchImpl });
    const data = await client.post<{ lanes?: string[] }>(`/lanes/sync-notices/${action}`, body);
    return { ok: true, data: data.lanes ?? [] };
  } catch (err) {
    if (err instanceof WaveCodeApiError) return { ok: false, error: err.message };
    return { ok: false, error: `WaveCode daemon is not reachable at ${conn.url}. Nothing was changed.` };
  }
}

/** Print the changed lane ids, or exit 1 with the error. Does not touch the database. */
export function presentLaneSyncResult(
  result: Result<string[]>,
  io: {
    stdout?: { write(chunk: string): unknown };
    stderr?: { write(chunk: string): unknown };
    exit?: (code: number) => void;
  } = {},
): void {
  const exit = io.exit ?? ((code: number) => { process.exit(code); });
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  if (!result.ok) {
    stderr.write(result.error.endsWith('\n') ? result.error : `${result.error}\n`);
    exit(1);
    return;
  }
  for (const id of result.data) {
    if (!writeLine(stdout, id)) break;
  }
}
