/**
 * Product Desk (the Countix request board) read into WaveCode.
 *
 * The desk is the board of customer and directed work: requests with a status,
 * target version, candidate SHA, messages and retained original attachments.
 * WaveCode reads it with the per-server dev-lane token (a curl config file,
 * docs/PRODUCT_DESK_AGENT_PROTOCOL.md) and links each request to what it knows:
 * the lanes frozen for that desk number, the WaveCode tasks that carry
 * `[desk <id>]`, and open fixes. A person can turn a request into a WaveCode
 * task for an agent; the originals are never copied — an agent fetches them
 * itself per the protocol, and a person may view one through a streamed proxy
 * that stores nothing.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from './config.js';
import { type Result } from './db.js';
import { linksFromIndex, loadDeskWork, type DeskLinks } from './desk-tracking.js';
import logger from './logger.js';

export type DeskStatus = 'new' | 'accepted' | 'implementing' | 'waiting_on_requester' | 'in_review' | 'shipped' | 'merged' | 'deferred' | 'rejected' | string;

export interface DeskItem {
  id: number;
  status: DeskStatus;
  title: string;
  area: string | null;
  priority: string | null;
  target_version: string | null;
  source: string | null;
  requester_name: string | null;
  received_at: string | null;
  updated_at: string | null;
  file_count: number;
  message_count: number;
  last_agent: string | null;
  last_summary: string | null;
  merged_into_id: number | null;
}

export type DeskLink = DeskLinks;

export interface DeskItemLinked extends DeskItem {
  links: DeskLink;
}

export interface DeskFile { id: number | string; name: string; size: number | null; mime: string | null }

export interface DeskDetail {
  request: DeskItem & { candidate_sha: string | null; note: string | null; requester_email: string | null; created_at: string | null };
  messages: Array<{ id: number | string; direction: string | null; from_name: string | null; from_email: string | null; received_at: string | null; subject: string | null; body_text: string | null }>;
  events: Array<{ id: number | string; created_at: string | null; kind: string | null; from_status: string | null; to_status: string | null; body: string | null; version: string | null; release_sha: string | null; user_name: string | null }>;
  files: DeskFile[];
  links: DeskLink;
}

export const OPEN_STATUSES = new Set(['new', 'accepted', 'implementing', 'waiting_on_requester', 'in_review']);

export function deskConfig() {
  const c = getConfig().product_desk ?? {};
  const expand = (p: string) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
  return {
    enabled: c.enabled ?? false,
    url: (c.url ?? 'https://countix.ai/api/product-desk').replace(/\/$/, ''),
    tokenFile: expand(c.token_file ?? '~/.config/countix-desk/curl.conf'),
    pollMin: c.poll_min ?? 5,
    project: c.project ?? null,
  };
}

/** The Authorization header value from the curl config (`header = "Authorization: Bearer …"`). Never logged. */
function readAuthHeader(tokenFile: string): string | null {
  try {
    const text = fs.readFileSync(tokenFile, 'utf-8');
    const m = /Authorization:\s*(Bearer\s+\S+)/i.exec(text);
    return m ? m[1].replace(/["']+$/, '') : null;
  } catch {
    return null;
  }
}

export type DeskFetch = typeof fetch;
let deskFetch: DeskFetch = (...args) => fetch(...args);
export function setDeskFetchForTest(f: DeskFetch | null): void {
  deskFetch = f ?? ((...args) => fetch(...args));
}

async function deskGet<T>(apiPath: string): Promise<Result<T>> {
  const cfg = deskConfig();
  const auth = readAuthHeader(cfg.tokenFile);
  if (!auth) return { ok: false, error: `Product Desk token not readable (${cfg.tokenFile})` };
  try {
    const res = await deskFetch(`${cfg.url}${apiPath}`, { headers: { Authorization: auth, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      const hint = res.status === 401 ? 'token invalid, expired or revoked — ask SystemOps for rotation' : res.status === 403 ? 'route not allowed for this token' : res.statusText;
      return { ok: false, error: `Product Desk ${res.status}: ${hint}` };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (e) {
    return { ok: false, error: `Product Desk unreachable: ${(e as Error).message}` };
  }
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function toItem(r: Record<string, unknown>): DeskItem | null {
  const id = num(r.id);
  if (id === null) return null;
  return {
    id,
    status: str(r.status) ?? 'unknown',
    title: str(r.title) ?? `#${id}`,
    area: str(r.area),
    priority: str(r.priority),
    target_version: str(r.target_version),
    source: str(r.source),
    requester_name: str(r.requester_name),
    received_at: str(r.received_at),
    updated_at: str(r.updated_at),
    file_count: num(r.file_count) ?? 0,
    message_count: num(r.message_count) ?? 0,
    last_agent: str(r.last_agent),
    last_summary: str(r.last_summary),
    merged_into_id: num(r.merged_into_id),
  };
}

// --- cache ------------------------------------------------------------------------------------

let cache: { at: number; items: DeskItem[] } | null = null;
let lastError: string | null = null;

export function resetDeskForTest(): void {
  cache = null;
  lastError = null;
}

/** Seed the board cache. The bulk lane filter reads deferred desks from here, never the network. */
export function setDeskCacheForTest(items: DeskItem[] | null, now = Date.now()): void {
  cache = items ? { at: now, items } : null;
  lastError = null;
}

/** The whole board, cached for poll_min minutes; `force` refetches. */
export async function fetchBoard(force = false, now = Date.now()): Promise<Result<DeskItem[]>> {
  const cfg = deskConfig();
  if (!force && cache && now - cache.at < cfg.pollMin * 60_000) return { ok: true, data: cache.items };
  const r = await deskGet<unknown>('/requests');
  if (!r.ok) {
    lastError = r.error;
    logger.warn({ error: r.error }, 'Product Desk list failed');
    return cache ? { ok: true, data: cache.items } : r;
  }
  const rows = Array.isArray(r.data) ? r.data : Array.isArray((r.data as { requests?: unknown[] })?.requests) ? (r.data as { requests: unknown[] }).requests : [];
  const items = rows.map((x) => (x && typeof x === 'object' ? toItem(x as Record<string, unknown>) : null)).filter((x): x is DeskItem => !!x);
  cache = { at: now, items };
  lastError = null;
  return { ok: true, data: items };
}

/** The last board read, or null before the first fetch (the overview must never block on the network). */
export function cachedBoard(): DeskItem[] | null {
  return cache?.items ?? null;
}

/** Keep the cache warm in the background: a fetch every poll_min while enabled. */
let refreshTimer: NodeJS.Timeout | null = null;
export function startDeskRefresh(): void {
  const cfg = deskConfig();
  if (!cfg.enabled || refreshTimer) return;
  void fetchBoard(true).catch(() => {});
  refreshTimer = setInterval(() => { void fetchBoard(true).catch(() => {}); }, Math.max(1, cfg.pollMin) * 60_000);
  logger.info({ url: cfg.url, poll_min: cfg.pollMin }, 'Product Desk reads started');
}
export function stopDeskRefresh(): void {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

export function deskState(): { enabled: boolean; cached_at: string | null; error: string | null } {
  return { enabled: deskConfig().enabled, cached_at: cache ? new Date(cache.at).toISOString() : null, error: lastError };
}

// --- links to what WaveCode knows ---------------------------------------------------------------

export function deskTaskMarker(id: number): string {
  return `[desk ${id}]`;
}

/** Lanes, tasks, and the runs and reviews that inherit this desk number from a task. */
export function linksFor(id: number): DeskLink {
  return linksFromIndex(loadDeskWork(), id);
}

export async function listDesk(opts: { all?: boolean; force?: boolean } = {}): Promise<Result<DeskItemLinked[]>> {
  const r = await fetchBoard(opts.force === true);
  if (!r.ok) return r;
  const work = loadDeskWork();
  const items = (opts.all ? r.data : r.data.filter((i) => OPEN_STATUSES.has(i.status)))
    .map((i) => ({ ...i, links: linksFromIndex(work, i.id) }));
  return { ok: true, data: items };
}

export async function getDeskDetail(id: number): Promise<Result<DeskDetail>> {
  const r = await deskGet<Record<string, unknown>>(`/requests/${id}`);
  if (!r.ok) return r;
  const raw = r.data;
  const req = (raw.request && typeof raw.request === 'object' ? raw.request : raw) as Record<string, unknown>;
  const item = toItem(req);
  if (!item) return { ok: false, error: `Product Desk request ${id}: unexpected shape` };
  const list = (k: string): Record<string, unknown>[] => (Array.isArray(raw[k]) ? (raw[k] as unknown[]).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);
  return {
    ok: true,
    data: {
      request: { ...item, candidate_sha: str(req.candidate_sha), note: str(req.note), requester_email: str(req.requester_email), created_at: str(req.created_at) },
      messages: list('messages').map((m) => ({
        id: num(m.id) ?? String(m.id ?? ''), direction: str(m.direction), from_name: str(m.from_name), from_email: str(m.from_email),
        received_at: str(m.received_at), subject: str(m.subject), body_text: typeof m.body_text === 'string' ? m.body_text.slice(0, 6000) : null,
      })),
      events: list('events').map((e) => ({
        id: num(e.id) ?? String(e.id ?? ''), created_at: str(e.created_at), kind: str(e.kind), from_status: str(e.from_status), to_status: str(e.to_status),
        body: typeof e.body === 'string' ? e.body.slice(0, 2000) : null, version: str(e.version), release_sha: str(e.release_sha), user_name: str(e.user_name),
      })),
      files: list('files').map((f) => ({
        id: num(f.id) ?? String(f.id ?? ''),
        name: str(f.name) ?? str(f.filename) ?? str(f.original_name) ?? `file-${String(f.id ?? '')}`,
        size: num(f.size) ?? num(f.bytes) ?? num(f.size_bytes),
        mime: str(f.mime) ?? str(f.mime_type) ?? str(f.content_type),
      })),
      links: linksFor(id),
    },
  };
}

/** Stream one retained original to a person (never stored here). The caller checks the user. */
export async function openDeskFile(fileId: string): Promise<Result<{ body: ReadableStream<Uint8Array> | null; contentType: string; disposition: string | null }>> {
  if (!/^\d{1,10}$/.test(fileId)) return { ok: false, error: 'invalid file id' };
  const cfg = deskConfig();
  const auth = readAuthHeader(cfg.tokenFile);
  if (!auth) return { ok: false, error: `Product Desk token not readable (${cfg.tokenFile})` };
  try {
    const res = await deskFetch(`${cfg.url}/files/${fileId}`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return { ok: false, error: `Product Desk ${res.status}: ${res.statusText}` };
    return { ok: true, data: { body: res.body, contentType: res.headers.get('content-type') ?? 'application/octet-stream', disposition: res.headers.get('content-disposition') } };
  } catch (e) {
    return { ok: false, error: `Product Desk unreachable: ${(e as Error).message}` };
  }
}

/** The prompt a WaveCode task gets when a person hands a desk request to an agent. */
export function taskPromptFor(d: DeskDetail, note: string | null): string {
  const r = d.request;
  const inbound = [...d.messages].reverse().find((m) => (m.direction ?? '').toLowerCase().includes('in')) ?? d.messages[d.messages.length - 1];
  const body = (inbound?.body_text ?? '').trim().slice(0, 2500);
  return [
    `${deskTaskMarker(r.id)} ${r.title}`,
    '',
    `Product Desk request #${r.id} — status ${r.status}${r.area ? ` · area ${r.area}` : ''}${r.priority ? ` · priority ${r.priority}` : ''}${r.target_version ? ` · target ${r.target_version}` : ''}${r.requester_name ? ` · requester ${r.requester_name}` : ''}.`,
    body ? `\nRequest text:\n${body}` : null,
    r.note ? `\nStaff note: ${r.note.slice(0, 1000)}` : null,
    d.files.length ? `\nAttachments (${d.files.length}): ${d.files.map((f) => `${f.name} (file ${f.id})`).join(', ')}. Fetch them yourself with curl -K ~/.config/countix-desk/curl.conf per docs/PRODUCT_DESK_AGENT_PROTOCOL.md; never copy an original into the repo, the room or the Library.` : null,
    note ? `\nFrom the person: ${note.slice(0, 1000)}` : null,
    '',
    'Read the full card first (GET /requests/' + r.id + '). Work on your lane, freeze with the exact SHA, get an independent review, then PATCH the desk to in_review with the candidate SHA and a customer-facing summary (agent-operating-rules §3, §3a).',
  ].filter((l) => l !== null).join('\n');
}
