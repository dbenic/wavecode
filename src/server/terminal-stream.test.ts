import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./tmux.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tmux.js')>();
  return { ...actual, tmuxExec: vi.fn(), tmuxExecSafe: vi.fn() };
});

import * as tmux from './tmux.js';
import { PrivateModeFilter, filterPrivateModes, seedBytes, paneGeometry } from './terminal-stream.js';

const exec = vi.mocked(tmux.tmuxExec);

beforeEach(() => {
  exec.mockReset();
});

describe('filterPrivateModes', () => {
  it('drops alternate-screen and mouse-tracking switches, keeps everything else', () => {
    expect(filterPrivateModes('a\x1b[?1049hb\x1b[?1049lc')).toBe('abc');
    expect(filterPrivateModes('\x1b[?1000h\x1b[?1006h\x1b[?25l')).toBe('\x1b[?25l');
    expect(filterPrivateModes('\x1b[31mred\x1b[0m')).toBe('\x1b[31mred\x1b[0m');
  });

  it('keeps the other parameters of a combined sequence', () => {
    expect(filterPrivateModes('\x1b[?1049;2004h')).toBe('\x1b[?2004h');
    expect(filterPrivateModes('\x1b[?2004;1049;25l')).toBe('\x1b[?2004;25l');
  });
});

describe('PrivateModeFilter', () => {
  it('filters a sequence split across chunks', () => {
    const f = new PrivateModeFilter();
    const a = f.push(Buffer.from('hello\x1b[?10'));
    const b = f.push(Buffer.from('49hworld'));
    expect(a.toString()).toBe('hello');
    expect(b.toString()).toBe('world');
    expect(f.flush().length).toBe(0);
  });

  it('holds a bare trailing ESC and releases it once complete', () => {
    const f = new PrivateModeFilter();
    expect(f.push(Buffer.from('x\x1b')).toString()).toBe('x');
    expect(f.push(Buffer.from('[31m')).toString()).toBe('\x1b[31m');
  });

  it('passes complete non-CSI escapes straight through', () => {
    const f = new PrivateModeFilter();
    expect(f.push(Buffer.from('\x1b]0;title\x07tail')).toString()).toBe('\x1b]0;title\x07tail');
    expect(f.push(Buffer.from('ok\x1b[0m')).toString()).toBe('ok\x1b[0m');
  });

  it('keeps binary bytes intact', () => {
    const f = new PrivateModeFilter();
    const utf8 = Buffer.from('ünïcödé ✓');
    expect(f.push(utf8).equals(utf8)).toBe(true);
  });
});

describe('paneGeometry', () => {
  it('reads size, history and cursor from display-message', async () => {
    exec.mockResolvedValueOnce('140 80 123 5 79\n');
    const g = await paneGeometry('wc-x');
    expect(g).toEqual({ ok: true, data: { cols: 140, rows: 80, history_size: 123, cursor_x: 5, cursor_y: 79 } });
    expect(exec.mock.calls[0][0]).toEqual(['display-message', '-t', 'wc-x', '-p', '#{pane_width} #{pane_height} #{history_size} #{cursor_x} #{cursor_y}']);
  });

  it('fails when tmux gives nothing usable', async () => {
    exec.mockResolvedValueOnce('');
    expect((await paneGeometry('wc-x')).ok).toBe(false);
    exec.mockRejectedValueOnce(new Error('no server'));
    expect((await paneGeometry('wc-x')).ok).toBe(false);
  });
});

describe('seedBytes', () => {
  it('captures history plus screen, resets per line and restores the cursor', async () => {
    exec.mockResolvedValueOnce('old\n\x1b[32mprompt>\x1b[?1049h\n');
    const seed = await seedBytes('wc-x', { cols: 80, rows: 2, history_size: 10, cursor_x: 7, cursor_y: 1 }, 5000);
    expect(exec.mock.calls[0][0]).toEqual(['capture-pane', '-t', 'wc-x', '-p', '-e', '-S', '-10', '-E', '1']);
    expect(seed.toString('latin1')).toBe('old\x1b[0m\r\n\x1b[32mprompt>\x1b[0m\x1b[2;8H');
  });

  it('asks for at most maxLines of history', async () => {
    exec.mockResolvedValueOnce('');
    await seedBytes('wc-x', { cols: 80, rows: 24, history_size: 9999, cursor_x: 0, cursor_y: 0 }, 100);
    expect(exec.mock.calls[0][0]).toContain('-100');
  });

  it('is empty when the capture fails', async () => {
    exec.mockRejectedValueOnce(new Error('gone'));
    const seed = await seedBytes('wc-x', { cols: 80, rows: 24, history_size: 0, cursor_x: 0, cursor_y: 0 });
    expect(seed.length).toBe(0);
  });
});
