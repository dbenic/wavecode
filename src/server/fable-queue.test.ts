import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./proc.js', () => ({
  execFileAsync: vi.fn(async () => ''),
}));

import { execFileAsync } from './proc.js';
import { resolveFableQueue } from './fable-queue-config.js';
import { collectOnce, resetFableQueueForTest, startFableQueue, stopFableQueue } from './fable-queue.js';

const SECRET = 'SUPER_SECRET_TOKEN sk-do-not-leak';

describe('fable queue collector', () => {
  let tmp = '';

  afterEach(() => {
    resetFableQueueForTest();
    vi.clearAllMocks();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = '';
  });

  it('stays on the async tmux path', () => {
    const src = fs.readFileSync(new URL('./fable-queue.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/execFileSync|execSync|spawnSync|Atomics\.wait|readFile|send-keys|sendKeys|capturePane/);
    expect(src).toContain("['-L', socket, 'capture-pane', '-p', '-t', session]");
  });

  it('pairs files by name, classifies the pane, and omits bodies and pane text', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-fable-'));
    const inbox = path.join(tmp, 'inbox');
    const outbox = path.join(tmp, 'outbox');
    const notes = path.join(tmp, 'notes');
    fs.mkdirSync(inbox);
    fs.mkdirSync(outbox);
    fs.mkdirSync(notes);
    const now = Date.parse('2026-10-23T12:00:00Z');
    fs.writeFileSync(path.join(inbox, '145-brief.md'), SECRET);
    fs.writeFileSync(path.join(inbox, '134-freeze.md'), SECRET);
    fs.writeFileSync(path.join(inbox, '.env'), 'TOKEN=hidden');
    fs.writeFileSync(path.join(inbox, 'done.md'), SECRET);
    fs.writeFileSync(path.join(outbox, 'done.txt'), SECRET);
    fs.writeFileSync(path.join(notes, 'desk-145-freeze.md'), SECRET);
    fs.utimesSync(path.join(inbox, '145-brief.md'), (now - 1000) / 1000, (now - 1000) / 1000);
    vi.mocked(execFileAsync).mockResolvedValue(`esc to interrupt\npassword=${SECRET}\ntoken=${SECRET}`);

    const report = await collectOnce({
      now: () => now,
      config: resolveFableQueue({
        fable_queue: {
          cards: ['#145', '#134', 'B1', 'ENG-5'],
          note_dirs: [notes],
          bots: [{ id: 'fable', socket: 'fable', session: 'claude-countix', inbox, outbox }],
        },
      }),
    });

    expect(execFileAsync).toHaveBeenCalledWith(
      'tmux',
      ['-L', 'fable', 'capture-pane', '-p', '-t', 'claude-countix'],
      expect.objectContaining({ timeout: 5000 }),
    );
    expect(report.bots[0].state).toBe('working');
    expect(report.bots[0].capture).toContain('esc to interrupt');
    expect(report.bots[0].capture).toContain('[redacted]');
    expect(report.bots[0].capture).not.toContain(SECRET);
    expect(report.bots[0].pending.map((p) => p.name).sort()).toEqual(['134-freeze.md', '145-brief.md']);
    expect(report.bots[0].current?.name).toBe('145-brief.md');
    expect(report.bots[0].newest_receipt?.name).toBe('done.txt');
    expect(report.pipeline.find((row) => row.card === '#145')?.stages.freeze).toMatchObject({ status: 'seen', name: 'desk-145-freeze.md' });
    expect(report.pipeline.find((row) => row.card === '#145')?.stages.review).toEqual({ status: 'unknown' });
    expect(report.pipeline.find((row) => row.card === '#134')?.stages.freeze).toEqual({ status: 'unknown' });
    const encoded = JSON.stringify(report);
    expect(encoded).not.toContain(SECRET);
    expect(encoded).not.toContain('.env');
    expect(encoded).not.toContain(inbox);
    expect(report.bots[0]).not.toHaveProperty('inbox');
  });

  it('degrades when the socket or a directory is missing and writes nothing', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-fable-miss-'));
    const inbox = path.join(tmp, 'inbox');
    fs.mkdirSync(inbox);
    fs.writeFileSync(path.join(inbox, 'keep.md'), 'stay');
    const before = fs.readFileSync(path.join(inbox, 'keep.md'), 'utf8');
    vi.mocked(execFileAsync).mockRejectedValue(new Error('no server running on /tmp/secret-socket'));
    const missingNotes = path.join(tmp, 'no-notes');

    const report = await collectOnce({
      config: resolveFableQueue({
        fable_queue: {
          cards: ['#145'],
          note_dirs: [missingNotes],
          bots: [
            { id: 'fable', socket: 'fable', session: 'claude-countix', inbox, outbox: path.join(tmp, 'no-outbox') },
            { id: 'bad', socket: 'fable', session: 'has space', inbox, outbox: path.join(tmp, 'no-outbox') },
          ],
        },
      }),
    });

    expect(report.bots[0].state).toBe('unknown');
    expect(report.bots[0].state_error).toBe('socket unavailable');
    expect(report.bots[0].outbox_error).toBe('missing');
    expect(report.bots[0].pending.map((p) => p.name)).toEqual(['keep.md']);
    expect(report.bots[1].state_error).toBe('invalid name');
    expect(execFileAsync).toHaveBeenCalledTimes(1);
    const args = vi.mocked(execFileAsync).mock.calls[0]?.[1] as string[];
    expect(args).toEqual(['-L', 'fable', 'capture-pane', '-p', '-t', 'claude-countix']);
    expect(args.join(' ')).not.toContain('send-keys');
    expect(report.notes_unavailable).toBe(1);
    expect(report.pipeline[0].stages.freeze).toEqual({ status: 'unknown' });
    expect(JSON.stringify(report)).not.toContain('secret-socket');
    expect(fs.readFileSync(path.join(inbox, 'keep.md'), 'utf8')).toBe(before);
  });

  it('collects again after 10 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    vi.mocked(execFileAsync).mockClear();
    vi.mocked(execFileAsync).mockResolvedValue('esc to interrupt');
    try {
      startFableQueue();
      await vi.waitFor(() => expect(vi.mocked(execFileAsync).mock.calls.length).toBe(5));
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(vi.mocked(execFileAsync).mock.calls.length).toBe(10));
    } finally {
      stopFableQueue();
      vi.useRealTimers();
    }
  });
});
