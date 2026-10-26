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
  return {
    call,
    postMessage: ({ channel, text, thread_ts }) => call('chat.postMessage', { channel, text, ...(thread_ts ? { thread_ts } : {}), unfurl_links: false, unfurl_media: false }),
    addReaction: ({ channel, timestamp, name }) => call('reactions.add', { channel, timestamp, name }),
    removeReaction: ({ channel, timestamp, name }) => call('reactions.remove', { channel, timestamp, name }),
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
