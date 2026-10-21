import { describe, expect, it } from 'vitest';
import { splitPayload } from './pane-split.js';

describe('pane split payload', () => {
  it('returns history and screen as per-line text plus HTML, trailing blank lines dropped', async () => {
    const clean = (s: string) => s.replace(/\r/g, '');
    const render = async (s: string) => `<x>${s.replace(/\x1b\[[0-9;]*m/g, '')}</x>`;
    const out = await splitPayload('\x1b[32mdone\x1b[0m one\nline two\n\n', '❯ \n  bypass permissions on\n', { history_size: 1200, rows: 80 }, clean, render);
    expect(out.history).toEqual([{ t: 'done one', h: '<x>done one</x>' }, { t: 'line two', h: '<x>line two</x>' }]);
    expect(out.screen.map((l) => l.t)).toEqual(['❯ ', '  bypass permissions on']);
    expect(out.history_size).toBe(1200);
    expect(out.rows).toBe(80);
    expect((await splitPayload('', '', { history_size: 0, rows: 0 }, clean, render)).history).toEqual([]);
  });
});
