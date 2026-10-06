/**
 * Peering: ask an agent on ANOTHER WaveCode instance a question and get the
 * answer back as a file + a thread item + a prompt into the asking agent.
 *
 *   dev agent ──ask_peer / #ask deploy/fable──▶ this daemon
 *   this daemon ──POST /api/agents/<fable>/send (peer token)──▶ peer daemon types it into Fable's pane
 *   peer's reply-capture stores Fable's answer as a reply message tied to that prompt
 *   this daemon long-polls the peer's event log (free, no agent tokens), fetches the
 *   answer, writes ~/inbox/answers/<peer>-<agent>-<id>.md, emits peer.answer, and
 *   delivers it into the asking agent's pane when that agent is idle.
 *
 * Scope: the peer token is an ordinary user on the peer; put the answering
 * agent on a profile only that user has, and the token can reach nothing else
 * (docs/peers.md). No credentials cross the wire; only text.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig, type PeerConfig } from './config.js';
import { generateId, getAgent, getDb, type Agent, type Result } from './db.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import * as sessionManager from './session-manager.js';

export interface PeerQuestion {
  id: string;
  peer: string;
  agent: string;             // remote handle as asked
  remote_agent_id: string;
  remote_prompt_event_id: number | null;
  from_agent_id: string | null;
  actor_id: string | null;
  question: string;
  status: 'sent' | 'answered' | 'delivered' | 'failed';
  answer_path: string | null;
  error: string | null;
  created_at: string;
  answered_at: string | null;
}

export const QUESTION_TIMEOUT_MS = 30 * 60_000;
const POLL_WAIT_MS = 30_000;
const POLL_RETRY_MS = 5_000;
let pollIdleMs = 1_000;
/** Test hook: shorten the pause between empty polls. */
export function setPollIdleMsForTest(ms: number | null): void {
  pollIdleMs = ms ?? 1_000;
}
const MAX_QUESTION_CHARS = 8_000;
const DELIVER_CHARS = 3_000;

export function ensurePeerTables(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS peer_questions (
      id TEXT PRIMARY KEY,
      peer TEXT NOT NULL,
      agent TEXT NOT NULL,
      remote_agent_id TEXT NOT NULL,
      remote_prompt_event_id INTEGER,
      from_agent_id TEXT,
      actor_id TEXT,
      question TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'sent',
      answer_path TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      answered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_peer_questions_status ON peer_questions(status, peer);
  `);
}

/** Peers as the UI may see them: never the token. */
export function listPeers(): Array<{ name: string; url: string; agents: string[] | null }> {
  return Object.entries(getConfig().peers ?? {}).map(([name, p]) => ({ name, url: p.url, agents: p.agents ?? null }));
}

export function getPeerQuestion(id: string): PeerQuestion | null {
  return (getDb().prepare('SELECT * FROM peer_questions WHERE id = ?').get(id) as PeerQuestion | undefined) ?? null;
}

export function listPeerQuestions(filter: { status?: string; limit?: number } = {}): PeerQuestion[] {
  const where = filter.status ? 'WHERE status = ?' : '';
  const params: unknown[] = filter.status ? [filter.status] : [];
  return getDb().prepare(`SELECT * FROM peer_questions ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, filter.limit ?? 50) as PeerQuestion[];
}

// --- HTTP to the peer (injectable for tests) ---

export type PeerFetch = typeof fetch;
let peerFetch: PeerFetch = (...args) => fetch(...args);
export function setPeerFetchForTest(f: PeerFetch | null): void {
  peerFetch = f ?? ((...args) => fetch(...args));
}

async function peerApi<T>(peer: PeerConfig, method: 'GET' | 'POST', apiPath: string, body?: unknown): Promise<Result<T>> {
  const url = `${peer.url.replace(/\/$/, '')}/api${apiPath}`;
  try {
    const res = await peerFetch(url, {
      method,
      headers: { Authorization: `Bearer ${peer.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(POLL_WAIT_MS + 15_000),
    });
    const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok) return { ok: false, error: `peer ${res.status}: ${json?.error ?? res.statusText}` };
    return { ok: true, data: json as T };
  } catch (e) {
    return { ok: false, error: `peer unreachable: ${(e as Error).message}` };
  }
}

interface RemoteAgent { id: string; name: string; alias?: string | null; runtime: string; status: string }

async function resolveRemoteAgent(peer: PeerConfig, handle: string): Promise<Result<RemoteAgent>> {
  const agents = await peerApi<RemoteAgent[]>(peer, 'GET', '/agents');
  if (!agents.ok) return agents;
  const h = handle.replace(/^@/, '');
  const found = agents.data.find((a) => a.alias === h) ?? agents.data.find((a) => a.name === h) ?? agents.data.find((a) => a.id === h);
  return found ? { ok: true, data: found } : { ok: false, error: `No agent '${handle}' on peer (visible to the peer token)` };
}

function agentName(id: string): string {
  const a = getAgent(id);
  return a.ok ? a.data.name : id;
}

// --- Asking ---

export async function askPeer(opts: {
  peer: string;
  agent: string;
  question: string;
  fromAgentId?: string | null;
  actorId?: string | null;
  fromLabel?: string | null;
}): Promise<Result<PeerQuestion>> {
  const cfg = getConfig();
  const peer = cfg.peers?.[opts.peer];
  if (!peer) return { ok: false, error: `Unknown peer '${opts.peer}' (configured: ${Object.keys(cfg.peers ?? {}).join(', ') || 'none'})` };
  const handle = opts.agent.replace(/^@/, '');
  if (peer.agents && !peer.agents.includes(handle)) {
    return { ok: false, error: `Peer '${opts.peer}' allows questions to: ${peer.agents.join(', ')}` };
  }
  const question = opts.question.trim();
  if (!question) return { ok: false, error: 'question is required' };
  if (question.length > MAX_QUESTION_CHARS) return { ok: false, error: `question exceeds ${MAX_QUESTION_CHARS} chars` };

  const remote = await resolveRemoteAgent(peer, handle);
  if (!remote.ok) return remote;

  const id = generateId();
  const from = opts.fromLabel ?? (opts.fromAgentId ? agentName(opts.fromAgentId) : 'a person');
  const text = [
    `[Question ${id} from ${os.hostname()}/${from} via WaveCode peering — answer in full in this turn; your reply is relayed verbatim as a file, nobody retypes it]`,
    '',
    question,
  ].join('\n');

  const sent = await peerApi<{ ok: boolean; prompt_event_id?: number | null }>(peer, 'POST', `/agents/${remote.data.id}/send`, { text });
  if (!sent.ok) return { ok: false, error: `Could not deliver to ${opts.peer}/${handle}: ${sent.error}` };

  getDb().prepare(`
    INSERT INTO peer_questions (id, peer, agent, remote_agent_id, remote_prompt_event_id, from_agent_id, actor_id, question, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent')
  `).run(id, opts.peer, remote.data.name, remote.data.id, sent.data.prompt_event_id ?? null, opts.fromAgentId ?? null, opts.actorId ?? null, question);

  emit('peer.question', 'peer', `${opts.peer}/${remote.data.name}`, {
    question_id: id, peer: opts.peer, agent: remote.data.name, from_agent_id: opts.fromAgentId ?? null,
    question: question.substring(0, 2000),
  }, opts.actorId ?? null);
  logger.info({ questionId: id, peer: opts.peer, agent: remote.data.name }, 'Peer question sent');

  ensurePoller(opts.peer);
  return { ok: true, data: getPeerQuestion(id)! };
}

// --- Answers ---

function answersDir(): string {
  return path.join(os.homedir(), 'inbox', 'answers');
}

function writeAnswerFile(q: PeerQuestion, answer: string): string {
  const dir = answersDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${q.peer}-${q.agent}-${q.id}.md`);
  const body = [
    `# Answer from ${q.peer}/${q.agent}`,
    '',
    `- question id: ${q.id}`,
    `- asked: ${q.created_at} UTC${q.from_agent_id ? ` by agent ${agentName(q.from_agent_id)}` : ''}`,
    `- answered: ${new Date().toISOString()}`,
    '',
    '## Question',
    '',
    q.question,
    '',
    '## Answer',
    '',
    answer.trim(),
    '',
  ].join('\n');
  fs.writeFileSync(file, body, { mode: 0o600 });
  return file;
}

const undelivered = new Map<string, string[]>(); // from_agent_id → question ids waiting for an idle pane

function recordAnswer(q: PeerQuestion, answer: string): void {
  const file = writeAnswerFile(q, answer);
  getDb().prepare(`UPDATE peer_questions SET status = 'answered', answer_path = ?, answered_at = datetime('now') WHERE id = ?`).run(file, q.id);
  emit('peer.answer', 'peer', `${q.peer}/${q.agent}`, {
    question_id: q.id, peer: q.peer, agent: q.agent, from_agent_id: q.from_agent_id,
    answer_path: file, answer: answer.substring(0, 4000), question: q.question.substring(0, 300),
  }, null);
  logger.info({ questionId: q.id, file }, 'Peer answer stored');
  if (q.from_agent_id) deliverOrQueue(q.id, q.from_agent_id);
}

function deliverOrQueue(questionId: string, agentId: string): void {
  const agent = getAgent(agentId);
  if (!agent.ok) return;
  if (agent.data.status === 'working') {
    const list = undelivered.get(agentId) ?? [];
    if (!list.includes(questionId)) list.push(questionId);
    undelivered.set(agentId, list);
    return;
  }
  deliver(questionId, agent.data);
}

function deliver(questionId: string, agent: Agent): void {
  const q = getPeerQuestion(questionId);
  if (!q || q.status !== 'answered' || !q.answer_path) return;
  let answer = '';
  try {
    answer = fs.readFileSync(q.answer_path, 'utf8').split('## Answer\n\n')[1] ?? '';
  } catch { /* file gone: deliver the pointer only */ }
  const clipped = answer.length > DELIVER_CHARS ? `${answer.substring(0, DELIVER_CHARS)}\n…(full answer in the file)` : answer;
  const text = `[Answer from ${q.peer}/${q.agent} to your question "${q.question.substring(0, 80).replace(/\s+/g, ' ')}"] Full text: ${q.answer_path}\n\n${clipped}`;
  const sent = sessionManager.sendKeys(agent.id, text);
  if (sent.ok) {
    getDb().prepare(`UPDATE peer_questions SET status = 'delivered' WHERE id = ?`).run(q.id);
  } else {
    logger.warn({ questionId: q.id, error: sent.error }, 'Peer answer could not be typed into the asking agent (file is in place)');
  }
}

/** Output-watcher hook: an agent went idle — hand it any answers that arrived while it worked. */
export function onAgentIdle(agentId: string): void {
  const list = undelivered.get(agentId);
  if (!list?.length) return;
  undelivered.delete(agentId);
  const agent = getAgent(agentId);
  if (!agent.ok) return;
  for (const id of list) deliver(id, agent.data);
}

function fail(q: PeerQuestion, error: string): void {
  getDb().prepare(`UPDATE peer_questions SET status = 'failed', error = ? WHERE id = ?`).run(error, q.id);
  emit('peer.failed', 'peer', `${q.peer}/${q.agent}`, { question_id: q.id, peer: q.peer, agent: q.agent, from_agent_id: q.from_agent_id, error }, null);
}

// --- Agents without MCP ask by printing a line: `ASK deploy/fable: <question>` ---

const ASK_LINE_RE = /^[\s•>›⏺*-]*ASK\s+([a-z][a-z0-9_-]*)\/(@?[\w.-]+):\s*(.{8,})$/;
/** The example in docs/agent-operating-rules.md — never a real question, even when an agent cats the file. */
const RULES_EXAMPLE_QUESTION = 'How many invoices were booked for tenant X in September 2026, and with which VAT codes?';
const ASK_SCAN_LINES = 80;
const seenAsks = new Map<string, Set<string>>(); // agentId → hashes of ASK lines already acted on

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/**
 * Output-watcher hook on an idle tick: an `ASK peer/agent: question` line the
 * agent printed becomes a peer question from that agent. Deduplicated per
 * agent (memory) and against questions it asked in the last 24h (db), so a
 * line that stays on screen fires once. Errors are typed back so the agent
 * learns what went wrong instead of waiting forever.
 */
export function detectAskLines(agentId: string, output: string): void {
  if (!Object.keys(getConfig().peers ?? {}).length) return;
  const lines = stripAnsi(output).split('\n').slice(-ASK_SCAN_LINES);
  for (const raw of lines) {
    const m = ASK_LINE_RE.exec(raw.trimEnd());
    if (!m) continue;
    const [, peer, agentHandle, questionRaw] = m;
    const question = questionRaw.trim();
    if (question === RULES_EXAMPLE_QUESTION) continue;
    const key = createHash('sha1').update(`${peer}/${agentHandle}:${question}`).digest('hex');
    const seen = seenAsks.get(agentId) ?? new Set<string>();
    if (seen.has(key)) continue;
    seen.add(key);
    seenAsks.set(agentId, seen);
    const recent = getDb().prepare(`
      SELECT 1 FROM peer_questions WHERE from_agent_id = ? AND question = ? AND created_at > datetime('now', '-1 day') LIMIT 1
    `).get(agentId, question);
    if (recent) continue;
    void askPeer({ peer, agent: agentHandle, question, fromAgentId: agentId, actorId: null }).then((r) => {
      if (!r.ok) {
        logger.warn({ agentId, peer, agent: agentHandle, error: r.error }, 'ASK line could not be sent');
        sessionManager.sendKeys(agentId, `[ASK ${peer}/${agentHandle} failed: ${r.error}]`);
      }
    });
  }
}

/** Test hook. */
export function resetAskDetectionForTest(): void {
  seenAsks.clear();
}

// --- Polling the peer's event log (one loop per peer while questions are open) ---

const pollers = new Map<string, { stop: boolean }>();

function openQuestions(peer: string): PeerQuestion[] {
  return getDb().prepare(`SELECT * FROM peer_questions WHERE peer = ? AND status = 'sent' ORDER BY created_at ASC`).all(peer) as PeerQuestion[];
}

export function ensurePoller(peer: string): void {
  if (pollers.has(peer)) return;
  const state = { stop: false };
  pollers.set(peer, state);
  void pollLoop(peer, state).finally(() => pollers.delete(peer));
}

interface RemoteEvent { id: number; type: string; entity_id: string; payload: Record<string, unknown> | null }
interface RemoteMessage { id: string; message: string; from_agent_id: string | null; ref_prompt_event_id: number | null }

async function pollLoop(peerName: string, state: { stop: boolean }): Promise<void> {
  const peer = getConfig().peers?.[peerName];
  if (!peer) return;
  let cursor: number | null = null;
  while (!state.stop) {
    const open = openQuestions(peerName);
    if (open.length === 0) return;

    // time out stale questions
    const now = Date.now();
    for (const q of open) {
      if (now - new Date(`${q.created_at.replace(' ', 'T')}Z`).getTime() > QUESTION_TIMEOUT_MS) fail(q, `no answer within ${QUESTION_TIMEOUT_MS / 60_000} minutes`);
    }
    const live = openQuestions(peerName);
    if (live.length === 0) return;

    // Replies are always logged after their prompt: start from the oldest open prompt
    if (cursor === null) cursor = Math.max(0, Math.min(...live.map((q) => q.remote_prompt_event_id ?? 0)) - 1);

    const res: Result<{ events: RemoteEvent[]; last_id: number }> = await peerApi(
      peer, 'GET', `/events/log?since=${cursor}&wait_ms=${POLL_WAIT_MS}&types=message.created`,
    );
    if (!res.ok) {
      logger.warn({ peer: peerName, error: res.error }, 'Peer poll failed; retrying');
      await sleep(POLL_RETRY_MS);
      continue;
    }
    cursor = res.data.last_id ?? cursor;

    const replies = res.data.events.filter((e) => e.payload?.message_type === 'reply');
    if (replies.length === 0) {
      // A peer that answers the long-poll immediately (short wait_ms, old version) must not be hammered
      await sleep(pollIdleMs);
      continue;
    }
    const byPrompt = new Map<number, RemoteEvent>();
    for (const e of replies) {
      const ref = e.payload?.ref_prompt_event_id;
      if (typeof ref === 'number') byPrompt.set(ref, e);
    }
    const hits = live.filter((q) => q.remote_prompt_event_id !== null && byPrompt.has(q.remote_prompt_event_id));
    if (hits.length === 0) continue;

    const messages = await peerApi<RemoteMessage[]>(peer, 'GET', '/messages?limit=200');
    if (!messages.ok) {
      logger.warn({ peer: peerName, error: messages.error }, 'Peer messages fetch failed; retrying');
      continue;
    }
    for (const q of hits) {
      const ev = byPrompt.get(q.remote_prompt_event_id!)!;
      const msg = messages.data.find((m) => m.id === ev.entity_id);
      if (!msg) continue; // not visible yet; next poll
      recordAnswer(q, msg.message);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Boot: resume polling for any question still open after a restart. */
export function startPeerPollers(): void {
  const peers = (getDb().prepare(`SELECT DISTINCT peer FROM peer_questions WHERE status = 'sent'`).all() as Array<{ peer: string }>).map((r) => r.peer);
  for (const p of peers) ensurePoller(p);
}

export function stopPeerPollers(): void {
  for (const s of pollers.values()) s.stop = true;
  pollers.clear();
}
