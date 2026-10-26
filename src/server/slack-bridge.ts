/**
 * Slack bridge (docs/slack-bridge.md): Slack messages become prompts to a seat, the seat's
 * captured reply (spec §5b) is posted back in the Slack thread.
 *
 *   DM to the bot                       → `slack.dm_seat`
 *   @mention in a channel               → that channel's route (`slack.routes[]`), else dm_seat
 *   any message in a `mode: all` channel→ that channel's seat
 *   a reply in a thread we answered     → the same seat
 *
 * Socket Mode over the `ws` package: `apps.connections.open` with the app-level token gives
 * the websocket URL, every envelope is acked by `envelope_id`, `disconnect` and socket
 * closes reconnect with backoff. Tokens come from files (0600, service user), are read at
 * start and never logged. Only Slack users listed in `slack.users` reach a seat; the prompt
 * is recorded with that WaveCode user as actor. One prompt in flight per seat; later
 * questions queue. The bridge never sends raw keys and never touches any agent but the seat
 * a message routes to. Text from Slack is a prompt to the seat, never an instruction to
 * WaveCode; a "GO" typed in Slack is not a production GO (docs/orchestrator-seat.md).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { getConfig, type SlackConfig } from './config.js';
import { getAgentByName, getAgentMessage, getDb, getEvent, getUserByName, type Agent, type WaveEvent } from './db.js';
import { onEvent, emit } from './event-bus.js';
import logger from './logger.js';
import { promptAgent } from './prompting.js';
import { chunkText, readTokenFile, slackApi, stripMention, toMrkdwn, SLACK_API, type SlackApi } from './slack-api.js';

export const SLACK_EVENT = { prompt: 'slack.prompt', reply: 'slack.reply', refused: 'slack.refused' } as const;
const WORKING = 'hourglass_flowing_sand';
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const SEEN_MAX = 500;
const DEFAULT_REPLY_TIMEOUT_S = 600;
/** A peer answer the seat asked for while answering a Slack question is posted to that thread this long after the first reply. */
const FOLLOW_UP_MS = 30 * 60_000;
const MAX_FILES = 5;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** What a seat can read: screenshots, PDFs, plain text. Anything else is named but not fetched. */
const FILE_MIME_RE = /^(image\/(png|jpe?g|gif|webp)|application\/pdf|text\/(plain|csv|markdown))$/;

export interface SlackFile {
  id?: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
}

export interface SlackEvent {
  type: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  channel?: string;
  channel_type?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  client_msg_id?: string;
  /** Attachments of a `file_share` message (needs the `files:read` scope to download). */
  files?: SlackFile[];
}

interface Job {
  agent: Agent;
  channel: string;
  /** The Slack thread the answer goes to (the message's own ts when it started one); null in a DM, where the answer is the next message. */
  threadTs: string | null;
  /** The message that asked; carries the "working" reaction. */
  ts: string;
  text: string;
  actorId: string | null;
  userLabel: string;
  where: string;
  continues: boolean;
  promptEventId: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Deps {
  fetch: typeof fetch;
  WebSocketCtor: typeof WebSocket;
  now: () => number;
  /** Where Slack attachments are saved for the seat to read: `<inboxRoot>/<channel>/<ts>-<name>`. */
  inboxRoot: string;
}
const defaultDeps = (): Deps => ({ fetch, WebSocketCtor: WebSocket, now: Date.now, inboxRoot: path.join(os.homedir(), 'inbox', 'slack') });
let deps: Deps = defaultDeps();

let api: SlackApi | null = null;
let appToken: string | null = null;
let botUserId: string | null = null;
let socket: WebSocket | null = null;
let stopped = true;
let reconnectMs = RECONNECT_MIN_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;
const inflight = new Map<string, Job>();
const queued = new Map<string, Job[]>();
const byPrompt = new Map<number, Job>();
/** Finished jobs by seat, so a peer question the seat asks right after answering still maps to the thread. */
const recent = new Map<string, { job: Job; at: number }>();
/** Peer question id → the Slack thread whose answer is waiting for it. */
const peerThreads = new Map<string, { job: Job; at: number }>();
const seen: string[] = [];
const threads = new Map<string, string>(); // `${channel}:${thread_ts}` → agent name

function slackConfig(): SlackConfig | null {
  const s = getConfig().slack;
  return s && typeof s === 'object' ? s : null;
}

function ensureKv(): void {
  getDb().exec('CREATE TABLE IF NOT EXISTS kv_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
}

function rememberThread(channel: string, threadTs: string, seat: string): void {
  threads.set(`${channel}:${threadTs}`, seat);
  try {
    ensureKv();
    getDb().prepare('INSERT INTO kv_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(`slack:thread:${channel}:${threadTs}`, seat);
  } catch { /* memory only */ }
}

function threadSeat(channel: string, threadTs: string | undefined): string | null {
  if (!threadTs) return null;
  const hit = threads.get(`${channel}:${threadTs}`);
  if (hit) return hit;
  try {
    const row = getDb().prepare('SELECT value FROM kv_settings WHERE key = ?').get(`slack:thread:${channel}:${threadTs}`) as { value: string } | undefined;
    if (row) { threads.set(`${channel}:${threadTs}`, row.value); return row.value; }
  } catch { /* none */ }
  return null;
}

function markSeen(key: string): boolean {
  if (seen.includes(key)) return false;
  seen.push(key);
  if (seen.length > SEEN_MAX) seen.shift();
  return true;
}

export interface Route { seat: string; where: string; continues: boolean; users?: string[] }

/** Which seat answers this event, or null when the bridge should stay quiet. */
export function routeFor(ev: SlackEvent, cfg: SlackConfig, bot: string | null = botUserId): Route | null {
  const channel = ev.channel ?? '';
  const mentioned = ev.type === 'app_mention' || (!!bot && (ev.text ?? '').includes(`<@${bot}`));
  const route = (cfg.routes ?? []).find((r) => r.channel === channel);
  const where = ev.channel_type === 'im' ? 'DM' : `#${route?.name ?? channel}`;
  const continuing = threadSeat(channel, ev.thread_ts);
  if (continuing) return { seat: continuing, where, continues: true, users: route?.users };
  if (ev.channel_type === 'im') return cfg.dm_seat ? { seat: cfg.dm_seat, where, continues: false } : null;
  if (route && (route.mode === 'all' || mentioned)) return { seat: route.seat, where, continues: false, users: route.users };
  if (mentioned && cfg.dm_seat) return { seat: cfg.dm_seat, where, continues: false };
  return null;
}

async function post(channel: string, threadTs: string | null, text: string): Promise<boolean> {
  if (!api) return false;
  for (const chunk of chunkText(toMrkdwn(text))) {
    const r = await api.postMessage({ channel, text: chunk, thread_ts: threadTs });
    if (!r.ok) { logger.warn({ channel, error: r.error }, 'Slack post failed'); return false; }
  }
  return true;
}

/** Handle one Slack event (already acked). Exported for tests. */
export async function handleEvent(ev: SlackEvent): Promise<void> {
  const cfg = slackConfig();
  if (!cfg || !ev.channel || !ev.ts) return;
  if (ev.bot_id || (ev.subtype && ev.subtype !== 'file_share') || !ev.user || ev.user === botUserId) return;
  if (ev.type !== 'message' && ev.type !== 'app_mention') return;
  // A mention in a channel arrives as app_mention and as message: once is enough.
  if (!markSeen(ev.client_msg_id ?? `${ev.channel}:${ev.ts}`)) return;
  const route = routeFor(ev, cfg);
  if (!route) return;
  // A DM is one conversation with the seat: answers are plain messages, not a thread under each question.
  const threadTs = ev.channel_type === 'im' ? null : (ev.thread_ts ?? ev.ts);
  const userName = cfg.users?.[ev.user];
  if (!userName) {
    emit(SLACK_EVENT.refused, 'slack', `${ev.channel}:${ev.ts}`, { slack_user: ev.user, channel: ev.channel }, null);
    await post(ev.channel, threadTs, 'Sorry, you are not on WaveCode\'s list. Ask Denis to add your Slack user to `slack.users`.');
    return;
  }
  // A channel with its own list (a private channel for one person) refuses everyone else, listed or not.
  if (route.users && !route.users.includes(ev.user)) {
    emit(SLACK_EVENT.refused, 'slack', `${ev.channel}:${ev.ts}`, { slack_user: ev.user, channel: ev.channel, route: 'users' }, null);
    await post(ev.channel, threadTs, `Sorry, this channel's seat answers only the people listed for it.`);
    return;
  }
  const user = getUserByName(userName);
  const agentRes = getAgentByName(route.seat);
  if (!agentRes.ok) {
    await post(ev.channel, threadTs, `Seat ${route.seat} is not registered in WaveCode (${agentRes.error}).`);
    return;
  }
  const attached = await saveAttachments(ev);
  const text = `${stripMention(ev.text ?? '', botUserId) || (attached ? '(see the attached file)' : '')}${attached}`;
  if (!text) return;
  const job: Job = {
    agent: agentRes.data, channel: ev.channel, threadTs, ts: ev.ts, text,
    actorId: user.ok ? user.data.id : null, userLabel: userName, where: route.where, continues: route.continues,
    promptEventId: null, timer: null,
  };
  if (threadTs) rememberThread(ev.channel, threadTs, route.seat);
  if (inflight.has(job.agent.id)) {
    const q = queued.get(job.agent.id) ?? [];
    q.push(job);
    queued.set(job.agent.id, q);
    await post(ev.channel, threadTs, `Queued: ${route.seat} is still answering an earlier question (${q.length} ahead of you).`);
    return;
  }
  await run(job);
}

async function run(job: Job): Promise<void> {
  inflight.set(job.agent.id, job);
  await api?.addReaction({ channel: job.channel, timestamp: job.ts, name: WORKING });
  // The seat answers in Slack: short, bullets over tables (Slack has no tables or headers).
  const prefix = `[from Slack ${job.where}, ${job.userLabel}${job.continues ? ', same thread' : ''}; answer for Slack: short, bullets, no tables]`;
  const res = await promptAgent({ agent: job.agent, actorId: job.actorId, text: `${prefix} ${job.text}` });
  if (!res.ok) {
    await post(job.channel, job.threadTs, `${job.agent.name} could not take the question: ${res.error}`);
    await finish(job);
    return;
  }
  job.promptEventId = res.prompt_event_id;
  emit(SLACK_EVENT.prompt, 'agent', job.agent.id, { channel: job.channel, thread_ts: job.threadTs, user: job.userLabel, prompt_event_id: job.promptEventId }, job.actorId);
  if (job.promptEventId === null) {
    await post(job.channel, job.threadTs, `${job.agent.name} got the question, but WaveCode could not track the answer; read it in the Command Center.`);
    await finish(job);
    return;
  }
  byPrompt.set(job.promptEventId, job);
  const timeoutS = slackConfig()?.reply_timeout_s ?? DEFAULT_REPLY_TIMEOUT_S;
  job.timer = setTimeout(() => {
    void (async () => {
      if (byPrompt.get(job.promptEventId!) !== job) return;
      await post(job.channel, job.threadTs, `${job.agent.name} has not answered in ${Math.round(timeoutS / 60)} min. The answer, when it comes, is in the Command Center.`);
      await finish(job);
    })();
  }, (timeoutS + 30) * 1000);
}

/**
 * Download what a `file_share` message carries (screenshots of an invoice, a PDF) into the
 * seat's inbox and name the files in the prompt, so the seat can read them before answering.
 * Needs the `files:read` scope; without it Slack refuses and the prompt says the file was not fetched.
 */
async function saveAttachments(ev: SlackEvent): Promise<string> {
  const files = (ev.files ?? []).slice(0, MAX_FILES);
  if (!files.length || !api || !ev.channel || !ev.ts) return '';
  const lines: string[] = [];
  for (const f of files) {
    const name = (f.name ?? f.id ?? 'file').replace(/[^\w.-]+/g, '_').slice(0, 80);
    const mime = f.mimetype ?? 'application/octet-stream';
    if (!f.url_private_download || !FILE_MIME_RE.test(mime) || (f.size ?? 0) > MAX_FILE_BYTES) {
      lines.push(`Attached in Slack but not fetched (${mime}${(f.size ?? 0) > MAX_FILE_BYTES ? ', too large' : ''}): ${name}`);
      continue;
    }
    const got = await api.download(f.url_private_download);
    if (!got.ok) {
      logger.warn({ channel: ev.channel, file: name, error: got.error }, 'Slack file download failed');
      lines.push(`Attached in Slack but WaveCode could not fetch it (${got.error}): ${name}`);
      continue;
    }
    const dir = path.join(deps.inboxRoot, ev.channel);
    const file = path.join(dir, `${ev.ts.replace('.', '-')}-${name}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, got.data, { mode: 0o600 });
      lines.push(`Attached from Slack (${mime}) — read it before answering: ${file}`);
    } catch (e) {
      logger.warn({ file, error: (e as Error).message }, 'Slack file could not be saved');
      lines.push(`Attached in Slack but WaveCode could not save it: ${name}`);
    }
  }
  return lines.length ? `\n${lines.join('\n')}` : '';
}

async function finish(job: Job): Promise<void> {
  if (job.timer) clearTimeout(job.timer);
  if (job.promptEventId !== null) byPrompt.delete(job.promptEventId);
  inflight.delete(job.agent.id);
  recent.set(job.agent.id, { job, at: deps.now() });
  await api?.removeReaction({ channel: job.channel, timestamp: job.ts, name: WORKING });
  const next = queued.get(job.agent.id)?.shift();
  if (next) await run(next);
}

function onBusEvent(event: WaveEvent): void {
  if (!event.payload_json) return;
  if (event.type === 'peer.question') {
    // The seat asked another WaveCode (the production agent) while answering a Slack question:
    // when that answer lands and the seat follows up, the follow-up belongs in the same thread.
    let q: { question_id?: string; from_agent_id?: string | null };
    try { q = JSON.parse(event.payload_json); } catch { return; }
    if (!q.question_id || !q.from_agent_id) return;
    const live = inflight.get(q.from_agent_id) ?? recentJob(q.from_agent_id);
    if (live) peerThreads.set(q.question_id, { job: live, at: deps.now() });
    return;
  }
  if (event.type !== 'message.created') return;
  let payload: { message_type?: string; ref_prompt_event_id?: number | null; truncated?: boolean };
  try { payload = JSON.parse(event.payload_json); } catch { return; }
  if (payload.message_type !== 'reply' || typeof payload.ref_prompt_event_id !== 'number') return;
  const job = byPrompt.get(payload.ref_prompt_event_id);
  if (job) {
    void (async () => {
      const msg = getAgentMessage(event.entity_id);
      const text = msg.ok ? msg.data.message : '(reply could not be read)';
      const posted = await post(job.channel, job.threadTs, payload.truncated ? `(cut short after the reply window)\n${text}` : text);
      if (posted) emit(SLACK_EVENT.reply, 'agent', job.agent.id, { channel: job.channel, thread_ts: job.threadTs, message_id: event.entity_id, chars: text.length }, null);
      await finish(job);
    })();
    return;
  }
  const follow = followUpFor(payload.ref_prompt_event_id);
  if (!follow) return;
  void (async () => {
    const msg = getAgentMessage(event.entity_id);
    if (!msg.ok || !msg.data.message.trim()) return;
    const posted = await post(follow.channel, follow.threadTs, msg.data.message);
    if (posted) emit(SLACK_EVENT.reply, 'agent', follow.agent.id, { channel: follow.channel, thread_ts: follow.threadTs, message_id: event.entity_id, chars: msg.data.message.length, follow_up: true }, null);
  })();
}

function recentJob(agentId: string): Job | null {
  const r = recent.get(agentId);
  if (!r) return null;
  if (deps.now() - r.at > FOLLOW_UP_MS) { recent.delete(agentId); return null; }
  return r.job;
}

/** A reply to a `peer.delivered` prompt (peers.ts) whose question was asked for a Slack thread → that thread, once. */
function followUpFor(promptEventId: number): Job | null {
  const ref = getEvent(promptEventId);
  if (!ref || ref.type !== 'peer.delivered' || !ref.payload_json) return null;
  let p: { question_id?: string; from_agent_id?: string | null };
  try { p = JSON.parse(ref.payload_json); } catch { return null; }
  if (!p.question_id) return null;
  const hit = peerThreads.get(p.question_id);
  if (!hit) return null;
  peerThreads.delete(p.question_id);
  if (deps.now() - hit.at > FOLLOW_UP_MS || hit.job.agent.id !== p.from_agent_id) return null;
  return hit.job;
}

/** One Socket Mode frame: ack by envelope id, then act. Exported for tests. */
export async function handleSocketMessage(raw: string, send: (text: string) => void): Promise<void> {
  let msg: { type?: string; envelope_id?: string; payload?: { event?: SlackEvent }; reason?: string };
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.envelope_id) send(JSON.stringify({ envelope_id: msg.envelope_id }));
  if (msg.type === 'hello') { reconnectMs = RECONNECT_MIN_MS; logger.info('Slack bridge connected'); return; }
  if (msg.type === 'disconnect') { logger.info({ reason: msg.reason }, 'Slack asked to reconnect'); socket?.close(); return; }
  if (msg.type === 'events_api' && msg.payload?.event) {
    try { await handleEvent(msg.payload.event); } catch (e) { logger.warn({ error: (e as Error).message }, 'Slack event failed'); }
  }
}

async function connect(): Promise<void> {
  if (stopped || !appToken) return;
  try {
    const res = await deps.fetch(`${SLACK_API}/apps.connections.open`, { method: 'POST', headers: { authorization: `Bearer ${appToken}`, 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(15_000) });
    const data = (await res.json()) as { ok?: boolean; url?: string; error?: string };
    if (!data.ok || !data.url) throw new Error(data.error ?? `http ${res.status}`);
    const ws = new deps.WebSocketCtor(data.url);
    socket = ws;
    ws.on('message', (buf) => { void handleSocketMessage(buf.toString(), (text) => ws.send(text)); });
    ws.on('close', () => { if (socket === ws) { socket = null; scheduleReconnect(); } });
    ws.on('error', (err) => { logger.warn({ error: err.message }, 'Slack socket error'); });
  } catch (e) {
    logger.warn({ error: (e as Error).message }, 'Slack connect failed');
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (stopped || reconnectTimer) return;
  const wait = reconnectMs;
  reconnectMs = Math.min(RECONNECT_MAX_MS, reconnectMs * 2);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect(); }, wait);
}

async function whoAmI(): Promise<void> {
  if (!api) return;
  const r = await api.call('auth.test', {});
  if (r.ok && typeof r.data.user_id === 'string') botUserId = r.data.user_id;
  else logger.warn({ error: r.ok ? 'no user_id' : r.error }, 'Slack auth.test failed: mentions are matched by event type only');
}

/** Start when `slack` is configured and both token files are readable; otherwise stay idle and say so once. */
export function startSlackBridge(): void {
  const cfg = slackConfig();
  if (!cfg) return;
  appToken = readTokenFile(cfg.app_token_file);
  const botToken = readTokenFile(cfg.bot_token_file);
  if (!appToken || !botToken) {
    logger.warn({ app_token_file: cfg.app_token_file, bot_token_file: cfg.bot_token_file, app: !!appToken, bot: !!botToken }, 'Slack bridge idle: token file missing or empty (SystemOps places them)');
    return;
  }
  api = slackApi(botToken, deps.fetch);
  stopped = false;
  unsubscribe = onEvent(onBusEvent);
  void whoAmI().then(connect);
}

export function stopSlackBridge(): void {
  stopped = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  unsubscribe?.();
  unsubscribe = null;
  socket?.close();
  socket = null;
  for (const job of inflight.values()) if (job.timer) clearTimeout(job.timer);
  inflight.clear();
  queued.clear();
  byPrompt.clear();
  recent.clear();
  peerThreads.clear();
}

export function slackBridgeStatus(): { configured: boolean; connected: boolean; inflight: number; queued: number } {
  return { configured: !!slackConfig(), connected: !!socket && socket.readyState === WebSocket.OPEN, inflight: inflight.size, queued: [...queued.values()].reduce((n, q) => n + q.length, 0) };
}

export function setSlackDepsForTest(d: Partial<Deps> | null): void {
  deps = d ? { ...deps, ...d } : defaultDeps();
}

export function resetSlackBridgeForTest(): void {
  stopSlackBridge();
  api = null;
  appToken = null;
  botUserId = null;
  reconnectMs = RECONNECT_MIN_MS;
  seen.length = 0;
  threads.clear();
}

/** Test seam: run with an API and bot id without a socket. */
export function primeSlackBridgeForTest(opts: { api: SlackApi; botUserId?: string | null }): void {
  api = opts.api;
  botUserId = opts.botUserId ?? null;
  stopped = false;
  unsubscribe?.();
  unsubscribe = onEvent(onBusEvent);
}
