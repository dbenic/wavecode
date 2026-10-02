/**
 * Pane → reply text (spec §5b). Pure functions, one extractor per runtime.
 *
 * Input is a capture of the agent's pane after it went idle. We locate the
 * echo of the prompt that was sent, look only at what came after it, strip
 * the runtime's TUI chrome (tool-call blocks, spinners, prompt box, status
 * bar) and keep the agent's *final* prose — the answer, not the work log.
 */

export const MAX_REPLY_CHARS = 4000;

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/** Collapse whitespace and drop leading prompt glyphs / box edges for matching. */
function normalize(text: string): string {
  return text.replace(/^[\s│|>❯›]+/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Head + tail when over the cap, so both the opening and the conclusion survive. */
export function clipReply(text: string, max = MAX_REPLY_CHARS): string {
  if (text.length <= max) return text;
  const marker = '\n\n[…]\n\n';
  const head = Math.floor((max - marker.length) * 0.4);
  const tail = max - marker.length - head;
  return `${text.slice(0, head).trimEnd()}${marker}${text.slice(-tail).trimStart()}`;
}

const ECHO_LINE_RE = /^\s*[│|]?\s*[>❯›]\s?\S/;

/**
 * Index of the line that echoes the prompt (searching from the end, so the
 * latest turn wins), or -1. A prompt echo starts with a prompt glyph
 * (`>`, `❯`, `›`), which keeps an answer that quotes the question from
 * being mistaken for the echo.
 */
export function findPromptEcho(lines: string[], prompt: string): number {
  const firstLine = prompt.split('\n').find((l) => l.trim()) ?? '';
  const needle = normalize(firstLine).slice(0, 24);
  if (!needle) return -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ECHO_LINE_RE.test(lines[i]) && normalize(lines[i]).includes(needle)) return i;
  }
  // Some TUIs render the user turn without a glyph — accept a plain match as a last resort.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (normalize(lines[i]).startsWith(needle)) return i;
  }
  return -1;
}

/** Drop any line that is part of the prompt itself (wrapped echo continuation). */
function withoutPromptEcho(lines: string[], prompt: string): string[] {
  const p = normalize(prompt);
  if (!p) return lines;
  return lines.filter((line) => {
    const n = normalize(line);
    return n.length < 8 || !p.includes(n);
  });
}

// --- block-structured TUIs (Claude Code, Grok, Codex) -------------------------

interface Block {
  kind: 'prose' | 'tool';
  lines: string[];
}

interface BlockGrammar {
  /** Starts a new block; group 1 is the header text. */
  marker: RegExp;
  isTool: (header: string) => boolean;
  /** Lines that belong to a tool block's output (`⎿`, `└`). */
  toolContinuation: RegExp;
  /** TUI chrome that is never part of a reply. */
  isChrome: (line: string) => boolean;
}

function parseBlocks(lines: string[], g: BlockGrammar): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (g.isChrome(line)) {
      current = null;
      continue;
    }
    const m = g.marker.exec(line);
    if (m) {
      current = g.isTool(m[1]) ? { kind: 'tool', lines: [] } : { kind: 'prose', lines: [m[1]] };
      blocks.push(current);
      continue;
    }
    if (!current) continue;
    if (g.toolContinuation.test(line)) {
      if (current.kind === 'prose') current = null; // tool output after prose: not part of the prose
      continue;
    }
    if (current.kind === 'prose') {
      const rendered = tableLineToMarkdown(line.replace(/^ {1,2}/, ''));
      if (rendered !== null) current.lines.push(rendered);
    }
  }
  return blocks;
}

/**
 * Tidy markdown tables produced from box-drawing: a wrapped cell becomes a
 * row whose first cell is empty — fold it into the previous row — and a
 * rule between every row collapses to the single separator after the header.
 */
export function tidyTables(lines: string[]): string[] {
  const out: string[] = [];
  let inTable = false;
  let sawSeparator = false;
  for (const line of lines) {
    const isRow = /^\|.*\|$/.test(line);
    const isSep = /^\|( --- \|)+$/.test(line);
    if (!isRow && !isSep) {
      inTable = false;
      sawSeparator = false;
      out.push(line);
      continue;
    }
    if (isSep) {
      if (inTable && !sawSeparator) {
        out.push(line);
        sawSeparator = true;
      }
      continue;
    }
    const cells = line.slice(1, -1).split('|').map((c) => c.trim());
    const prev = out[out.length - 1];
    if (inTable && cells[0] === '' && prev && /^\|.*\|$/.test(prev) && !/^\|( --- \|)+$/.test(prev)) {
      // continuation of the previous row: append each non-empty cell to its column
      const prevCells = prev.slice(1, -1).split('|').map((c) => c.trim());
      const merged = prevCells.map((c, i) => (cells[i] ? `${c} ${cells[i]}`.trim() : c));
      out[out.length - 1] = `| ${merged.join(' | ')} |`;
      continue;
    }
    inTable = true;
    out.push(`| ${cells.join(' | ')} |`);
  }
  return out;
}

/** The prose after the last tool call; if the turn ended on a tool call, the last prose before it. */
function finalProse(blocks: Block[]): string {
  let lastTool = -1;
  blocks.forEach((b, i) => { if (b.kind === 'tool') lastTool = i; });
  let prose = blocks.slice(lastTool + 1).filter((b) => b.kind === 'prose');
  if (prose.length === 0) {
    const before = blocks.filter((b) => b.kind === 'prose');
    prose = before.slice(-1);
  }
  return prose.map((b) => tidyTables(b.lines).join('\n').trim()).filter(Boolean).join('\n\n');
}

/** Prompt-box chrome: rounded borders, bare rules, and the `│ > … │` input row. Tables (┌├└ rules, `│ a │ b │` rows) are content. */
const BOX_RE = /^\s*(?:[╭╮╰╯┃]|[─━═]+\s*$|│\s*[>❯]|│\s*$)/;
const TABLE_RULE_RE = /^\s*[┌├└][─┬┼┴┐┤┘]+\s*$/;
const TABLE_ROW_RE = /^\s*│(.*)│\s*$/;

/** Render a box-drawing table line as markdown so it survives in the thread. */
function tableLineToMarkdown(line: string): string | null {
  if (TABLE_RULE_RE.test(line)) {
    if (/^\s*[┌└]/.test(line)) return null; // top/bottom borders carry nothing
    const cells = line.replace(/^\s*├|┤\s*$/g, '').split('┼').length;
    return `|${' --- |'.repeat(cells)}`;
  }
  const m = TABLE_ROW_RE.exec(line);
  if (m && m[1].includes('│')) return `| ${m[1].split('│').map((c) => c.trim()).join(' | ')} |`;
  return line;
}

const CLAUDE_GRAMMAR: BlockGrammar = {
  marker: /^\s?[●⏺]\s?(.*)$/,
  // `Bash(…)`, `Read(…)`, `mcp__wavecode__list_agents (MCP)(…)`, `wavecode - list_agents (MCP)`,
  // `Update Todos`, `Running…`
  isTool: (h) => /^[A-Za-z_][\w.:-]*(\s\(MCP\))?\(/.test(h)
    || /\(MCP\)/.test(h)
    || /^(Running|Update Todos|Read \d+ files?)\b/.test(h),
  toolContinuation: /^\s*⎿/,
  isChrome: (l) =>
    /^[✻✶✳✢✽✺]/.test(l)                       // "✻ Brewed for 2m 3s", spinners
    || /^·\s.*(…|\.\.\.)/.test(l)
    || BOX_RE.test(l) && !/^\s*│\s*⎿/.test(l)  // prompt box borders
    || /^\s*[❯>](\s|$)/.test(l)                // prompt box / echoed user turns
    || /⏵⏵|\? for shortcuts|esc to interrupt|Context left until|bypass permissions|accept edits on|auto-accept/i.test(l)
    || /How is Claude doing this session\?/i.test(l)   // the CLI's own survey, never part of an answer
    || /^\s*1: Bad\s+2: Fine\s+3: Good/.test(l),
};

const GROK_GRAMMAR: BlockGrammar = {
  ...CLAUDE_GRAMMAR,
  isChrome: (l) =>
    CLAUDE_GRAMMAR.isChrome(l)
    || /^\s*(Responding|Thinking|Working)\b.*(…|\.\.\.)/i.test(l)
    || /\b(Worked|Responded) for \d/i.test(l)
    || /^\s*(grok-[\w.-]+|Model:)\s/i.test(l),
};

const CODEX_TOOL_RE = /^(Ran|Running|Explored|Exploring|Edited|Editing|Read|Reading|Search(ed|ing)?|Updated Plan|Updating Plan|Waited|Waiting|Called|Calling|Added|Deleted|Listed|Listing|Applied|Applying|Proposed Change)\b/;

const CODEX_GRAMMAR: BlockGrammar = {
  marker: /^•\s?(.*)$/,
  isTool: (h) => CODEX_TOOL_RE.test(h),
  toolContinuation: /^\s*[└│]/,
  isChrome: (l) =>
    /^\s*›/.test(l)                             // composer + echoed user turns
    || /gpt-[\d.]+\S*\s.*(left|context)/i.test(l) // status line "gpt-5.2 high · 82% left · ~/repo"
    || /^\s*─*\s*Worked for\b/.test(l)
    || /^\s*─{3,}/.test(l)
    || /^\s*◦\s/.test(l)                         // "◦ Working (12s • esc to interrupt)"
    || /⏎ send|esc to interrupt|⌃J newline|Token usage:|To continue this session/i.test(l)
    || BOX_RE.test(l),
};

/** Plain-text TUIs (aider, unknown): drop chrome, keep the last paragraph run. */
function genericExtract(lines: string[]): string {
  const kept = lines.filter((l) =>
    !GROK_GRAMMAR.isChrome(l.replace(/\s+$/, ''))
    && !/^\s*[$#]\s*$/.test(l)
    && !/^\s*(Tokens|Cost):/i.test(l));
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function blockOrGeneric(grammar: BlockGrammar) {
  return (lines: string[]): string => {
    const blocks = parseBlocks(lines, grammar);
    return blocks.length > 0 ? finalProse(blocks) : genericExtract(lines);
  };
}

/** One table, per runtime key from config. Unknown runtimes use the generic extractor. */
export const REPLY_EXTRACTORS: Record<string, (lines: string[]) => string> = {
  'claude-code': blockOrGeneric(CLAUDE_GRAMMAR),
  grok: blockOrGeneric(GROK_GRAMMAR),
  codex: blockOrGeneric(CODEX_GRAMMAR),
};

export interface ExtractedReply {
  text: string;
  /** False when the prompt echo was not found and the whole capture was used. */
  anchored: boolean;
}

const PASTED_PLACEHOLDER = /^\s*>?\s*\[Pasted text #\d+(?:\s*\+\d+ lines)?\]/;

function findLastIndex(lines: string[], pred: (l: string) => boolean): number {
  for (let i = lines.length - 1; i >= 0; i--) if (pred(lines[i])) return i;
  return -1;
}

/**
 * Extract the agent's reply to `prompt` from a pane capture. Without a
 * prompt (run summaries), the whole capture is the region.
 */
export function extractReply(runtime: string, pane: string, prompt?: string | null): ExtractedReply {
  const lines = stripAnsi(pane).replace(/\r/g, '').split('\n');
  let region = lines;
  let anchored = false;
  if (prompt) {
    let echo = findPromptEcho(lines, prompt);
    // Claude Code collapses a long pasted prompt to "> [Pasted text #1 +N lines]"
    // instead of echoing it; the LAST such placeholder is the user turn we
    // just sent, so it anchors the region just as a verbatim echo would.
    if (echo < 0) echo = findLastIndex(lines, (l) => PASTED_PLACEHOLDER.test(l));
    if (echo >= 0) {
      region = lines.slice(echo + 1);
      anchored = true;
    }
    region = withoutPromptEcho(region, prompt);
  }
  const extract = REPLY_EXTRACTORS[runtime] ?? REPLY_EXTRACTORS[runtime.split('-')[0]] ?? genericExtract;
  return { text: clipReply(extract(region).trim()), anchored };
}

/**
 * Has the agent finished its turn? Per-runtime end-of-turn markers in the
 * pane tail. Used when capturing from an agent that is still "working"
 * (background jobs): without the marker, stable text is only a pause
 * between steps, not the answer.
 */
const TURN_END: Record<string, RegExp> = {
  'claude-code': /^[✻✶✳✢✽✺]\s.*\b(done|Worked for|Cogitated|Brewed|Baked|Churned|Levitated|Ionized)\b/m,
  codex: /(^|\n)\s*─*\s*Worked for\b/,
};

export function turnEnded(runtime: string, pane: string): boolean {
  const re = TURN_END[runtime] ?? TURN_END[runtime.split('-')[0]];
  if (!re) return true; // unknown runtime: no marker to wait for
  return re.test(stripAnsi(pane));
}
