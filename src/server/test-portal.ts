/**
 * The countix-testing status portal (GET /api/status, schema 1) inside WaveCode.
 *
 * The portal is tailnet-only with no CORS, so the daemon polls it (every
 * `poll_s`, default 20 s, backing off 20 → 60 → 120 s when it is unreachable)
 * and the Tests page reads the daemon's copy. A `tests.portal` event is
 * emitted only on a material change (queue, active runs, runner health or
 * state, alerts, newest results), never for elapsed time ticking, so the
 * journal stays quiet; the page animates elapsed time from `started_at`.
 *
 * Submitter labels like `wave.countix-dev.claude5` name a WaveCode agent;
 * `agentNameOf` maps them so rows can link to the agent page.
 */

import { createHash } from 'node:crypto';
import { getConfig } from './config.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import { recordJob } from './perf-monitor.js';

export const PORTAL_SCHEMA = 1;
const DEFAULT_POLL_S = 20;
const BACKOFF_S = [20, 60, 120];
const FETCH_TIMEOUT_MS = 10_000;

export interface PortalQueueRow { ticket: string; agent: string; lane: string; tier: string; sha: string; priority: string; wait_s: number | null; wait_min: number | null }
export interface PortalRun { place: string; kind: string; agent: string; lane: string; tier: string; sha: string; started_at: string | null; elapsed_s: number | null; elapsed_min: number | null; expected_s: number; expected_min: number; median_s?: number; median_min?: number; pace?: '' | 'amber' | 'red' }
export interface PortalRunner { name: string; type: string; server_type?: string; role?: string; group?: string; health: string; preflight: string; load: number | null; mem_avail_gb: number | null; disk_used_pct: number | null; state: string; age_s: number | null; age_min: number | null; agent?: string; kind?: string; sha?: string; slots?: Array<{ name: string; state: string }> }
export interface PortalResult { agent: string; tier: string; sha: string; result: string; duration_s: number | null; duration_min: number | null; infra_error: boolean }
export interface PortalScaler { mode: string; eur_today: number | null; cap_eur: number; cap_reached: boolean; desired: number; actual: number }
export interface PortalAlert { name: string; detail: string }
export interface PortalDoc {
  schema: number;
  generated_at: string;
  queue: PortalQueueRow[];
  runs: PortalRun[];
  runners: PortalRunner[];
  results: PortalResult[];
  scaler: PortalScaler;
  alerts: PortalAlert[];
}

export interface PortalState {
  enabled: boolean;
  /** host:port of the portal, for the page header (never a token) */
  host: string | null;
  doc: PortalDoc | null;
  fetched_at: string | null;
  error: string | null;
  /** seconds until the next poll */
  next_in_s: number;
  schema_ok: boolean;
}

interface PortalConfig { url: string; pollS: number }

export function portalConfig(): PortalConfig | null {
  const c = getConfig().test_portal;
  if (!c?.url) return null;
  return { url: c.url.replace(/\/$/, ''), pollS: Math.max(5, c.poll_s ?? DEFAULT_POLL_S) };
}

/** `wave.countix-dev.claude5` → `claude5`; `gate.fable` → null (not a WaveCode submitter). */
export function agentNameOf(label: string | null | undefined): string | null {
  if (!label) return null;
  const m = /^wave\.[^.]+\.([A-Za-z0-9][\w.-]*)$/.exec(label);
  return m ? m[1] : null;
}

function asArray<T>(v: unknown): T[] { return Array.isArray(v) ? (v as T[]) : []; }

/** Keep the fields of the contract; unknown fields are dropped, missing arrays become empty. */
export function normalizeDoc(raw: unknown): PortalDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  const scaler = (d.scaler && typeof d.scaler === 'object' ? d.scaler : {}) as Partial<PortalScaler>;
  return {
    schema: typeof d.schema === 'number' ? d.schema : -1,
    generated_at: typeof d.generated_at === 'string' ? d.generated_at : '',
    queue: asArray<PortalQueueRow>(d.queue),
    runs: asArray<PortalRun>(d.runs),
    runners: asArray<PortalRunner>(d.runners),
    results: asArray<PortalResult>(d.results).slice(0, 50),
    scaler: { mode: scaler.mode ?? 'absent', eur_today: scaler.eur_today ?? null, cap_eur: scaler.cap_eur ?? 0, cap_reached: !!scaler.cap_reached, desired: scaler.desired ?? 0, actual: scaler.actual ?? 0 },
    alerts: asArray<PortalAlert>(d.alerts),
  };
}

/** What counts as a change worth an event: everything except the clocks. Exported for tests. */
export function materialKey(doc: PortalDoc): string {
  const h = createHash('sha1');
  h.update(JSON.stringify({
    q: doc.queue.map((r) => [r.ticket, r.sha, r.tier, r.priority]),
    r: doc.runs.map((r) => [r.place, r.sha, r.tier, r.agent, r.started_at, r.pace ?? '']),
    n: doc.runners.map((r) => [r.name, r.health, r.preflight, r.state]),
    a: doc.alerts.map((a) => [a.name, a.detail]),
    s: doc.results.slice(0, 5).map((r) => [r.sha, r.tier, r.result]),
    c: [doc.scaler.mode, doc.scaler.cap_reached, doc.scaler.desired, doc.scaler.actual],
  }));
  return h.digest('hex');
}

let state: PortalState = { enabled: false, host: null, doc: null, fetched_at: null, error: null, next_in_s: 0, schema_ok: true };
let lastKey: string | null = null;
let failures = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let fetchImpl: typeof fetch = (...a) => fetch(...a);

export function setPortalFetchForTest(f: typeof fetch | null): void { fetchImpl = f ?? ((...a) => fetch(...a)); }
export function resetPortalForTest(): void {
  stopTestPortal();
  state = { enabled: false, host: null, doc: null, fetched_at: null, error: null, next_in_s: 0, schema_ok: true };
  lastKey = null; failures = 0;
}

export function portalState(): PortalState {
  const cfg = portalConfig();
  return { ...state, enabled: !!cfg, host: cfg ? cfg.url.replace(/^https?:\/\//, '') : null };
}

/** One poll. Returns whether the snapshot changed materially. Exported for tests. */
export async function pollPortalOnce(now = Date.now()): Promise<boolean> {
  const cfg = portalConfig();
  if (!cfg) return false;
  const started = Date.now();
  try {
    const res = await fetchImpl(`${cfg.url}/api/status`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = normalizeDoc(await res.json());
    if (!doc) throw new Error('not a JSON object');
    failures = 0;
    const key = materialKey(doc);
    const changed = key !== lastKey;
    lastKey = key;
    state = { ...state, doc, fetched_at: new Date(now).toISOString(), error: null, next_in_s: cfg.pollS, schema_ok: doc.schema === PORTAL_SCHEMA };
    if (doc.schema !== PORTAL_SCHEMA) logger.warn({ schema: doc.schema }, 'Test portal: unexpected schema');
    if (changed) {
      emit('tests.portal', 'system', 'test-portal', {
        queued: doc.queue.length, running: doc.runs.length, runners: doc.runners.length,
        unhealthy: doc.runners.filter((r) => r.health === 'unhealthy').length, alerts: doc.alerts.map((a) => a.name),
      }, null);
    }
    return changed;
  } catch (e) {
    failures += 1;
    const wait = BACKOFF_S[Math.min(failures - 1, BACKOFF_S.length - 1)];
    const message = (e as Error).name === 'TimeoutError' ? 'timeout' : (e as Error).message;
    const wasHealthy = state.error === null;
    state = { ...state, error: message, next_in_s: wait };
    if (wasHealthy) {
      logger.warn({ error: message }, 'Test portal unreachable');
      emit('tests.portal', 'system', 'test-portal', { unavailable: true, error: message }, null);
    }
    return false;
  } finally {
    recordJob('test_portal', Date.now() - started);
  }
}

function schedule(delayS: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void pollPortalOnce().finally(() => schedule(state.next_in_s || portalConfig()?.pollS || DEFAULT_POLL_S)); }, delayS * 1000);
  timer.unref?.();
}

export function startTestPortal(): void {
  if (!portalConfig() || timer) return;
  schedule(2);
}

export function stopTestPortal(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
