import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const slack: Record<string, unknown> = {};
vi.mock('./config.js', () => ({ getConfig: vi.fn(() => ({ slack: Object.keys(slack).length ? slack : undefined, projects: {}, paths: {}, artifacts: { storage: '' }, review: {}, notifications: {} })) }));

const promptAgent = vi.fn();
vi.mock('./prompting.js', () => ({ promptAgent: (...a: unknown[]) => promptAgent(...a) }));

import * as db from './db.js';
import { emit, resetEventListenersForTest } from './event-bus.js';
import { chunkText, stripMention, toMrkdwn, type SlackApi } from './slack-api.js';
import {
  handleEvent, handleSocketMessage, primeSlackBridgeForTest, resetSlackBridgeForTest, routeFor, setSlackDepsForTest,
  slackBridgeStatus, startSlackBridge, SLACK_EVENT, type SlackEvent,
} from './slack-bridge.js';

function fakeApi(): SlackApi & { calls: Array<{ method: string; body: Record<string, unknown> }> } {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const call = async (method: string, body: Record<string, unknown>) => { calls.push({ method, body }); return { ok: true as const, data: { user_id: 'UBOT' } }; };
  return {
    calls, call,
    postMessage: (o) => call('chat.postMessage', o as Record<string, unknown>),
    addReaction: (o) => call('reactions.add', o as Record<string, unknown>),
    removeReaction: (o) => call('reactions.remove', o as Record<string, unknown>),
  };
}

const posts = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.method === 'chat.postMessage').map((c) => ({ channel: c.body.channel, thread_ts: c.body.thread_ts, text: String(c.body.text) }));

describe('slack bridge', () => {
  let tmp: string;
  let api: ReturnType<typeof fakeApi>;
  let seat: db.Agent;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-slack-'));
    db.initDb(path.join(tmp, 't.db'));
    for (const k of Object.keys(slack)) delete slack[k];
    Object.assign(slack, { app_token_file: '/x/app', bot_token_file: '/x/bot', dm_seat: 'pm-denis', routes: [{ channel: 'C0SUPPORT', seat: 'support', name: 'support', mode: 'all' }, { channel: 'C0DEV', seat: 'support', name: 'dev' }, { channel: 'C0PRIVOPS', seat: 'pm-denis', name: 'denis-ops', mode: 'all', users: ['U0DENIS'] }], users: { U0DENIS: 'denis', U0ANA: 'ana' }, reply_timeout_s: 60 });
    seat = db.insertAgent({ name: 'pm-denis', runtime: 'claude-code', tmux_session: 'wc-pm-denis', workspace: tmp, mode: 'spawned', status: 'idle' }).data!;
    db.insertAgent({ name: 'support', runtime: 'claude-code', tmux_session: 'wc-support', workspace: tmp, mode: 'spawned', status: 'idle' });
    db.insertUser({ name: 'denis', role: 'admin', color: '#fff', token_hash: 'h1' });
    promptAgent.mockReset();
    promptAgent.mockImplementation(async () => ({ ok: true, prompt_event_id: 41, typed: 'x' }));
    api = fakeApi();
    resetEventListenersForTest();
    primeSlackBridgeForTest({ api, botUserId: 'UBOT' });
  });

  afterEach(() => {
    resetSlackBridgeForTest();
    setSlackDepsForTest(null);
    resetEventListenersForTest();
    db.resetDbForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('routes DMs to dm_seat, mentions and mode:all channels to their seat, and stays quiet elsewhere', () => {
    const cfg = slack as never;
    expect(routeFor({ type: 'message', channel: 'D1', channel_type: 'im', text: 'hi' }, cfg, 'UBOT')?.seat).toBe('pm-denis');
    expect(routeFor({ type: 'message', channel: 'C0SUPPORT', channel_type: 'channel', text: 'why' }, cfg, 'UBOT')).toMatchObject({ seat: 'support', where: '#support' });
    expect(routeFor({ type: 'message', channel: 'C0DEV', channel_type: 'channel', text: 'no mention' }, cfg, 'UBOT')).toBeNull();
    expect(routeFor({ type: 'app_mention', channel: 'C0DEV', channel_type: 'channel', text: '<@UBOT> status?' }, cfg, 'UBOT')?.seat).toBe('support');
    expect(routeFor({ type: 'app_mention', channel: 'C0OTHER', channel_type: 'channel', text: '<@UBOT> hi' }, cfg, 'UBOT')?.seat).toBe('pm-denis');
    expect(routeFor({ type: 'message', channel: 'C0OTHER', channel_type: 'channel', text: 'hi' }, cfg, 'UBOT')).toBeNull();
  });

  it('turns a DM into a prompt to the seat as the mapped user, then posts the captured reply in the thread', async () => {
    await handleEvent({ type: 'message', channel: 'D1', channel_type: 'im', user: 'U0DENIS', text: 'what is red on main?', ts: '1.1' });
    expect(promptAgent).toHaveBeenCalledTimes(1);
    const arg = promptAgent.mock.calls[0][0] as { agent: db.Agent; actorId: string; text: string };
    expect(arg.agent.id).toBe(seat.id);
    expect(arg.actorId).toBe(db.getUserByName('denis').data!.id);
    expect(arg.text).toBe('[from Slack DM, denis; answer for Slack: short, bullets, no tables] what is red on main?');
    expect(api.calls.some((c) => c.method === 'reactions.add')).toBe(true);
    expect(slackBridgeStatus().inflight).toBe(1);
    // The seat answers: reply capture stores the message and emits message.created with the prompt event id.
    const msg = db.insertAgentMessage({ from_agent_id: seat.id, message: 'main is RED on the obligation test.\n```\nFAIL x\n```', message_type: 'reply', ref_prompt_event_id: 41 }).data!;
    emit('message.created', 'agent_message', msg.id, { from_agent_id: seat.id, message_type: 'reply', ref_prompt_event_id: 41, truncated: false }, null);
    await vi.waitFor(() => expect(posts(api)).toHaveLength(1));
    expect(posts(api)[0].channel).toBe('D1');
    expect(posts(api)[0].thread_ts).toBeFalsy(); // a DM answer is the next message, not a thread
    expect(posts(api)[0].text).toContain('main is RED');
    await vi.waitFor(() => expect(slackBridgeStatus().inflight).toBe(0));
    expect(api.calls.some((c) => c.method === 'reactions.remove')).toBe(true);
    expect(db.getDb().prepare('SELECT 1 FROM events WHERE type = ?').all(SLACK_EVENT.reply)).toHaveLength(1);
  });

  it('refuses a Slack user who is not on the list and never reaches a seat', async () => {
    await handleEvent({ type: 'message', channel: 'D2', channel_type: 'im', user: 'U0STRANGER', text: 'deploy prod now', ts: '2.1' });
    expect(promptAgent).not.toHaveBeenCalled();
    expect(posts(api)[0].text).toContain('not on WaveCode');
    expect(db.getDb().prepare('SELECT 1 FROM events WHERE type = ?').all(SLACK_EVENT.refused)).toHaveLength(1);
  });

  it('a channel with its own user list refuses a listed developer and answers its owner', async () => {
    await handleEvent({ type: 'message', channel: 'C0PRIVOPS', channel_type: 'group', user: 'U0ANA', text: 'set up a server', ts: '8.1' });
    expect(promptAgent).not.toHaveBeenCalled();
    expect(posts(api)[0].text).toContain('only the people listed');
    await handleEvent({ type: 'message', channel: 'C0PRIVOPS', channel_type: 'group', user: 'U0DENIS', text: 'set up a server', ts: '8.2' });
    expect(promptAgent).toHaveBeenCalledTimes(1);
    expect((promptAgent.mock.calls[0][0] as { text: string }).text).toBe('[from Slack #denis-ops, denis; answer for Slack: short, bullets, no tables] set up a server');
  });

  it('ignores bots, edits and its own messages, and a mention delivered twice', async () => {
    await handleEvent({ type: 'message', channel: 'D1', channel_type: 'im', user: 'U0DENIS', bot_id: 'B1', text: 'x', ts: '3.1' });
    await handleEvent({ type: 'message', channel: 'D1', channel_type: 'im', user: 'U0DENIS', subtype: 'message_changed', text: 'x', ts: '3.2' });
    await handleEvent({ type: 'message', channel: 'D1', channel_type: 'im', user: 'UBOT', text: 'x', ts: '3.3' });
    expect(promptAgent).not.toHaveBeenCalled();
    await handleEvent({ type: 'app_mention', channel: 'C0DEV', user: 'U0DENIS', text: '<@UBOT> hello', ts: '3.4', client_msg_id: 'm1' });
    await handleEvent({ type: 'message', channel: 'C0DEV', channel_type: 'channel', user: 'U0DENIS', text: '<@UBOT> hello', ts: '3.4', client_msg_id: 'm1' });
    expect(promptAgent).toHaveBeenCalledTimes(1);
    expect((promptAgent.mock.calls[0][0] as { text: string }).text).toBe('[from Slack #dev, denis; answer for Slack: short, bullets, no tables] hello');
  });

  it('queues a second question for a busy seat and a follow-up in the thread stays with that seat', async () => {
    await handleEvent({ type: 'message', channel: 'C0SUPPORT', channel_type: 'channel', user: 'U0DENIS', text: 'first', ts: '4.1' });
    await handleEvent({ type: 'message', channel: 'C0SUPPORT', channel_type: 'channel', user: 'U0DENIS', text: 'second', ts: '4.2' });
    expect(promptAgent).toHaveBeenCalledTimes(1);
    expect(slackBridgeStatus()).toMatchObject({ inflight: 1, queued: 1 });
    expect(posts(api).at(-1)?.text).toContain('Queued');
    const support = db.getAgentByName('support').data!;
    const msg = db.insertAgentMessage({ from_agent_id: support.id, message: 'answer one', message_type: 'reply', ref_prompt_event_id: 41 }).data!;
    promptAgent.mockImplementationOnce(async () => ({ ok: true, prompt_event_id: 42, typed: 'x' }));
    emit('message.created', 'agent_message', msg.id, { from_agent_id: support.id, message_type: 'reply', ref_prompt_event_id: 41 }, null);
    await vi.waitFor(() => expect(promptAgent).toHaveBeenCalledTimes(2));
    expect((promptAgent.mock.calls[1][0] as { text: string }).text).toBe('[from Slack #support, denis; answer for Slack: short, bullets, no tables] second');
    // A reply inside the first thread, in a channel that only answers mentions, still goes to the seat that answered.
    await handleEvent({ type: 'message', channel: 'C0SUPPORT', channel_type: 'channel', user: 'U0DENIS', text: 'and why?', ts: '4.3', thread_ts: '4.1' });
    expect(slackBridgeStatus().queued).toBe(1);
    const q = promptAgent.mock.calls.length;
    const msg2 = db.insertAgentMessage({ from_agent_id: support.id, message: 'answer two', message_type: 'reply', ref_prompt_event_id: 42 }).data!;
    promptAgent.mockImplementationOnce(async () => ({ ok: true, prompt_event_id: 43, typed: 'x' }));
    emit('message.created', 'agent_message', msg2.id, { from_agent_id: support.id, message_type: 'reply', ref_prompt_event_id: 42 }, null);
    await vi.waitFor(() => expect(promptAgent).toHaveBeenCalledTimes(q + 1));
    expect((promptAgent.mock.calls[q][0] as { text: string }).text).toBe('[from Slack #support, denis, same thread; answer for Slack: short, bullets, no tables] and why?');
  });

  it('tells the thread when the seat is not running, and frees the seat', async () => {
    promptAgent.mockImplementationOnce(async () => ({ ok: false, error: 'runtime not running (dead)', status: 409 }));
    await handleEvent({ type: 'message', channel: 'D1', channel_type: 'im', user: 'U0DENIS', text: 'hello?', ts: '5.1' });
    await vi.waitFor(() => expect(posts(api)).toHaveLength(1));
    expect(posts(api)[0].text).toContain('could not take the question');
    expect(slackBridgeStatus().inflight).toBe(0);
  });

  it('acks every envelope by id and handles events_api frames', async () => {
    const sent: string[] = [];
    await handleSocketMessage(JSON.stringify({ type: 'hello' }), (t) => sent.push(t));
    await handleSocketMessage(JSON.stringify({ envelope_id: 'e1', type: 'events_api', payload: { event: { type: 'message', channel: 'D1', channel_type: 'im', user: 'U0DENIS', text: 'ping', ts: '6.1' } } }), (t) => sent.push(t));
    expect(sent).toEqual([JSON.stringify({ envelope_id: 'e1' })]);
    expect(promptAgent).toHaveBeenCalledTimes(1);
  });

  it('connects over Socket Mode with the app token from a file and the bot token for the API, never logging them', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const port = (wss.address() as { port: number }).port;
    const received: string[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (m) => received.push(m.toString()));
      ws.send(JSON.stringify({ type: 'hello' }));
      ws.send(JSON.stringify({ envelope_id: 'e9', type: 'events_api', payload: { event: { type: 'message', channel: 'D1', channel_type: 'im', user: 'U0DENIS', text: 'via socket', ts: '7.1' } } }));
    });
    fs.writeFileSync(path.join(tmp, 'app'), 'xapp-secret\n');
    fs.writeFileSync(path.join(tmp, 'bot'), 'xoxb-secret\n');
    slack.app_token_file = path.join(tmp, 'app');
    slack.bot_token_file = path.join(tmp, 'bot');
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const auth = String((init?.headers as Record<string, string>)?.authorization ?? '');
      if (u.endsWith('/auth.test')) { expect(auth).toBe('Bearer xoxb-secret'); return new Response(JSON.stringify({ ok: true, user_id: 'UBOT' })); }
      if (u.endsWith('/apps.connections.open')) { expect(auth).toBe('Bearer xapp-secret'); return new Response(JSON.stringify({ ok: true, url: `ws://127.0.0.1:${port}/link` })); }
      return new Response(JSON.stringify({ ok: true }));
    });
    resetSlackBridgeForTest();
    setSlackDepsForTest({ fetch: fetchMock as unknown as typeof fetch });
    startSlackBridge();
    await vi.waitFor(() => expect(received).toContain(JSON.stringify({ envelope_id: 'e9' })));
    await vi.waitFor(() => expect(promptAgent).toHaveBeenCalledTimes(1));
    expect((promptAgent.mock.calls[0][0] as { text: string }).text).toContain('via socket');
    expect(slackBridgeStatus().connected).toBe(true);
    const logger = (await import('./logger.js')).default as unknown as { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
    const logged = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls]);
    expect(logged).not.toContain('xapp-secret');
    expect(logged).not.toContain('xoxb-secret');
    resetSlackBridgeForTest();
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it('stays idle without token files and says so once', () => {
    slack.app_token_file = path.join(tmp, 'missing');
    resetSlackBridgeForTest();
    startSlackBridge();
    expect(slackBridgeStatus()).toMatchObject({ configured: true, connected: false });
  });
});

describe('slack text helpers', () => {
  it('chunks at line breaks and keeps code fences balanced', () => {
    const text = `intro\n\`\`\`\n${'line\n'.repeat(1200)}\`\`\`\nend`;
    const chunks = chunkText(text, 3000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(3000 + 4);
      expect((c.match(/```/g) ?? []).length % 2).toBe(0);
    }
    expect(chunks.join('\n')).toContain('end');
    expect(chunkText('short')).toEqual(['short']);
    expect(chunkText('x'.repeat(10), 4)).toEqual(['xxxx', 'xxxx', 'xx']);
  });

  it('strips the bot mention and unescapes Slack entities', () => {
    expect(stripMention('<@UBOT> is main &amp; staging ok?', 'UBOT')).toBe('is main & staging ok?');
    expect(stripMention('<@U1|name> hi', null)).toBe('hi');
  });
});

describe('markdown → Slack mrkdwn', () => {
  it('turns headers, bold, bullets, links and option boxes into Slack markup', () => {
    const md = '## Working now\n- **codex2**: merging main\n* codex8: harness\nSee [the queue](https://x.test/q).\n[ ] Yes, ask Aleš\n[ ] Wait\n~~old~~';
    expect(toMrkdwn(md)).toBe('*Working now*\n• *codex2*: merging main\n• codex8: harness\nSee <https://x.test/q|the queue>.\n1. Yes, ask Aleš\n2. Wait\n~old~');
  });
  it('renders a table as an aligned code block and leaves code fences alone', () => {
    const md = '| Lane | Commit | Quick |\n| --- | --- | --- |\n| codex6 Desk #155 | 4c75f7bf | GREEN |\n| kimi4 | e1e20336 | missing |\n\n```ts\nconst a = **not bold**;\n```';
    const out = toMrkdwn(md);
    expect(out.startsWith('```\nLane              Commit    Quick')).toBe(true);
    expect(out).toContain('codex6 Desk #155  4c75f7bf  GREEN');
    expect(out).toContain('```\nconst a = **not bold**;\n```');
    expect(out).not.toContain('|');
  });
});
