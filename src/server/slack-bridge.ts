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
import WebSocket from 'ws';
import { getConfig, type SlackConfig } from './config.js';
import { getAgentByName, getAgentMessage, getDb, getUserByName, type Agent, type WaveEvent } from './db.js';
import { onEvent, emit } from './event-bus.js';
import logger from './logger.js';
import { promptAgent } from './prompting.js';
import { chunkText, readTokenFile, slackApi, stripMention, SLACK_API, type SlackApi } from './slack-api.js';

export const SLACK_EVENT = { prompt: 'slack.prompt', reply: 'slack.reply', refused: 'slack.refused' } as const;
const WORKING = 'hourglass_flowing_sand';
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const SEEN_MAX = 500;
const DEFAULT_REPLY_TIMEOUT_S = 600;

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
}

interface Job {
  agent: Agent;
  channel: string;
  /** The Slack thread the answer goes to (the message's own ts when it started one). */
  threadTs: string;
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
}
let deps: Deps = { fetch, WebSocketCtor: WebSocket, now: Date.now };

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

export interface Route { seat: string; where: string; continues: boolean }

/** Which seat answers this event, or null when the bridge should stay quiet. */
export function routeFor(ev: SlackEvent, cfg: SlackConfig, bot: string | null = botUserId): Route | null {
  const channel = ev.channel ?? '';
  const mentioned = ev.type === 'app_mention' || (!!bot && (ev.text ?? '').includes(`<@${bot}`));
  const route = (cfg.routes ?? []).find((r) => r.channel === channel);
  const where = ev.channel_type === 'im' ? 'DM' : `#${route?.name ?? channel}`;
  const continuing = threadSeat(channel, ev.thread_ts);
  if (continuing) return { seat: continuing, where, continues: true };
  if (ev.channel_type === 'im') return cfg.dm_seat ? { seat: cfg.dm_seat, where, continues: false } : null;
  if (route && (route.mode === 'all' || mentioned)) return { seat: route.seat, where, continues: false };
  if (mentioned && cfg.dm_seat) return { seat: cfg.dm_seat, where, continues: false };
  return null;
}

async function post(channel: string, threadTs: string | null, text: string): Promise<void> {
  if (!api) return;
  for (const chunk of chunkText(text)) {
    const r = await api.postMessage({ channel, text: chunk, thread_ts: threadTs });
    if (!r.ok) { logger.warn({ channel, error: r.error }, 'Slack post failed'); return; }
  }
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
  const threadTs = ev.thread_ts ?? ev.ts;
  const userName = cfg.users?.[ev.user];
  if (!userName) {
    emit(SLACK_EVENT.refused, 'slack', `${ev.channel}:${ev.ts}`, { slack_user: ev.user, channel: ev.channel }, null);
    await post(ev.channel, threadTs, 'Sorry, you are not on WaveCode\'s list. Ask Denis to add your Slack user to `slack.users`.');
    return;
  }
  const user = getUserByName(userName);
  const agentRes = getAgentByName(route.seat);
  if (!agentRes.ok) {
    await post(ev.channel, threadTs, `Seat ${route.seat} is not registered in WaveCode (${agentRes.error}).`);
    return;
  }
  const text = stripMention(ev.text ?? '', botUserId);
  if (!text) return;
  const job: Job = {
    agent: agentRes.data, channel: ev.channel, threadTs, ts: ev.ts, text,
    actorId: user.ok ? user.data.id : null, userLabel: userName, where: route.where, continues: route.continues,
    promptEventId: null, timer: null,
  };
  rememberThread(ev.channel, threadTs, route.seat);
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
  const prefix = `[from Slack ${job.where}, ${job.userLabel}${job.continues ? ', same thread' : ''}]`;
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

async function finish(job: Job): Promise<void> {
  if (job.timer) clearTimeout(job.timer);
  if (job.promptEventId !== null) byPrompt.delete(job.promptEventId);
  inflight.delete(job.agent.id);
  await api?.removeReaction({ channel: job.channel, timestamp: job.ts, name: WORKING });
  const next = queued.get(job.agent.id)?.shift();
  if (next) await run(next);
}

function onBusEvent(event: WaveEvent): void {
  if (event.type !== 'message.created' || !event.payload_json) return;
  let payload: { message_type?: string; ref_prompt_event_id?: number | null; truncated?: boolean };
  try { payload = JSON.parse(event.payload_json); } catch { return; }
  if (payload.message_type !== 'reply' || typeof payload.ref_prompt_event_id !== 'number') return;
  const job = byPrompt.get(payload.ref_prompt_event_id);
  if (!job) return;
  void (async () => {
    const msg = getAgentMessage(event.entity_id);
    const text = msg.ok ? msg.data.message : '(reply could not be read)';
    await post(job.channel, job.threadTs, payload.truncated ? `(cut short after the reply window)\n${text}` : text);
    emit(SLACK_EVENT.reply, 'agent', job.agent.id, { channel: job.channel, thread_ts: job.threadTs, message_id: event.entity_id, chars: text.length }, null);
    await finish(job);
  })();
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
}

export function slackBridgeStatus(): { configured: boolean; connected: boolean; inflight: number; queued: number } {
  return { configured: !!slackConfig(), connected: !!socket && socket.readyState === WebSocket.OPEN, inflight: inflight.size, queued: [...queued.values()].reduce((n, q) => n + q.length, 0) };
}

export function setSlackDepsForTest(d: Partial<Deps> | null): void {
  deps = d ? { ...deps, ...d } : { fetch, WebSocketCtor: WebSocket, now: Date.now };
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
