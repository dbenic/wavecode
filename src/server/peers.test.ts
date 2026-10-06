/**
 * Peering: a question to an agent on another WaveCode instance travels as
 * text, the answer comes back as a file + peer.answer + a prompt into the
 * asking agent (idle-gated). The peer is faked at the fetch boundary.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./event-bus.js', () => ({ emit: vi.fn(() => ({ id: 1 })) }));
vi.mock('./session-manager.js', () => ({ sendKeys: vi.fn(() => ({ ok: true, data: undefined })) }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

const peersCfg: Record<string, { url: string; token: string; agents?: string[] }> = {};
vi.mock('./config.js', () => ({ getConfig: vi.fn(() => ({ peers: peersCfg })) }));

import * as db from './db.js';
import { emit } from './event-bus.js';
import * as sessionManager from './session-manager.js';
import * as peers from './peers.js';

let tmp: string;
let homeSpy: ReturnType<typeof vi.spyOn>;

/** A tiny fake peer: agents, send (returns a prompt event id), event log, messages. */
function fakePeer() {
  const state = { sends: [] as Array<{ agentId: string; text: string }>, events: [] as Array<Record<string, unknown>>, messages: [] as Array<Record<string, unknown>>, nextEvent: 100 };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const auth = (init?.headers as Record<string, string>)?.Authorization;
    if (auth !== 'Bearer peer-token-0123456789') return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    if (url.pathname === '/api/agents') {
      return Response.json([{ id: 'r-fable', name: 'fable', alias: 'fable', runtime: 'claude-code', status: 'idle' }, { id: 'r-other', name: 'deployer', alias: null, runtime: 'codex', status: 'idle' }]);
    }
    const send = /^\/api\/agents\/([^/]+)\/send$/.exec(url.pathname);
    if (send && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { text: string };
      state.sends.push({ agentId: send[1], text: body.text });
      return Response.json({ ok: true, prompt_event_id: state.nextEvent++ });
    }
    if (url.pathname === '/api/events/log') {
      const since = Number(url.searchParams.get('since') ?? 0);
      const events = state.events.filter((e) => (e.id as number) > since);
      return Response.json({ events, last_id: events.length ? events[events.length - 1].id : since });
    }
    if (url.pathname === '/api/messages') return Response.json(state.messages);
    return new Response(JSON.stringify({ error: `no route ${url.pathname}` }), { status: 404 });
  };
  /** Fable answers the prompt with the given event id. */
  const answer = (promptEventId: number, text: string) => {
    const id = `m-${promptEventId}`;
    state.messages.push({ id, message: text, from_agent_id: 'r-fable', ref_prompt_event_id: promptEventId });
    state.events.push({ id: state.nextEvent++, type: 'message.created', entity_type: 'agent_message', entity_id: id, payload: { message_type: 'reply', ref_prompt_event_id: promptEventId, from_agent_id: 'r-fable' } });
  };
  return { state, fetchImpl, answer };
}

beforeEach(() => {
  vi.clearAllMocks();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-peers-'));
  homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
  db.initDb(path.join(tmp, 't.db'));
  peers.ensurePeerTables();
  peers.setPollIdleMsForTest(5);
  for (const k of Object.keys(peersCfg)) delete peersCfg[k];
  peersCfg.deploy = { url: 'http://100.100.165.71:3777', token: 'peer-token-0123456789' };
});
afterEach(() => {
  peers.stopPeerPollers();
  peers.setPollIdleMsForTest(null);
  peers.setPeerFetchForTest(null);
  homeSpy.mockRestore();
  db.resetDbForTest();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function localAgent(name: string, status: 'idle' | 'working' = 'idle'): db.Agent {
  const r = db.insertAgent({ name, runtime: 'codex', tmux_session: `wc-${name}`, workspace: null, mode: 'spawned', status });
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

const flush = () => new Promise((r) => setTimeout(r, 120));

describe('askPeer', () => {
  it('resolves the remote agent by alias, delivers the question with the peer token, records it, emits peer.question', async () => {
    const fp = fakePeer();
    peers.setPeerFetchForTest(fp.fetchImpl);
    const asker = localAgent('codex1');
    const r = await peers.askPeer({ peer: 'deploy', agent: '@fable', question: 'Is the invoices table migrated on staging?', fromAgentId: asker.id, actorId: 'u1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ peer: 'deploy', agent: 'fable', remote_agent_id: 'r-fable', remote_prompt_event_id: 100, status: 'sent', from_agent_id: asker.id });
    expect(fp.state.sends).toHaveLength(1);
    expect(fp.state.sends[0].agentId).toBe('r-fable');
    expect(fp.state.sends[0].text).toContain('Is the invoices table migrated on staging?');
    expect(fp.state.sends[0].text).toMatch(/relayed verbatim/);
    expect(vi.mocked(emit).mock.calls.find((c) => c[0] === 'peer.question')?.[3]).toMatchObject({ question_id: r.data.id, peer: 'deploy', agent: 'fable' });
    expect(peers.listPeers()).toEqual([{ name: 'deploy', url: 'http://100.100.165.71:3777', agents: null }]);
  });

  it('refuses unknown peers, agents outside the allowlist, unknown remote agents and empty questions — nothing is sent', async () => {
    const fp = fakePeer();
    peers.setPeerFetchForTest(fp.fetchImpl);
    expect((await peers.askPeer({ peer: 'nope', agent: 'fable', question: 'x' })).ok).toBe(false);
    peersCfg.deploy.agents = ['fable'];
    const denied = await peers.askPeer({ peer: 'deploy', agent: 'deployer', question: 'deploy prod now' });
    expect(denied).toMatchObject({ ok: false });
    expect((denied as { error: string }).error).toMatch(/allows questions to: fable/);
    expect((await peers.askPeer({ peer: 'deploy', agent: 'ghost', question: 'x' })).ok).toBe(false);
    expect((await peers.askPeer({ peer: 'deploy', agent: 'fable', question: '   ' })).ok).toBe(false);
    expect(fp.state.sends).toHaveLength(0);
  });
});

describe('answers', () => {
  it('stores the answer as a file, emits peer.answer and types it into the idle asking agent', async () => {
    const fp = fakePeer();
    peers.setPeerFetchForTest(fp.fetchImpl);
    const asker = localAgent('codex1');
    const r = await peers.askPeer({ peer: 'deploy', agent: 'fable', question: 'Which migration is current?', fromAgentId: asker.id });
    if (!r.ok) throw new Error(r.error);
    fp.answer(100, 'Current migration on staging is 2026_10_05_invoices_v3. Applied cleanly.');
    await flush();

    const q = peers.getPeerQuestion(r.data.id)!;
    expect(q.status).toBe('delivered');
    expect(q.answer_path).toMatch(new RegExp(`${tmp}/inbox/answers/deploy-fable-${r.data.id}\\.md$`));
    const file = fs.readFileSync(q.answer_path!, 'utf8');
    expect(file).toContain('## Question\n\nWhich migration is current?');
    expect(file).toContain('## Answer\n\nCurrent migration on staging is 2026_10_05_invoices_v3.');
    expect(vi.mocked(emit).mock.calls.find((c) => c[0] === 'peer.answer')?.[3]).toMatchObject({ question_id: r.data.id, answer_path: q.answer_path, from_agent_id: asker.id });
    const typed = vi.mocked(sessionManager.sendKeys).mock.calls.find((c) => c[0] === asker.id)?.[1] as string;
    expect(typed).toMatch(/^\[Answer from deploy\/fable to your question "Which migration is current\?"\] Full text: /);
    expect(typed).toContain('Applied cleanly.');
  });

  it('holds the answer while the asker is working and delivers on its idle edge', async () => {
    const fp = fakePeer();
    peers.setPeerFetchForTest(fp.fetchImpl);
    const asker = localAgent('codex1', 'working');
    const r = await peers.askPeer({ peer: 'deploy', agent: 'fable', question: 'q?', fromAgentId: asker.id });
    if (!r.ok) throw new Error(r.error);
    fp.answer(100, 'a.');
    await flush();
    expect(peers.getPeerQuestion(r.data.id)!.status).toBe('answered');
    expect(vi.mocked(sessionManager.sendKeys)).not.toHaveBeenCalled();

    db.updateAgentStatus(asker.id, 'idle');
    peers.onAgentIdle(asker.id);
    expect(vi.mocked(sessionManager.sendKeys)).toHaveBeenCalledTimes(1);
    expect(peers.getPeerQuestion(r.data.id)!.status).toBe('delivered');
  });

  it('a question from a person (no asking agent) is answered to the file and thread only', async () => {
    const fp = fakePeer();
    peers.setPeerFetchForTest(fp.fetchImpl);
    const r = await peers.askPeer({ peer: 'deploy', agent: 'fable', question: 'status?', actorId: 'u1', fromLabel: 'denis' });
    if (!r.ok) throw new Error(r.error);
    expect(fp.state.sends[0].text).toContain('/denis via WaveCode peering');
    fp.answer(100, 'all green');
    await flush();
    expect(peers.getPeerQuestion(r.data.id)!.status).toBe('answered');
    expect(vi.mocked(sessionManager.sendKeys)).not.toHaveBeenCalled();
  });

  it('times out an unanswered question and emits peer.failed', async () => {
    const fp = fakePeer();
    peers.setPeerFetchForTest(fp.fetchImpl);
    const r = await peers.askPeer({ peer: 'deploy', agent: 'fable', question: 'q?' });
    if (!r.ok) throw new Error(r.error);
    peers.stopPeerPollers();
    db.getDb().prepare(`UPDATE peer_questions SET created_at = datetime('now', '-31 minutes') WHERE id = ?`).run(r.data.id);
    peers.ensurePoller('deploy');
    await flush();
    expect(peers.getPeerQuestion(r.data.id)!.status).toBe('failed');
    expect(vi.mocked(emit).mock.calls.find((c) => c[0] === 'peer.failed')?.[3]).toMatchObject({ question_id: r.data.id });
  });
});

describe('ASK lines in agent output', () => {
  it('an "ASK deploy/fable: …" line becomes a question from that agent, once; the docs example and malformed lines are ignored', async () => {
    peers.resetAskDetectionForTest();
    const fp = fakePeer();
    peers.setPeerFetchForTest(fp.fetchImpl);
    const asker = localAgent('codex1');
    const pane = [
      '• Checking the invoice flow…',
      '    ASK deploy/fable: How many invoices were booked for tenant X in September 2026, and with which VAT codes?', // the rules example
      'ASK deploy/fable: How many invoices has tenant GenePlanet booked in September 2026, by VAT code?',
      'ASK nowhere: nothing',
      '› ',
    ].join('\n');
    peers.detectAskLines(asker.id, pane);
    peers.detectAskLines(asker.id, pane); // same screen on the next tick
    await flush();
    expect(fp.state.sends).toHaveLength(1);
    expect(fp.state.sends[0].text).toContain('How many invoices has tenant GenePlanet booked in September 2026, by VAT code?');
    const qs = peers.listPeerQuestions();
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({ from_agent_id: asker.id, peer: 'deploy', agent: 'fable', status: 'sent' });

    // after a restart (memory cleared) the 24h db check still prevents a repeat
    peers.resetAskDetectionForTest();
    peers.detectAskLines(asker.id, pane);
    await flush();
    expect(fp.state.sends).toHaveLength(1);
  });

  it('a failing ASK (unknown peer) is typed back to the agent so it does not wait forever', async () => {
    peers.resetAskDetectionForTest();
    const asker = localAgent('codex1');
    peers.detectAskLines(asker.id, 'ASK staging/fable: is the db migrated?');
    await flush();
    const typed = vi.mocked(sessionManager.sendKeys).mock.calls.find((c) => c[0] === asker.id)?.[1] as string;
    expect(typed).toMatch(/^\[ASK staging\/fable failed: Unknown peer 'staging'/);
  });
});

describe('one open prompt per remote agent', () => {
  it('a second question to the same agent waits until the first is answered, then is sent', async () => {
    const fp = fakePeer();
    peers.setPeerFetchForTest(fp.fetchImpl);
    const a = await peers.askPeer({ peer: 'deploy', agent: 'fable', question: 'first: which migration is current?' });
    const b = await peers.askPeer({ peer: 'deploy', agent: 'fable', question: 'second: how many invoices yesterday?' });
    if (!a.ok || !b.ok) throw new Error('ask failed');
    expect(a.data.status).toBe('sent');
    expect(b.data.status).toBe('queued');
    expect(fp.state.sends).toHaveLength(1);
    fp.answer(a.data.remote_prompt_event_id!, 'v3');
    await flush(); await flush();
    expect(peers.getPeerQuestion(a.data.id)!.status).toBe('answered');
    expect(fp.state.sends).toHaveLength(2);
    expect(fp.state.sends[1].text).toContain('second: how many invoices yesterday?');
    expect(peers.getPeerQuestion(b.data.id)!.status).toBe('sent');
  });

  it('a release GO carries the human attribution header, never the question header', async () => {
    const fp = fakePeer();
    peers.setPeerFetchForTest(fp.fetchImpl);
    const r = await peers.askPeer({ peer: 'deploy', agent: 'fable', question: 'Release request — run r1, lane wc-claude1 at abc123.', fromLabel: 'denis', kind: 'release' });
    if (!r.ok) throw new Error(r.error);
    expect(fp.state.sends[0].text).toMatch(/^\[Release GO from denis via WaveCode Promote on /);
    expect(fp.state.sends[0].text).not.toContain('[Question ');
    expect(vi.mocked(emit).mock.calls.some((c) => c[0] === 'peer.release')).toBe(true);
  });
});
