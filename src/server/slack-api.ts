/**
 * The little of Slack's Web API the bridge uses, over fetch. No SDK. The bot token comes
 * from a file SystemOps places (0600, service user), read when needed and never logged.
 */
import fs from 'node:fs';

export const SLACK_API = 'https://slack.com/api';
/** Slack cuts a message at 40,000 characters; chunks stay well under and keep code fences balanced. */
export const SLACK_CHUNK_CHARS = 3900;

export function readTokenFile(file: string | undefined | null): string | null {
  if (!file) return null;
  try {
    const token = fs.readFileSync(file, 'utf8').trim();
    return token || null;
  } catch { return null; }
}

export type SlackReply = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

export interface SlackApi {
  call(method: string, body: Record<string, unknown>): Promise<SlackReply>;
  postMessage(opts: { channel: string; text: string; thread_ts?: string | null }): Promise<SlackReply>;
  addReaction(opts: { channel: string; timestamp: string; name: string }): Promise<SlackReply>;
  removeReaction(opts: { channel: string; timestamp: string; name: string }): Promise<SlackReply>;
  /** Fetch a file's `url_private_download` with the bot token (scope `files:read`). */
  download(url: string): Promise<{ ok: true; data: Buffer } | { ok: false; error: string }>;
}

export function slackApi(botToken: string, fetchImpl: typeof fetch = fetch): SlackApi {
  async function call(method: string, body: Record<string, unknown>): Promise<SlackReply> {
    try {
      const res = await fetchImpl(`${SLACK_API}/${method}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${botToken}`, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await res.json()) as Record<string, unknown>;
      if (data.ok !== true) return { ok: false, error: String(data.error ?? `http ${res.status}`) };
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
  async function download(url: string): Promise<{ ok: true; data: Buffer } | { ok: false; error: string }> {
    if (!/^https:\/\/files\.slack\.com\//.test(url)) return { ok: false, error: 'not a Slack file URL' };
    try {
      const res = await fetchImpl(url, { headers: { authorization: `Bearer ${botToken}` }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) return { ok: false, error: `http ${res.status}` };
      // Without files:read Slack answers 200 with an HTML login page instead of the bytes.
      if (/text\/html/i.test(res.headers.get('content-type') ?? '')) return { ok: false, error: 'login page instead of the file: the app lacks the files:read scope' };
      return { ok: true, data: Buffer.from(await res.arrayBuffer()) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
  return {
    call,
    postMessage: ({ channel, text, thread_ts }) => call('chat.postMessage', { channel, text, ...(thread_ts ? { thread_ts } : {}), unfurl_links: false, unfurl_media: false }),
    addReaction: ({ channel, timestamp, name }) => call('reactions.add', { channel, timestamp, name }),
    removeReaction: ({ channel, timestamp, name }) => call('reactions.remove', { channel, timestamp, name }),
    download,
  };
}

/**
 * Split a long reply into Slack-sized pieces at line breaks. An open ``` fence is closed at the
 * end of a chunk and reopened at the start of the next, so each piece renders on its own.
 */
export function chunkText(text: string, max = SLACK_CHUNK_CHARS): string[] {
  const out: string[] = [];
  let cur = '';
  let inFence = false;
  const push = (): void => {
    if (!cur.trim()) { cur = ''; return; }
    out.push(inFence ? `${cur}\n\`\`\`` : cur);
    cur = inFence ? '```\n' : '';
  };
  for (const line of text.split('\n')) {
    const piece = cur ? `\n${line}` : line;
    if (cur.length + piece.length > max) {
      if (line.length > max) {
        // One very long line: hard-split it.
        push();
        for (let i = 0; i < line.length; i += max) out.push(line.slice(i, i + max));
        continue;
      }
      push();
    }
    cur += cur ? `\n${line}` : line;
    if (/^\s*```/.test(line)) inFence = !inFence;
  }
  if (cur.trim()) out.push(cur);
  return out.length ? out : [''];
}

/** `<@U123> text` → `text`; Slack's escaped `&amp;` etc. back to characters. */
export function stripMention(text: string, botUserId?: string | null): string {
  const re = botUserId ? new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, 'g') : /<@[A-Z0-9]+(?:\|[^>]*)?>/g;
  return text.replace(re, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

/**
 * GitHub-flavoured markdown (what the CLIs write) → Slack mrkdwn. Headers become bold lines,
 * `**x**` becomes `*x*`, bullets become `•`, a table becomes an aligned code block, `[ ] option`
 * lines become a numbered list (the person answers with the number), links become `<url|text>`.
 * Code fences pass through untouched.
 */
export function toMrkdwn(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  let inFence = false;
  let optionNo = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) { inFence = !inFence; out.push(line.trim().startsWith('```') ? line.replace(/^(\s*)```\w*/, '$1```') : line); i++; continue; }
    if (inFence) { out.push(line); i++; continue; }
    // table: header row + separator row
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        if (!/^\s*\|?\s*:?-{2,}/.test(lines[i])) rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => inlineMrkdwn(c.trim(), true)));
        i++;
      }
      const width = Math.max(...rows.map((r) => r.length));
      const cols = Array.from({ length: width }, (_, c) => Math.min(28, Math.max(...rows.map((r) => (r[c] ?? '').length))));
      const fmt = (r: string[]): string => cols.map((w, c) => (r[c] ?? '').slice(0, w).padEnd(w)).join('  ').trimEnd();
      out.push('```', fmt(rows[0]), cols.map((w) => '-'.repeat(w)).join('  '), ...rows.slice(1).map(fmt), '```');
      continue;
    }
    const opt = line.match(/^\s*(?:[-*]\s*)?\[\s?\]\s+(.*)$/);
    if (opt) { optionNo++; out.push(`${optionNo}. ${inlineMrkdwn(opt[1])}`); i++; continue; }
    optionNo = 0;
    const header = line.match(/^\s*#{1,6}\s+(.*?)\s*#*\s*$/);
    if (header) { out.push(`*${inlineMrkdwn(header[1], true)}*`); i++; continue; }
    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) { out.push(`${bullet[1]}• ${inlineMrkdwn(bullet[2])}`); i++; continue; }
    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) { out.push(''); i++; continue; }
    out.push(inlineMrkdwn(line));
    i++;
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function inlineMrkdwn(text: string, stripBold = false): string {
  const parts = text.split(/(`[^`]*`)/);
  return parts.map((p, idx) => {
    if (idx % 2 === 1) return p; // inline code untouched
    let t = p.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>');
    t = t.replace(/\*\*(.+?)\*\*/g, stripBold ? '$1' : '*$1*').replace(/__(.+?)__/g, stripBold ? '$1' : '*$1*');
    t = t.replace(/~~(.+?)~~/g, '~$1~');
    return t;
  }).join('');
}
