/**
 * `wavecode retro <room>` (spec §5f): ask the daemon to run the room's retro
 * now — the seat lives in the daemon's tmux, so this goes over HTTP.
 */

import { WaveCodeClient } from '../mcp/client.js';
import type { Result } from '../server/db.js';
import { resolveDaemonConnection } from './daemon-connection.js';

export interface RetroStarted {
  seat: string;
  evidence: string;
  activity: number;
}

export async function runRetroCommand(room: string, client?: WaveCodeClient): Promise<Result<RetroStarted>> {
  const c = client ?? (() => {
    const conn = resolveDaemonConnection();
    return new WaveCodeClient({ baseUrl: conn.url, token: conn.token });
  })();
  try {
    return { ok: true, data: await c.post<RetroStarted>(`/rooms/${encodeURIComponent(room)}/retro`, {}) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function formatRetroStarted(room: string, r: RetroStarted): string {
  return `Retro for ${room} started on ${r.seat} (evidence: ${r.evidence}, ${r.activity} items). Its proposals will appear in the review queue.`;
}
