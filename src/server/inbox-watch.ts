/**
 * Watch hand-off folders (default `~/inbox/from-fable/`): a new file there is
 * announced to its addressed agent by typing one line into its pane when it is
 * idle — agents only act on pane input. Recipient = a `To: @agent` line in the
 * first lines of the file, else the file name's first token (`claude1-…`).
 * Unaddressed files are posted to the thread only.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from './config.js';
import { insertAgentMessage, resolveAgent } from './db.js';
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

function recipientFor(file: string, content: string): ReturnType<typeof resolveAgent> | null {
  for (const line of content.split('\n').slice(0, MAX_HEAD_LINES)) {
    const m = /^\s*(?:to|for|recipient)\s*:\s*@?([\w.-]+)/i.exec(line);
    if (m) {
      const r = resolveAgent(m[1]);
      if (r.ok) return r;
    }
  }
  const stem = path.basename(file).replace(/\.[^.]+$/, '');
  const first = /^([a-z0-9][\w]*?)(?:-|$)/i.exec(stem)?.[1];
  if (first) {
    const r = resolveAgent(first);
    if (r.ok) return r;
  }
  return null;
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
  const recipient = recipientFor(file, head);
  // The hand-off stays reviewable after the inbox moves on: archive it as a library document.
  let archive = '';
  try {
    const archived = archiveDocumentFile(file, { provenance: `hand-off from ${label}; archived from ${file}` });
    if (archived.ok) archive = ` (archive ${archived.data.storage_path})`;
  } catch (e) {
    logger.debug({ file, error: (e as Error).message }, 'Hand-off not archived');
  }
  const text = `[File from ${label}] ${file}${archive} — read it and act on it as part of your current task; answer with a TO @fable: line if it asks a question.`;
  if (recipient?.ok) {
    deliverSystemLine(recipient.data, text, { kind: 'handoff', source: label });
    logger.info({ file, agent: recipient.data.name }, 'Inbox file announced to its agent');
    return;
  }
  const stored = insertAgentMessage({ from_agent_id: null, to_agent_id: null, message: text, message_type: 'info' });
  if (stored.ok) emit('message.created', 'agent_message', stored.data.id, { from_agent_id: null, to_agent_id: null, message_type: 'info', via: 'inbox_watch', file }, null);
  logger.info({ file }, 'Inbox file posted to the thread (no addressed agent)');
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
