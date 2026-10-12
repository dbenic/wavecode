/**
 * Watch hand-off folders (default `~/inbox/from-fable/`): a new file there is
 * announced into each addressed agent's pane when that agent is idle.
 * An address line (`To:` / `For:` / `Recipient:` or a heading that names `@agent`)
 * goes to every agent that resolves. Otherwise the longest hyphen-prefix of the
 * file name that resolves (`ales-codex1-foo.md` → `ales-codex1`) is the recipient.
 * When nothing resolves, the file is still posted to the thread as an unrouted hand-off.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from './config.js';
import { insertAgentMessage, resolveAgent, type Agent } from './db.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import { deliverSystemLine } from './wire-lines.js';
import { archiveDocumentFile } from './fixtures.js';

const watchers = new Map<string, fs.FSWatcher>();
const seen = new Map<string, number>(); // path → mtimeMs announced
const SETTLE_MS = 1200;
const MAX_HEAD_LINES = 20;

function expand(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

export function watchedInboxDirs(): string[] {
  const cfg = getConfig();
  const dirs = cfg.paths.inbox_watch ?? ['~/inbox/from-fable'];
  return dirs.map(expand);
}

function addressedNames(content: string): string[] | null {
  const names: string[] = [];
  let saw = false;
  for (const line of content.split('\n').slice(0, MAX_HEAD_LINES)) {
    const isTo = /^\s*(?:to|for|recipient)\s*:/i.test(line);
    const isHeading = /^\s*#{1,6}\s+/.test(line) && /@[\w.-]+/.test(line);
    if (!isTo && !isHeading) continue;
    saw = true;
    for (const m of line.matchAll(/@([\w.-]+)/g)) names.push(m[1]);
  }
  return saw ? names : null;
}

/** Longest hyphen-prefix of the file name that resolves to an agent (`ales-codex1-foo` → `ales-codex1`). */
function recipientFromName(file: string): ReturnType<typeof resolveAgent> | null {
  const stem = path.basename(file).replace(/\.[^.]+$/, '');
  const parts = stem.split('-').filter(Boolean);
  for (let i = parts.length; i >= 1; i--) {
    const r = resolveAgent(parts.slice(0, i).join('-'));
    if (r.ok) return r;
  }
  return null;
}

function recipientsFor(file: string, content: string): Agent[] | 'addressed-none' | null {
  const named = addressedNames(content);
  if (named) {
    const found: Agent[] = [];
    const seenIds = new Set<string>();
    for (const name of named) {
      const r = resolveAgent(name);
      if (r.ok && !seenIds.has(r.data.id)) {
        seenIds.add(r.data.id);
        found.push(r.data);
      }
    }
    return found.length ? found : 'addressed-none';
  }
  const one = recipientFromName(file);
  return one?.ok ? [one.data] : null;
}

export function announceFile(file: string, label: string): void {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return;
  }
  if (!st.isFile()) return;
  if (seen.get(file) === st.mtimeMs) return;
  seen.set(file, st.mtimeMs);
  let head = '';
  try {
    head = fs.readFileSync(file, 'utf8').slice(0, 4000);
  } catch { /* unreadable: still announce by path */ }
  const recipients = recipientsFor(file, head);
  // The hand-off stays reviewable after the inbox moves on: archive it as a library document.
  let archive = '';
  try {
    const archived = archiveDocumentFile(file, { provenance: `hand-off from ${label}; archived from ${file}` });
    if (archived.ok) archive = ` (archive ${archived.data.storage_path})`;
  } catch (e) {
    logger.debug({ file, error: (e as Error).message }, 'Hand-off not archived');
  }
  const text = `[File from ${label}] ${file}${archive} — read it and act on it as part of your current task; answer with a TO @fable: line if it asks a question.`;
  if (Array.isArray(recipients) && recipients.length) {
    for (const agent of recipients) {
      deliverSystemLine(agent, text, { kind: 'handoff', source: label });
      logger.info({ file, agent: agent.name }, 'Inbox file announced to its agent');
    }
    return;
  }
  const notice = `unrouted hand-off: [File from ${label}] ${file}${archive} — no agent resolved from the header or the file name.`;
  const stored = insertAgentMessage({ from_agent_id: null, to_agent_id: null, message: notice, message_type: 'info' });
  if (stored.ok) emit('message.created', 'agent_message', stored.data.id, { from_agent_id: null, to_agent_id: null, message_type: 'info', via: 'inbox_watch', file, unrouted: true, notice: 'unrouted hand-off' }, null);
  logger.warn({ file, label }, 'unrouted hand-off');
}

function labelFor(dir: string): string {
  const base = path.basename(dir);
  return base.startsWith('from-') ? `deploy/${base.slice(5)}` : base;
}

export function startInboxWatchers(): void {
  for (const dir of watchedInboxDirs()) {
    if (watchers.has(dir)) continue;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (e) {
      logger.warn({ dir, error: (e as Error).message }, 'Inbox watch dir could not be created');
      continue;
    }
    // Files already there were handled (or not) by a previous daemon — do not re-announce them.
    for (const name of fs.readdirSync(dir)) {
      try { seen.set(path.join(dir, name), fs.statSync(path.join(dir, name)).mtimeMs); } catch { /* ignore */ }
    }
    const label = labelFor(dir);
    try {
      const w = fs.watch(dir, (event, filename) => {
        if (!filename || typeof filename !== 'string' || filename.startsWith('.')) return;
        const file = path.join(dir, filename);
        // let the writer finish: announce once the size has been stable for SETTLE_MS
        setTimeout(() => announceFile(file, label), SETTLE_MS);
      });
      w.on('error', (e) => logger.warn({ dir, error: e.message }, 'Inbox watcher error'));
      watchers.set(dir, w);
      logger.info({ dir, label }, 'Watching hand-off folder');
    } catch (e) {
      logger.warn({ dir, error: (e as Error).message }, 'Inbox watcher could not start');
    }
  }
}

export function stopInboxWatchers(): void {
  for (const w of watchers.values()) w.close();
  watchers.clear();
}

/** Test hook. */
export function resetInboxWatchForTest(): void {
  stopInboxWatchers();
  seen.clear();
}
