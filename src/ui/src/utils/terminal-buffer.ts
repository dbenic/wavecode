/**
 * A light buffer for an agent's terminal history.
 *
 * The daemon captures the pane as two parts: the frozen history above the
 * visible screen (append-only in tmux) and the visible screen itself (a TUI
 * redraws it in place). The page keeps its own copy of the history, appends
 * only what is new (found by overlapping the capture with the buffer's tail),
 * and renders the screen separately below it. Scrolling up through history
 * therefore stays put while the agent keeps printing; new lines arrive at the
 * bottom without moving the viewport.
 */

export interface TermLine {
  /** plain text (what tmux printed, ANSI stripped) */
  t: string;
  /** the same line rendered as HTML */
  h: string;
  /** a marker row: lines were missed between two captures */
  gap?: boolean;
}

export const MAX_BUFFER_LINES = 4000;
/** An overlap shorter than this is not trusted (blank or repeated lines match by accident). */
const MIN_OVERLAP = 3;

function key(l: TermLine): string {
  return l.t.replace(/\s+$/, '');
}

/** The longest m such that the last m lines of `buf` equal the first m lines of `inc`. */
function overlap(buf: TermLine[], inc: TermLine[]): number {
  const max = Math.min(buf.length, inc.length);
  for (let m = max; m >= 1; m--) {
    let ok = true;
    for (let i = 0; i < m; i++) {
      if (key(buf[buf.length - m + i]) !== key(inc[i])) { ok = false; break; }
    }
    if (ok) return m;
  }
  return 0;
}

function cap(lines: TermLine[]): TermLine[] {
  return lines.length > MAX_BUFFER_LINES ? lines.slice(lines.length - MAX_BUFFER_LINES) : lines;
}

/**
 * Append the newest history capture to the buffer. Returns the new buffer and
 * how many lines were added (0 when the capture brought nothing new).
 */
export function mergeHistory(buf: TermLine[], inc: TermLine[]): { lines: TermLine[]; added: number } {
  if (inc.length === 0) return { lines: buf, added: 0 };
  if (buf.length === 0) return { lines: cap(inc), added: inc.length };
  const m = overlap(buf, inc);
  if (m === inc.length) return { lines: buf, added: 0 }; // nothing new
  if (m >= MIN_OVERLAP || (m > 0 && m === buf.length)) {
    const fresh = inc.slice(m);
    return { lines: cap(buf.concat(fresh)), added: fresh.length };
  }
  // No trustworthy overlap: more lines scrolled by than one capture holds. Mark the gap.
  const gap: TermLine = { t: '', h: '<span class="text-slate-600 italic">… lines not captured …</span>', gap: true };
  return { lines: cap(buf.concat([gap], inc)), added: inc.length + 1 };
}

/** Put older history in front of the buffer, dropping any lines the buffer already starts with. */
export function prependOlder(buf: TermLine[], older: TermLine[]): { lines: TermLine[]; added: number } {
  if (older.length === 0) return { lines: buf, added: 0 };
  if (buf.length === 0) return { lines: cap(older), added: older.length };
  const m = overlap(older, buf);
  const fresh = m >= MIN_OVERLAP ? older.slice(0, older.length - m) : older;
  return { lines: fresh.concat(buf), added: fresh.length };
}

/** Plain text of the buffer plus the screen, for features that read the pane as text. */
export function bufferText(history: TermLine[], screen: TermLine[]): string {
  return history.filter((l) => !l.gap).map((l) => l.t).concat(screen.map((l) => l.t)).join('\n');
}
