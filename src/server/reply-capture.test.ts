/**
 * Reply capture lifecycle (spec §5b) against a real SQLite file; only the
 * pane (session-manager.capturePane) is simulated.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const paneHarness = vi.hoisted(() => ({ text: '', calls: 0 }));

vi.mock('./session-manager.js', () => ({
  capturePane: vi.fn(() => {
    paneHarness.calls++;
    return { ok: true, data: paneHarness.text };
  }),
}));

vi.mock('./logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ANSWER = '> what is chatgpt-countix doing?\n\n● It is running the invoices suite for T12.\n\n❯ \n  ⏵⏵ bypass permissions on';

describe('reply-capture.ts', () => {
  let tmpDir: string;
  let db: typeof import('./db.js');
  let rc: typeof import('./reply-capture.js');
  let pm: import('./db.js').Agent;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-reply-'));
    db = await import('./db.js');
    db.resetDbForTest();
    db.initDb(path.join(tmpDir, 'test.db'));
    rc = await import('./reply-capture.js');
    rc.resetReplyCaptureForTest();
    paneHarness.text = '';
    paneHarness.calls = 0;
    const a = db.insertAgent({ name: 'pm', runtime: 'claude-code', tmux_session: 'wc-pm', workspace: '/w/pm', mode: 'spawned', status: 'idle' });
    if (!a.ok) throw new Error(a.error);
    pm = a.data;
  });

  afterEach(() => {
    db.resetDbForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const replies = () => db.listAgentMessages({}).filter((m) => m.message_type === 'reply');

  it('on the working → idle edge stores the reply with the prompt actor and emits message.created', () => {
    rc.trackPrompt({ agent: pm, actorId: 'u-ana', prompt: 'what is chatgpt-countix doing?', promptEventId: 42, now: 1000 });
    paneHarness.text = ANSWER;
    expect(rc.onAgentIdle(pm.id, { transitioned: true, outputChanged: true, now: 2000 })).toBe(true);

    expect(replies()).toEqual([expect.objectContaining({
      from_agent_id: pm.id,
      to_agent_id: null,
      workspace: '/w/pm',
      message: 'It is running the invoices suite for T12.',
      message_type: 'reply',
      ref_prompt_actor: 'u-ana',
      ref_prompt_event_id: 42,
      truncated: 0,
    })]);
    const ev = db.listEvents().find((e) => e.type === 'message.created');
    expect(JSON.parse(ev!.payload_json!)).toMatchObject({ message_type: 'reply', ref_prompt_actor: 'u-ana', ref_prompt_event_id: 42 });
    expect(rc.getPendingReply(pm.id)).toBeUndefined();
  });

  it('ref_task_id is set only when dispatch passes it — a chat prompt during an open run is still a chat prompt', () => {
    const task = db.insertTask({ prompt: 'T12', created_by: 'u-ana' });
    if (!task.ok) throw new Error(task.error);
    db.insertRun({ task_id: task.data.id, agent_id: pm.id });

    rc.trackPrompt({ agent: pm, actorId: 'u-ana', prompt: 'what is chatgpt-countix doing?' });
    paneHarness.text = ANSWER;
    rc.onAgentIdle(pm.id, { transitioned: true, outputChanged: false });
    expect(replies()[0].ref_task_id).toBeNull();

    rc.trackPrompt({ agent: pm, actorId: 'u-ana', prompt: 'what is chatgpt-countix doing?', taskId: task.data.id });
    rc.onAgentIdle(pm.id, { transitioned: true, outputChanged: false });
    expect(replies()[1].ref_task_id).toBe(task.data.id);
  });

  it('a task dispatch closes out a pending chat prompt as truncated instead of stealing the run output', () => {
    rc.trackPrompt({ agent: pm, actorId: 'u-ana', prompt: 'what is the deploy status?', promptEventId: 9 });
    paneHarness.text = '❯ ';
    rc.clearPendingForDispatch(pm);
    expect(rc.getPendingReply(pm.id)).toBeUndefined();
    expect(replies()).toEqual([expect.objectContaining({ ref_prompt_event_id: 9, truncated: 1 })]);
  });

  it('no answer yet (only the echo) keeps waiting', () => {
    rc.trackPrompt({ agent: pm, actorId: 'u-ana', prompt: 'what is chatgpt-countix doing?' });
    paneHarness.text = '> what is chatgpt-countix doing?\n\n❯ ';
    expect(rc.onAgentIdle(pm.id, { transitioned: true, outputChanged: false })).toBe(false);
    expect(rc.getPendingReply(pm.id)).toBeDefined();
  });

  it('quiet idle (no working edge) resolves only after 6s, on a stable pane, with the echo found', () => {
    paneHarness.text = '● Something unrelated.\n❯ '; // what was on screen when the prompt went out
    rc.trackPrompt({ agent: pm, actorId: 'u-ana', prompt: 'what is chatgpt-countix doing?', now: 0 });
    paneHarness.text = ANSWER;
    expect(rc.onAgentIdle(pm.id, { transitioned: false, outputChanged: false, now: 3_000 })).toBe(false); // too soon
    expect(rc.onAgentIdle(pm.id, { transitioned: false, outputChanged: true, now: 7_000 })).toBe(false);  // still streaming
    paneHarness.text = '● Something unrelated.'; // the pre-prompt text again → not a new answer
    expect(rc.onAgentIdle(pm.id, { transitioned: false, outputChanged: false, now: 7_000 })).toBe(false);
    paneHarness.text = ANSWER;
    expect(rc.onAgentIdle(pm.id, { transitioned: false, outputChanged: false, now: 7_000 })).toBe(true);
    expect(replies()).toHaveLength(1);
  });

  it('an agent that answers but keeps working: the reply is posted once stable for 6s (no idle edge)', () => {
    rc.trackPrompt({ agent: pm, actorId: 'u-ana', prompt: 'what is chatgpt-countix doing?', promptEventId: 5, now: 1000 });
    paneHarness.text = ANSWER + '\n✻ Cogitated for 4s · done 11:28 PM\n◦ Working (3h 02m • esc to interrupt) · 2 background terminals running';
    expect(rc.onAgentTick(pm.id, { now: 2000 })).toBe(false);   // first sighting
    expect(rc.onAgentTick(pm.id, { now: 5000 })).toBe(false);   // stable, but < 6s
    expect(rc.onAgentTick(pm.id, { now: 8500 })).toBe(true);    // stable ≥ 6s and the turn ended → posted
    expect(replies()).toEqual([expect.objectContaining({ ref_prompt_event_id: 5, truncated: 0 })]);
    expect(replies()[0].message).toMatch(/invoices suite/);
  });

  it('a mid-turn pause is never posted as the reply: the turn-end marker is required while working', () => {
    rc.trackPrompt({ agent: pm, actorId: 'u-ana', prompt: 'get me the open bug table', promptEventId: 7, now: 1000 });
    paneHarness.text = [
      '> get me the open bug table',
      '',
      "● I'll check how many documents share this issue before building the table.",
      '  Starting the extraction baseline in the background before answering:',
      '● Running extraction gate… (12s)',
    ].join('\n');
    expect(rc.onAgentTick(pm.id, { now: 2000 })).toBe(false);
    expect(rc.onAgentTick(pm.id, { now: 9000 })).toBe(false);   // stable for 7s but no "✻ … done" → still working
    expect(rc.onAgentTick(pm.id, { now: 16000 })).toBe(false);
    expect(replies()).toEqual([]);
    paneHarness.text += '\n● Here is the table: 4 open bugs.\n\n✻ Worked for 2m 10s · done 10:41 AM';
    expect(rc.onAgentTick(pm.id, { now: 17000 })).toBe(false);  // new text → clock restarts
    expect(rc.onAgentTick(pm.id, { now: 24000 })).toBe(true);
    expect(replies()[0].message).toMatch(/Here is the table/);
  });

  it("the previous turn's end marker above the echo does not end the new turn: a Codex preamble is not the reply", () => {
    const ins = db.insertAgent({ name: 'codex1', runtime: 'codex', tmux_session: 'wc-codex1', workspace: '/w/codex1', mode: 'spawned', status: 'working' });
    if (!ins.ok) throw new Error(ins.error);
    const codex = ins.data;
    rc.trackPrompt({ agent: codex, actorId: 'u-ana', prompt: 'Update the PD-108 spec with the review findings', promptEventId: 9, now: 1000 });
    paneHarness.text = [
      '• TO @claude2: Please review my response to your PD-108 findings.',
      '',
      '  Worked for 2m 06s • 10:03 AM',
      '',
      '› Update the PD-108 spec with the review findings',
      '',
      "• I'll update the PD-108 spec with the agreed review findings and classify every planned file.",
      '',
      "• Ran python3 - <<'PY' …",
      '  └ PASS: every original inventory path retained',
      '',
      '  ? for shortcuts',
    ].join('\n');
    expect(rc.onAgentTick(codex.id, { now: 2000 })).toBe(false);
    expect(rc.onAgentTick(codex.id, { now: 9000 })).toBe(false);   // stable 7s, but only the OLD turn's marker is on screen
    expect(rc.onAgentTick(codex.id, { now: 16000 })).toBe(false);
    expect(replies()).toEqual([]);
    paneHarness.text = paneHarness.text.replace('  ? for shortcuts', [
      '• Updated PD-108 specification — revision 2 (/home/wave/.wavecode-data/rooms/wavepulse/REPORTS/2026-10-09-pd108-outgoing-line-vat-',
      '  treatment.md).',
      '',
      '  RESULT: PASS',
      '',
      '  Worked for 6m 41s • 10:15 AM',
      '',
      '› Ask Codex to do anything',
      '',
      '  GPT-6-Astra high · ~/.wavecode-data/worktrees/codex1',
      '  ? for shortcuts',
    ].join('\n'));
    expect(rc.onAgentTick(codex.id, { now: 17000 })).toBe(false);  // new text → clock restarts
    expect(rc.onAgentTick(codex.id, { now: 24000 })).toBe(true);
    expect(replies()).toHaveLength(1);
    expect(replies()[0].message).toMatch(/Updated PD-108 specification/);
    expect(replies()[0].message).not.toMatch(/I'll update/);
  });

  it('a still-changing answer is not posted while working', () => {
    rc.trackPrompt({ agent: pm, actorId: 'u-ana', prompt: 'what is chatgpt-countix doing?', promptEventId: 6, now: 1000 });
    paneHarness.text = ANSWER;
    expect(rc.onAgentTick(pm.id, { now: 2000 })).toBe(false);
    paneHarness.text = ANSWER.replace('for T12.', 'for T12 and T13.') + '\n✻ Worked for 9s · done 10:41 AM'; // text changed → clock restarts
    expect(rc.onAgentTick(pm.id, { now: 9000 })).toBe(false);
    expect(rc.onAgentTick(pm.id, { now: 16000 })).toBe(true);
    expect(replies()).toHaveLength(1);
  });

  it('without a pending prompt the pane is not even captured', () => {
    expect(rc.onAgentIdle(pm.id, { transitioned: true, outputChanged: true })).toBe(false);
    expect(paneHarness.calls).toBe(0);
  });

  it('a newer prompt supersedes the pending one — the first still gets a (truncated) reply, never silence', () => {
    rc.trackPrompt({ agent: pm, actorId: 'u-ana', prompt: 'first?', promptEventId: 1 });
    rc.trackPrompt({ agent: pm, actorId: 'u-bob', prompt: 'what is chatgpt-countix doing?', promptEventId: 2 });
    paneHarness.text = ANSWER;
    rc.onAgentIdle(pm.id, { transitioned: true, outputChanged: false });
    expect(replies()).toEqual([
      expect.objectContaining({ ref_prompt_actor: 'u-ana', ref_prompt_event_id: 1, truncated: 1 }),
      expect.objectContaining({ ref_prompt_actor: 'u-bob', ref_prompt_event_id: 2 }),
    ]);
  });

  it('on the idle edge a PREVIOUS answer (on screen when the prompt was sent) is never mistaken for the reply', () => {
    paneHarness.text = '● Three agents are idle and nothing is blocked.\n❯ '; // the old answer is on screen
    rc.trackPrompt({ agent: pm, actorId: 'u-ana', prompt: 'what is the deploy status?', promptEventId: 3, now: 1000 });
    // echo scrolled off the alternate screen; the pane still shows the old answer
    expect(rc.onAgentIdle(pm.id, { transitioned: true, outputChanged: true, now: 2000 })).toBe(false);
    expect(replies()).toEqual([]);
    expect(rc.getPendingReply(pm.id)).toBeTruthy(); // left for the 10-minute fallback
  });

  it('a long answer whose prompt echo scrolled off the alternate screen is still captured (new text since send)', () => {
    paneHarness.text = '● Three agents are idle and nothing is blocked.\n❯ ';
    rc.trackPrompt({ agent: pm, actorId: 'u-ana', prompt: 'About @chatgpt-countix: status', promptEventId: 4, now: 1000 });
    // 25-line window: no "> About @chatgpt-countix: status" echo visible, only the tail of the new answer
    paneHarness.text = [
      '    the build passing. It also reports that the imports/JCD slice is frozen.',
      '  - Review: I have no RESULT line or review verdict for any of this.',
      '',
      '  Do you want me to check again once the API suite finishes?',
      '  [ ] Check again in about 20 minutes',
      '  [ ] No, I will ask when I need it',
      '',
      '✻ Brewed for 6s · done 8:10 AM',
      '❯ ',
    ].join('\n');
    expect(rc.onAgentIdle(pm.id, { transitioned: true, outputChanged: true, now: 9000 })).toBe(true);
    expect(replies()[0].message).toMatch(/no RESULT line/);
    expect(replies()[0].truncated).toBe(0);
  });

  it('after 10 minutes without idle, posts what is there as truncated — never silence', () => {
    rc.trackPrompt({ agent: pm, actorId: 'u-ana', prompt: 'what is chatgpt-countix doing?', now: 0 });
    paneHarness.text = '> what is chatgpt-countix doing?\n\n● Still checking the invoices suite, partial so far';
    expect(rc.sweepExpiredReplies(rc.REPLY_TIMEOUT_MS - 1)).toEqual([]);
    expect(rc.sweepExpiredReplies(rc.REPLY_TIMEOUT_MS)).toEqual([pm.id]);
    expect(replies()).toEqual([expect.objectContaining({ truncated: 1, message: 'Still checking the invoices suite, partial so far' })]);

    rc.trackPrompt({ agent: pm, actorId: 'u-ana', prompt: 'anything?', now: 0 });
    paneHarness.text = '';
    rc.sweepExpiredReplies(rc.REPLY_TIMEOUT_MS);
    expect(replies()[1].message).toMatch(/no reply captured within 10 minutes/);
  });

  it('a housekeeping prompt (seat brief) superseded unanswered is dropped quietly; a user prompt is not', () => {
    rc.trackPrompt({ agent: pm, actorId: 'u-ana', prompt: 'You are the WaveCode orchestrator seat…', quietIfSuperseded: true });
    paneHarness.text = '> You are the WaveCode orchestrator seat…\n\n❯ ';
    rc.trackPrompt({ agent: pm, actorId: 'u-ana', prompt: 'what is chatgpt-countix doing?' });
    expect(replies()).toEqual([]);
    expect(rc.getPendingReply(pm.id)).toMatchObject({ prompt: 'what is chatgpt-countix doing?' });

    // an answered brief is still kept, and plain prompts keep the "never silence" placeholder
    paneHarness.text = '> You are the WaveCode orchestrator seat…\n\n● Orchestrator seat ready.\n\n❯ ';
    rc.trackPrompt({ agent: pm, actorId: 'u-ana', prompt: 'You are the WaveCode orchestrator seat…', quietIfSuperseded: true });
    rc.trackPrompt({ agent: pm, actorId: 'u-ana', prompt: 'next' });
    expect(replies().map((r) => r.message)).toEqual(expect.arrayContaining(['Orchestrator seat ready.']));
  });

  it('file-runner and login seats are never tracked', () => {
    const file = db.insertAgent({ name: 'f', runtime: 'claude-code', tmux_session: 'file:f', workspace: '/w', mode: 'file', status: 'idle' });
    const login = db.insertAgent({ name: 'l', runtime: 'claude-code', tmux_session: 'wc-login-ana-claude-code', workspace: '/w', mode: 'adopted', status: 'idle' });
    if (!file.ok || !login.ok) throw new Error('agents');
    rc.trackPrompt({ agent: file.data, actorId: 'u', prompt: 'x' });
    rc.trackPrompt({ agent: login.data, actorId: 'u', prompt: 'x' });
    expect(rc.getPendingReply(file.data.id)).toBeUndefined();
    expect(rc.getPendingReply(login.data.id)).toBeUndefined();
  });

  it('captureRunSummary stores the run prose on the run', () => {
    const task = db.insertTask({ prompt: 'fix the eSLOG export', created_by: 'u-ana' });
    if (!task.ok) throw new Error(task.error);
    const run = db.insertRun({ task_id: task.data.id, agent_id: pm.id });
    if (!run.ok) throw new Error(run.error);
    paneHarness.text = '> fix the eSLOG export\n\n● Bash(npm test)\n  ⎿  ok\n\n● Fixed the eSLOG export: VAT rows now round per line. 41 tests pass.\n';
    expect(rc.captureRunSummary(run.data.id, pm.id)).toBe('Fixed the eSLOG export: VAT rows now round per line. 41 tests pass.');
    const stored = db.getRun(run.data.id);
    expect(stored.ok && stored.data.summary).toBe('Fixed the eSLOG export: VAT rows now round per line. 41 tests pass.');
  });

  it('captureRunSummary never throws', () => {
    expect(rc.captureRunSummary('missing-run', pm.id)).toBeNull();
    expect(rc.captureRunSummary('missing-run', 'missing-agent')).toBeNull();
  });

  describe('parseReplyQuestion', () => {
    it('question + [ ] options → chips', () => {
      expect(rc.parseReplyQuestion('Status…\n\nDeploy once review passes?\n[ ] Deploy on pass\n[ ] Hold')).toEqual({
        asks: true, options: ['Deploy on pass', 'Hold'],
      });
      expect(rc.parseReplyQuestion('Pick one?\n- [ ] A\n- [ ] B\n- [ ] C')).toEqual({ asks: true, options: ['A', 'B', 'C'] });
    });

    it('a single chip line [A] [B] also counts', () => {
      expect(rc.parseReplyQuestion('Deploy now?\n[Deploy on pass] [Hold]')).toEqual({ asks: true, options: ['Deploy on pass', 'Hold'] });
    });

    it('a question without options asks, but has no chips; options without a question are ignored', () => {
      expect(rc.parseReplyQuestion('Should I continue?')).toEqual({ asks: true, options: [] });
      expect(rc.parseReplyQuestion('Done.\n[ ] A\n[ ] B')).toEqual({ asks: false, options: [] });
      expect(rc.parseReplyQuestion('All green.')).toEqual({ asks: false, options: [] });
      expect(rc.parseReplyQuestion('Which?\n[ ] only one')).toEqual({ asks: true, options: [] }); // needs 2–4
    });
  });
});
