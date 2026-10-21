import { describe, expect, it } from 'vitest';
import { bufferText, mergeHistory, prependOlder, MAX_BUFFER_LINES, type TermLine } from './terminal-buffer';

const L = (t: string): TermLine => ({ t, h: t });
const lines = (...t: string[]) => t.map(L);

describe('terminal buffer', () => {
  it('appends only what is new, found by overlapping the capture with the tail', () => {
    const buf = lines('a', 'b', 'c', 'd', 'e');
    const next = mergeHistory(buf, lines('c', 'd', 'e', 'f', 'g'));
    expect(next.added).toBe(2);
    expect(next.lines.map((l) => l.t)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    const same = mergeHistory(next.lines, lines('e', 'f', 'g'));
    expect(same.added).toBe(0);
    expect(same.lines).toBe(next.lines);
  });

  it('ignores trailing whitespace when matching and does not trust a one-line overlap', () => {
    const buf = lines('x', 'y', 'z   ');
    expect(mergeHistory(buf, lines('x', 'y', 'z', 'w')).lines.map((l) => l.t.trim())).toEqual(['x', 'y', 'z', 'w']);
    // a single blank line in common is not an overlap: the capture is treated as a gap
    const gapped = mergeHistory(lines('p', 'q', ''), lines('', 'r', 's'));
    expect(gapped.lines.some((l) => l.gap)).toBe(true);
    expect(gapped.lines.map((l) => l.t)).toEqual(['p', 'q', '', '', '', 'r', 's']);
  });

  it('starts from an empty buffer, caps the buffer, and prepends older history without duplicates', () => {
    expect(mergeHistory([], lines('a', 'b')).lines.map((l) => l.t)).toEqual(['a', 'b']);
    const big = mergeHistory([], Array.from({ length: MAX_BUFFER_LINES + 10 }, (_, i) => L(`l${i}`))).lines;
    expect(big).toHaveLength(MAX_BUFFER_LINES);
    expect(big[0].t).toBe('l10');
    const buf = lines('m', 'n', 'o', 'p');
    const older = prependOlder(buf, lines('j', 'k', 'l', 'm', 'n', 'o'));
    expect(older.added).toBe(3);
    expect(older.lines.map((l) => l.t)).toEqual(['j', 'k', 'l', 'm', 'n', 'o', 'p']);
    expect(bufferText(older.lines, lines('❯ '))).toBe('j\nk\nl\nm\nn\no\np\n❯ ');
  });
});
