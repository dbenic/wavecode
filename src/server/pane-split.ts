/**
 * The pane in two parts for the agent page's history buffer: the frozen
 * history above the visible screen and the screen itself, each as lines of
 * plain text plus HTML. See src/ui/src/utils/terminal-buffer.ts.
 */

export interface SplitLine { t: string; h: string }
export interface SplitPayload { history: SplitLine[]; screen: SplitLine[]; history_size: number; rows: number }

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Render each captured line on its own (tmux re-emits attributes per line, so per-line HTML holds). */
export async function splitPayload(
  historyAnsi: string,
  screenAnsi: string,
  meta: { history_size: number; rows: number },
  clean: (s: string) => string,
  render: (s: string) => Promise<string>,
): Promise<SplitPayload> {
  const toLines = async (ansi: string): Promise<SplitLine[]> => {
    const cleaned = clean(ansi);
    const plain = splitLines(cleaned.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
    const raw = splitLines(cleaned);
    const html = await Promise.all(raw.map((l) => render(l)));
    return raw.map((_, i) => ({ t: plain[i] ?? '', h: html[i] ?? '' }));
  };
  const [history, screen] = await Promise.all([toLines(historyAnsi), toLines(screenAnsi)]);
  return { history, screen, history_size: meta.history_size, rows: meta.rows };
}
