import { describe, expect, it } from 'vitest';
import {
  alertsForBot,
  buildPipeline,
  classifyPane,
  embeddedIds,
  pairInbox,
  receiptMatchesBrief,
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

describe('inbox pairing', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');

  it('matches a receipt on the stem or an embedded id, and never needs a body', () => {
    expect(receiptMatchesBrief('brief.md', 'brief.txt')).toBe(true);
    expect(receiptMatchesBrief('task-#145.md', '145.receipt')).toBe(true);
    expect(receiptMatchesBrief('ENG-5-impl.md', 'done-ENG-5.txt')).toBe(true);
    expect(receiptMatchesBrief('B1.md', 'B1-receipt.txt')).toBe(true);
    expect(receiptMatchesBrief('B1.md', 'B10.txt')).toBe(false);
    expect(receiptMatchesBrief('2026-10-23-note.md', '2026.txt')).toBe(false);
    expect(receiptMatchesBrief('only.md', 'other.md')).toBe(false);
    expect(embeddedIds('desk-145-freeze.md').has('145')).toBe(true);
  });

  it('reports pending age, the oldest brief, and the newest receipt', () => {
    const paired = pairInbox(
      [
        { name: 'newer.md', mtimeMs: now - 2 * MIN * 1000 },
        { name: 'older.md', mtimeMs: now - 20 * MIN * 1000 },
        { name: 'done.md', mtimeMs: now - MIN * 1000 },
      ],
      [
        { name: 'done.txt', mtimeMs: now - 30 * 1000 },
        { name: 'old-receipt.txt', mtimeMs: now - 5 * MIN * 1000 },
      ],
      now,
    );
    expect(paired.pending.map((p) => p.name)).toEqual(['older.md', 'newer.md']);
    expect(paired.pending[0].age_s).toBe(20 * MIN);
    expect(paired.current).toEqual({ name: 'older.md', age_s: 20 * MIN });
    expect(paired.newest_receipt).toEqual({ name: 'done.txt', age_s: 30 });
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
    expect(defaultFableBots().map((b) => [b.id, b.socket, b.session, b.inbox, b.outbox])).toEqual([
      ['fable', 'fable', 'claude-countix', '/home/ci/inbox', '/home/ci/outbox'],
      ['fable2', 'fable2', 'claude-countix-2', '/home/ci/inbox-2', '/home/ci/outbox-2'],
      ['fable3', 'fable3', 'claude-countix-3', '/home/ci/inbox-3', '/home/ci/outbox-3'],
      ['fable4', 'fable4', 'claude-countix-4', '/home/ci/inbox-4', '/home/ci/outbox-4'],
      ['fable5', 'fable5', 'claude-countix-5', '/home/ci/inbox-5', '/home/ci/outbox-5'],
    ]);
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
