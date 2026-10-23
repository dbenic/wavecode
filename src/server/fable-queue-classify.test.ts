import { describe, expect, it } from 'vitest';
import {
  alertsForBot,
  buildPipeline,
  classifyPane,
  expectedReceiptNames,
  fallbackMatch,
  pairInbox,
  parseBriefName,
  parseReceiptName,
  redactSecrets,
  stagesNamedIn,
} from './fable-queue-classify.js';
import { defaultFableBots, resolveFableQueue } from './fable-queue-config.js';

const MIN = 60;

describe('classifyPane', () => {
  it('reads the Claude Code footer and ignores older scrollback', () => {
    expect(classifyPane('working on it\nesc to interrupt')).toBe('working');
    expect(classifyPane('esc to interrupt · 1 message queued')).toBe('working');
    expect(classifyPane('2 messages queued')).toBe('queued');
    expect(classifyPane('(queued)')).toBe('queued');
    expect(classifyPane('Do you want to proceed?\n❯ 1. Yes')).toBe('waiting_input');
    expect(classifyPane('apply this change? y/n')).toBe('waiting_input');
    expect(classifyPane('esc to interrupt\nDo you want to allow this?')).toBe('waiting_input');
    expect(classifyPane('❯')).toBe('idle');
    expect(classifyPane('>')).toBe('idle');
    expect(classifyPane('the review queue is empty\n> fix the bug')).toBe('unknown');
    expect(classifyPane('')).toBe('unknown');
    const scrolled = ['esc to interrupt', ...Array(12).fill(''), '❯'].join('\n');
    expect(classifyPane(scrolled)).toBe('idle');
  });
});

describe('redactSecrets', () => {
  it('strips tokens, keys, and password values and leaves the footer alone', () => {
    expect(redactSecrets('password=hunter2')).toBe('password=[redacted]');
    expect(redactSecrets('token: sk-do-not-leak')).toBe('token: [redacted]');
    expect(redactSecrets('api_key=sk-ant-api03-supersecret')).toBe('api_key=[redacted]');
    expect(redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payloadxx.signaturex')).toBe('Authorization: Bearer [redacted]');
    expect(redactSecrets('key sk-live-not-a-real-key and ghp_1234567890abcdef')).not.toMatch(/sk-live|ghp_/);
    const sha = 'a'.repeat(40);
    expect(redactSecrets(`esc to interrupt\n${sha}`)).toBe(`esc to interrupt\n${sha}`);
    expect(redactSecrets('password=hunter2')).not.toContain('hunter2');
  });
});

describe('inbox pairing', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  const onboard = 'maestro-to-fable4-onboard-1644.md';
  const priority = 'maestro-to-fable-145-priority-1643.md';
  const prodw = 'fable-prodw-roles-20261023.md';
  const staged = 'fable4-145-staged-20261023.md';
  const secret = 'password=hunter2 do not return this line';
  const expectedLines = [
    secret,
    'Expected receipt: /home/ci/outbox/fable-prodw-roles-20261023.md',
    'Expected receipt: /home/ci/outbox/fable4-145-staged-20261023.md',
  ];

  it('parses bot and topic and drops the time and date suffixes', () => {
    expect(parseBriefName(onboard)).toMatchObject({ bot: 'fable4', tokens: ['onboard'] });
    expect(parseBriefName(priority)).toMatchObject({ bot: 'fable', tokens: ['145', 'priority'] });
    expect(parseReceiptName(prodw)).toMatchObject({ bot: 'fable', tokens: ['prodw', 'roles'] });
    expect(parseReceiptName(staged)).toMatchObject({ bot: 'fable4', tokens: ['145', 'staged'] });
    expect(parseBriefName(onboard)?.tokens).not.toContain('1644');
    expect(parseReceiptName(staged)?.tokens).not.toContain('20261023');
  });

  it('is done only when every Expected receipt line exists, and ignores every other line', () => {
    const names = expectedReceiptNames(expectedLines);
    expect(names).toEqual([prodw, staged]);
    expect(JSON.stringify(names)).not.toContain('hunter2');

    const partial = pairInbox(
      [{ name: onboard, mtimeMs: now - 1000 }],
      [{ name: prodw, mtimeMs: now }],
      now,
      { [onboard]: names },
    );
    expect(partial.briefs[0]).toMatchObject({
      name: onboard,
      status: 'pending',
      match: 'exact',
      expected: [
        { name: prodw, status: 'present' },
        { name: staged, status: 'missing' },
      ],
    });
    expect(partial.pending.map((brief) => brief.name)).toEqual([onboard]);
    expect(partial.unpaired).toEqual([]);

    const done = pairInbox(
      [{ name: onboard, mtimeMs: now - 1000 }],
      [
        { name: prodw, mtimeMs: now - 50 },
        { name: staged, mtimeMs: now },
      ],
      now,
      { [onboard]: names },
    );
    expect(done.briefs[0].status).toBe('done');
    expect(done.briefs[0].expected?.every((item) => item.status === 'present')).toBe(true);
    expect(done.pending).toEqual([]);
    expect(done.current).toBeNull();
    // An expected list does not fall back onto a same-bot topic match.
    const listed = pairInbox(
      [{ name: onboard, mtimeMs: now - 1000 }],
      [{ name: 'fable4-onboard-20261023.md', mtimeMs: now }],
      now,
      { [onboard]: names },
    );
    expect(listed.briefs[0].status).toBe('pending');
    expect(listed.briefs[0].match).toBe('exact');
  });

  it('falls back to the same bot plus a shared topic token, ignoring the clock suffixes', () => {
    expect(fallbackMatch(onboard, 'fable4-onboard-20261023.md')).toBe(true);
    expect(fallbackMatch(priority, 'fable-145-priority-20261023.md')).toBe(true);
    expect(fallbackMatch(priority, staged)).toBe(false);
    expect(fallbackMatch(onboard, staged)).toBe(false);
    expect(fallbackMatch(priority, prodw)).toBe(false);
    expect(fallbackMatch(onboard, prodw)).toBe(false);

    const paired = pairInbox(
      [
        { name: onboard, mtimeMs: now - 2000 },
        { name: priority, mtimeMs: now - 1000 },
      ],
      [
        { name: 'fable4-onboard-20261023.md', mtimeMs: now - 100 },
        { name: 'fable-145-priority-20261023.md', mtimeMs: now - 50 },
      ],
      now,
    );
    expect(paired.briefs.map((brief) => [brief.name, brief.status, brief.match])).toEqual([
      [onboard, 'paired', 'fallback'],
      [priority, 'paired', 'fallback'],
    ]);
    expect(paired.pending).toEqual([]);
    expect(paired.unpaired).toEqual([]);
  });

  it('leaves both example briefs unpaired against both example receipts', () => {
    const paired = pairInbox(
      [
        { name: onboard, mtimeMs: now - 20 * MIN * 1000 },
        { name: priority, mtimeMs: now - 1000 },
      ],
      [
        { name: prodw, mtimeMs: now - 500 },
        { name: staged, mtimeMs: now - 100 },
      ],
      now,
    );
    expect(paired.unpaired.map((brief) => brief.name)).toEqual([onboard, priority]);
    expect(paired.briefs.every((brief) => brief.status === 'unpaired' && brief.match === 'unpaired')).toBe(true);
    expect(paired.pending.map((brief) => brief.name)).toEqual([onboard, priority]);
    expect(paired.current).toEqual({ name: onboard, age_s: 20 * MIN, status: 'unpaired', match: 'unpaired' });
    expect(paired.newest_receipt).toEqual({ name: staged, age_s: 0 });
    expect(paired.newest_receipt).not.toHaveProperty('status');
  });
});

describe('alerts', () => {
  it('flags a brief pending more than the threshold, and an idle bot with any pending brief', () => {
    const pending = [{ name: 'older.md', age_s: 15 * MIN + 1 }, { name: 'fresh.md', age_s: 15 * MIN }];
    expect(alertsForBot('fable', 'working', pending, 15 * MIN)).toEqual([
      { kind: 'pending_too_long', bot: 'fable', name: 'older.md', age_s: 15 * MIN + 1 },
    ]);
    expect(alertsForBot('fable', 'idle', [{ name: 'fresh.md', age_s: 10 }], 15 * MIN)).toEqual([
      { kind: 'idle_with_pending', bot: 'fable', pending: 1 },
    ]);
    expect(alertsForBot('fable', 'waiting_input', [{ name: 'fresh.md', age_s: 10 }], 15 * MIN)).toEqual([]);
  });
});

describe('pipeline stages', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');

  it('names only the stages written in the filename', () => {
    expect(stagesNamedIn('desk-145-freeze.md')).toEqual(['freeze']);
    expect(stagesNamedIn('145-verdict.md')).toEqual(['review']);
    expect(stagesNamedIn('ENG-5-code-review.md')).toEqual(['review']);
    expect(stagesNamedIn('B1-staged.txt')).toEqual(['staged']);
    expect(stagesNamedIn('134-go-ready.txt')).toEqual(['GO-ready']);
    expect(stagesNamedIn('145-ready-for-prod.txt')).toEqual(['GO-ready']);
    expect(stagesNamedIn('145-live.txt')).toEqual(['live']);
    expect(stagesNamedIn('145-production.md')).toEqual(['live']);
    expect(stagesNamedIn('145.md')).toEqual([]);
    expect(stagesNamedIn('delivery.md')).toEqual([]);
  });

  it('leaves every unnamed stage unknown', () => {
    const rows = buildPipeline(['#145', '#134', 'B1', 'ENG-5'], [
      { name: 'desk-145-freeze.md', mtimeMs: now - 1000 },
      { name: '145-verdict.md', mtimeMs: now - 500 },
      { name: '134-staged.txt', mtimeMs: now - 100 },
      { name: 'ENG-5-go-ready.txt', mtimeMs: now - 50 },
      { name: 'B1-live.txt', mtimeMs: now - 10 },
      { name: '145.md', mtimeMs: now },
    ], now);
    const byCard = Object.fromEntries(rows.map((row) => [row.card, row.stages]));
    expect(byCard['#145'].freeze).toMatchObject({ status: 'seen', name: 'desk-145-freeze.md' });
    expect(byCard['#145'].review).toMatchObject({ status: 'seen', name: '145-verdict.md' });
    expect(byCard['#145'].staged).toEqual({ status: 'unknown' });
    expect(byCard['#145']['GO-ready']).toEqual({ status: 'unknown' });
    expect(byCard['#145'].live).toEqual({ status: 'unknown' });
    expect(byCard['#134'].staged.status).toBe('seen');
    expect(byCard['#134'].freeze).toEqual({ status: 'unknown' });
    expect(byCard.B1.live.status).toBe('seen');
    expect(byCard.B1.review).toEqual({ status: 'unknown' });
    expect(byCard['ENG-5']['GO-ready'].status).toBe('seen');
    expect(byCard['ENG-5'].live).toEqual({ status: 'unknown' });
  });
});

describe('fable queue defaults', () => {
  it('uses the countix sockets, sessions, and directories unless config replaces them', () => {
    const resolved = resolveFableQueue(undefined);
    expect(resolved.pollS).toBe(10);
    expect(resolved.pendingAlertMin).toBe(15);
    expect(resolved.cards).toEqual(['#145', '#134', 'B1', 'ENG-5']);
    expect(defaultFableBots().map((b) => [b.id, b.socket, b.session, b.inbox, b.outbox, b.run_as ?? ''])).toEqual([
      ['fable', 'fable', 'claude-countix', '/home/ci/inbox', '/home/ci/outbox', ''],
      ['fable2', 'fable2', 'claude-countix-2', '/home/ci/inbox-2', '/srv/fable/2/outbox', 'fable2'],
      ['fable3', 'fable3', 'claude-countix-3', '/home/ci/inbox-3', '/srv/fable/3/outbox', 'fable3'],
      ['fable4', 'fable4', 'claude-countix-4', '/home/ci/inbox-4', '/srv/fable/4/outbox', 'fable4'],
      ['fable5', 'fable5', 'claude-countix-5', '/home/ci/inbox-5', '/srv/fable/5/outbox', 'fable5'],
    ]);
    const prefixed = resolveFableQueue({
      fable_queue: {
        bots: [{ id: 'fable2', socket: 'fable2', session: 'claude-countix-2', inbox: '/in', outbox: '/home/ci/outbox-2', run_as: '  fable2  ' }],
      },
    });
    expect(prefixed.bots[0].run_as).toBe('fable2');
    expect(prefixed.bots[0].outbox).toBe('/home/ci/outbox-2');
    const custom = resolveFableQueue({
      fable_queue: { pending_alert_min: 0, poll_s: 5, cards: ['#9'] },
      review: { freeze_inbox: ['/notes'] },
    });
    expect(custom.pendingAlertS).toBe(0);
    expect(custom.pollS).toBe(5);
    expect(custom.cards).toEqual(['#9']);
    expect(custom.bots).toHaveLength(5);
    expect(custom.noteDirs).toEqual(['/notes']);
  });
});
