/**
 * Project rooms (spec §5e): one shared folder per project that every seat is
 * briefed with and every tool can read.
 *
 *   <rooms_root>/<project>/
 *     SPEC.md        what we are building           (room owner / admin)
 *     ROOM.md        the PM's running summary       (any seat)
 *     LEDGER.md      task → status → verdict        (WaveCode only)
 *     DECISIONS.md   mirror of the decisions table  (WaveCode only)
 *     REPORTS/       one file per run / review / QA (any seat; WaveCode copies reports in)
 *     TEMPLATES/     build / review / verify / spec dispatch templates (owner / admin)
 *
 * Agent workspaces get `.wavecode/room` → the room folder.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';
import {
  getRoom,
  getUser,
  insertRoom,
  listRoomRows,
  type Agent,
  type Result,
  type Room,
  type Run,
  type Task,
  type User,
} from './db.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import { workspaceMatches } from './project-gate.js';
import { OWNER_USER_ID } from './users.js';

export const ROOM_NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
export const TEMPLATE_KINDS = ['build', 'review', 'verify', 'spec'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];
export const MAX_DOC_BYTES = 512 * 1024;
const DOC_EXTENSIONS = new Set(['.md', '.txt', '.json', '.log']);
const INDEX_LINES = 20;

export function isTemplateKind(v: unknown): v is TemplateKind {
  return typeof v === 'string' && (TEMPLATE_KINDS as readonly string[]).includes(v);
}

const DONE_WHEN: Record<TemplateKind, string> = {
  build: 'the change is implemented with co-located tests, `npm test` and `npm run typecheck` pass, and the result file ends with RESULT: PASS (or RESULT: FAIL with the reason)',
  review: 'you end with exactly one line VERDICT: pass | needs-fixes | reject, after the issues (severity, file, why)',
  verify: 'every acceptance criterion in SPEC.md is checked against the running build and your findings are written to REPORTS/',
  spec: 'SPEC.md states the goal, the scope, what is out of scope and testable acceptance criteria',
};

const DEFAULT_TEMPLATES: Record<TemplateKind, string> = {
  build: '# Build\n\nRoom: {room} — read SPEC.md (what we are building) and DECISIONS.md before you start.\n\n## Task\n{task}\n\n## Done when\n{done_when}\n',
  review: '# Review\n\nRoom: {room} — review against SPEC.md and DECISIONS.md, not against taste.\n\n## What to review\n{task}\n\n## Done when\n{done_when}\n',
  verify: '# Verify\n\nRoom: {room} — SPEC.md has the acceptance criteria; earlier reports are in REPORTS/.\n\n## What to verify\n{task}\n\n## Done when\n{done_when}\n',
  spec: '# Spec\n\nRoom: {room} — write or refine SPEC.md; ROOM.md has the open questions.\n\n## Brief\n{task}\n\n## Done when\n{done_when}\n',
};

function seedFiles(project: string): Record<string, string> {
  return {
    'SPEC.md': `# ${project} — spec\n\nWhat we are building: (not written yet)\n`,
    'ROOM.md': `# ${project} — room\n\n## Current goal\n\n## Who is on what\n\n## Open questions\n\n## Vocabulary\n`,
    'LEDGER.md': `# ${project} — ledger\n\nWritten by WaveCode: one line per run, review and report.\n\n| when (UTC) | task | agent | event | result | report |\n|---|---|---|---|---|---|\n`,
    'DECISIONS.md': `# ${project} — decisions\n\nMirrored from WaveCode decisions, newest last.\n`,
    ...Object.fromEntries(TEMPLATE_KINDS.map((k) => [path.join('TEMPLATES', `${k}.md`), DEFAULT_TEMPLATES[k]])),
  };
}

export function roomsRoot(): string {
  return getConfig().paths.rooms_root;
}

/** Create the room row and folder layout; idempotent (never overwrites an existing file). */
export function ensureRoom(project: string, ownerId: string | null = null): Result<Room> {
  if (!ROOM_NAME_RE.test(project)) return { ok: false, error: 'room name must be 1–48 chars of [a-z0-9_.-]' };
  const existing = getRoom(project);
  const root = existing.ok ? existing.data.root : path.join(roomsRoot(), project);
  try {
    fs.mkdirSync(path.join(root, 'REPORTS'), { recursive: true });
    fs.mkdirSync(path.join(root, 'TEMPLATES'), { recursive: true });
    for (const [rel, content] of Object.entries(seedFiles(project))) {
      const file = path.join(root, rel);
      if (!fs.existsSync(file)) fs.writeFileSync(file, content, 'utf8');
    }
  } catch (e) {
    return { ok: false, error: `Cannot create room folder: ${(e as Error).message}` };
  }
  if (existing.ok) return existing;
  const created = insertRoom({ project, root, owner_id: ownerId });
  if (created.ok) emit('room.created', 'room', created.data.id, { project, root });
  return created;
}

/** Rooms in the DB plus one per configured project (created on first sight). */
export function listRooms(): Room[] {
  for (const name of Object.keys(getConfig().projects ?? {})) {
    if (ROOM_NAME_RE.test(name) && !getRoom(name).ok) ensureRoom(name);
  }
  return listRoomRows();
}

/** The room whose `projects.<name>.workspace_match` matches this workspace. */
export function roomForWorkspace(workspace: string | null | undefined): Room | null {
  if (!workspace) return null;
  for (const [name, project] of Object.entries(getConfig().projects ?? {})) {
    if (!project?.workspace_match || !ROOM_NAME_RE.test(name)) continue;
    if (workspaceMatches(workspace, project.workspace_match)) {
      const room = ensureRoom(name);
      return room.ok ? room.data : null;
    }
  }
  return null;
}

/**
 * A task's room: explicit, else the room matching the agent's workspace,
 * else the creator's default room, else none.
 */
export function resolveTaskRoom(opts: { explicit?: string | null; agent?: Pick<Agent, 'workspace'> | null; creatorId?: string | null }): Room | null {
  if (opts.explicit) {
    const r = getRoom(opts.explicit);
    return r.ok ? r.data : null;
  }
  const byWorkspace = roomForWorkspace(opts.agent?.workspace);
  if (byWorkspace) return byWorkspace;
  if (opts.creatorId && opts.creatorId !== OWNER_USER_ID) {
    const user = getUser(opts.creatorId);
    if (user.ok && user.data.default_room) {
      const r = getRoom(user.data.default_room);
      if (r.ok) return r.data;
    }
  }
  return null;
}

// --- documents -------------------------------------------------------------

export type DocErrorCode = 'invalid' | 'forbidden' | 'not_found' | 'too_large';
export type DocResult<T> = { ok: true; data: T } | { ok: false; error: string; code: DocErrorCode };

export function docErrorStatus(code: DocErrorCode): 400 | 403 | 404 | 413 {
  return { invalid: 400, forbidden: 403, not_found: 404, too_large: 413 }[code] as 400 | 403 | 404 | 413;
}

/**
 * Resolve `rel` inside the room: relative, no `..`, an allowed extension,
 * and no symlink anywhere on the way (a link could point out of the room).
 */
export function resolveDocPath(room: Pick<Room, 'root'>, rel: string): DocResult<{ rel: string; file: string }> {
  const clean = rel.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!clean || clean.startsWith('/') || clean.split('/').some((seg) => seg === '..' || seg === '' || seg.startsWith('.'))) {
    return { ok: false, code: 'invalid', error: 'path must be a plain relative path inside the room' };
  }
  if (!DOC_EXTENSIONS.has(path.extname(clean).toLowerCase())) {
    return { ok: false, code: 'invalid', error: `only ${[...DOC_EXTENSIONS].join(', ')} files live in a room` };
  }
  const file = path.resolve(room.root, clean);
  if (!file.startsWith(path.resolve(room.root) + path.sep)) return { ok: false, code: 'invalid', error: 'path escapes the room' };
  let cursor = path.resolve(room.root);
  for (const seg of clean.split('/')) {
    cursor = path.join(cursor, seg);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) return { ok: false, code: 'invalid', error: 'symlinks are not followed in rooms' };
    } catch {
      break; // does not exist yet (a new file) — fine
    }
  }
  return { ok: true, data: { rel: clean, file } };
}

type Writer = Pick<User, 'id' | 'role'>;

/**
 * Who may write what (spec §5e): SPEC.md and TEMPLATES/ — the room owner or
 * an admin; REPORTS/ and ROOM.md — any seat (any non-observer); LEDGER.md and
 * DECISIONS.md — WaveCode only; anything else — owner or admin.
 */
export function canWriteDoc(user: Writer, room: Pick<Room, 'owner_id'>, rel: string): { ok: true } | { ok: false; error: string } {
  if (user.role === 'observer') return { ok: false, error: 'Observers are read-only' };
  if (rel === 'LEDGER.md' || rel === 'DECISIONS.md') return { ok: false, error: `${rel} is written by WaveCode` };
  if (rel === 'ROOM.md' || rel.startsWith('REPORTS/')) return { ok: true };
  const privileged = user.role === 'admin' || (!!room.owner_id && room.owner_id === user.id);
  return privileged ? { ok: true } : { ok: false, error: `Only the room owner or an admin may write ${rel}` };
}

export interface DocEntry {
  path: string;
  size: number;
  modified_at: string;
  writable: boolean;
}

export function listDocs(room: Room, viewer: Writer): DocEntry[] {
  const out: DocEntry[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (DOC_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const st = fs.statSync(full);
        out.push({ path: rel, size: st.size, modified_at: st.mtime.toISOString(), writable: canWriteDoc(viewer, room, rel).ok });
      }
    }
  };
  if (fs.existsSync(room.root)) walk(room.root, '');
  const rank = (p: string) => ['SPEC.md', 'ROOM.md', 'LEDGER.md', 'DECISIONS.md'].indexOf(p);
  return out.sort((a, b) => {
    const ra = rank(a.path);
    const rb = rank(b.path);
    if (ra !== -1 || rb !== -1) return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
    return a.path.localeCompare(b.path);
  });
}

export function readDoc(room: Room, rel: string): DocResult<{ path: string; content: string }> {
  const resolved = resolveDocPath(room, rel);
  if (!resolved.ok) return resolved;
  try {
    return { ok: true, data: { path: resolved.data.rel, content: fs.readFileSync(resolved.data.file, 'utf8') } };
  } catch {
    return { ok: false, code: 'not_found', error: `${resolved.data.rel} not found in room ${room.project}` };
  }
}

export function writeDoc(room: Room, rel: string, content: unknown, user: Writer): DocResult<{ path: string; size: number }> {
  const resolved = resolveDocPath(room, rel);
  if (!resolved.ok) return resolved;
  const access = canWriteDoc(user, room, resolved.data.rel);
  if (!access.ok) return { ok: false, code: 'forbidden', error: access.error };
  if (typeof content !== 'string') return { ok: false, code: 'invalid', error: 'content must be text' };
  const size = Buffer.byteLength(content, 'utf8');
  if (size > MAX_DOC_BYTES) return { ok: false, code: 'too_large', error: `documents are limited to ${MAX_DOC_BYTES} bytes` };
  fs.mkdirSync(path.dirname(resolved.data.file), { recursive: true });
  fs.writeFileSync(resolved.data.file, content, 'utf8');
  emit('room.doc_written', 'room', room.id, { project: room.project, path: resolved.data.rel, size });
  return { ok: true, data: { path: resolved.data.rel, size } };
}

// --- written by WaveCode -------------------------------------------------------

function stamp(d = new Date()): { date: string; when: string } {
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), when: `${iso.slice(0, 10)} ${iso.slice(11, 16)}` };
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

/** One row in LEDGER.md. */
export function appendLedger(room: Room, row: { task: string; agent: string; event: string; result: string; report?: string | null }): void {
  const line = `| ${stamp().when} | ${cell(row.task)} | ${cell(row.agent)} | ${cell(row.event)} | ${cell(row.result)} | ${row.report ? cell(row.report) : ''} |\n`;
  fs.appendFileSync(path.join(room.root, 'LEDGER.md'), line, 'utf8');
}

function uniqueReportPath(room: Room, base: string): string {
  let rel = `REPORTS/${base}.md`;
  for (let i = 2; fs.existsSync(path.join(room.root, rel)); i++) rel = `REPORTS/${base}-${i}.md`;
  return rel;
}

/** Write a report file under REPORTS/ (WaveCode, not a user). */
export function addReport(room: Room, base: string, content: string): string {
  ensureRoom(room.project);
  const rel = uniqueReportPath(room, base.replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 120));
  fs.writeFileSync(path.join(room.root, rel), content, 'utf8');
  emit('room.report_added', 'room', room.id, { project: room.project, path: rel }, null);
  return rel;
}

function taskLabel(task: Pick<Task, 'num' | 'prompt'>): string {
  return task.num ? `#${task.num}` : task.prompt.slice(0, 40);
}

/** A finished run: its RESULT file and prose summary → REPORTS/, a ledger line. */
export function recordRunReport(run: Run, task: Task, agent: Agent, resultText: string | null): string | null {
  const room = resolveTaskRoom({ explicit: task.room, agent, creatorId: task.created_by ?? null });
  if (!room) return null;
  const result = /RESULT:\s*(PASS|FAIL)/i.exec(resultText ?? '')?.[1]?.toUpperCase() ?? (run.status === 'done' ? 'done' : 'failed');
  const body = [
    `# Run ${run.id} — task ${taskLabel(task)}`,
    '',
    `- Agent: ${agent.alias ?? agent.name}`,
    `- Status: ${run.status}${run.exit_code !== null ? ` (exit ${run.exit_code})` : ''}`,
    `- Result: ${result}`,
    '',
    '## Task',
    task.prompt.slice(0, 2000),
    '',
    '## RESULT file',
    resultText?.trim() || '(none)',
    ...(run.summary ? ['', '## What the agent said', run.summary] : []),
    '',
  ].join('\n');
  const rel = addReport(room, `${stamp().date}-task${task.num ?? ''}-run-${run.id.slice(-8)}-result`, body);
  appendLedger(room, { task: taskLabel(task), agent: agent.alias ?? agent.name, event: `run ${run.status}`, result, report: rel });
  return rel;
}

/** A review verdict → REPORTS/ and a ledger line. */
export function recordReviewReport(opts: {
  task: Task;
  run: Run;
  author: Agent | null;
  reviewer: string;
  verdict: string;
  issues: number;
  fixRound: number;
  feedback: string;
}): string | null {
  const room = resolveTaskRoom({ explicit: opts.task.room, agent: opts.author, creatorId: opts.task.created_by ?? null });
  if (!room) return null;
  const body = [
    `# Review of run ${opts.run.id} — task ${taskLabel(opts.task)}`,
    '',
    `- Verdict: ${opts.verdict}`,
    `- Issues: ${opts.issues}`,
    `- Fix round: ${opts.fixRound}`,
    `- Reviewer: ${opts.reviewer}`,
    `- Author: ${opts.author ? opts.author.alias ?? opts.author.name : 'unknown'}`,
    '',
    '## Feedback',
    opts.feedback.trim(),
    '',
  ].join('\n');
  const rel = addReport(room, `${stamp().date}-task${opts.task.num ?? ''}-review-r${opts.fixRound}`, body);
  appendLedger(room, {
    task: taskLabel(opts.task),
    agent: opts.author ? opts.author.alias ?? opts.author.name : '?',
    event: `review r${opts.fixRound}`,
    result: `VERDICT: ${opts.verdict}${opts.issues ? ` (${opts.issues} issues)` : ''}`,
    report: rel,
  });
  return rel;
}

/** A QA session's findings (posted as a qa-reports doc) → REPORTS/ and a ledger line. */
export function recordQaReport(agent: Agent, filename: string, content: string): string | null {
  const room = roomForWorkspace(agent.workspace);
  if (!room) return null;
  const rel = addReport(room, filename.replace(/\.md$/i, ''), content);
  const bugs = (content.match(/\bbug\b/gi) ?? []).length;
  appendLedger(room, { task: '—', agent: agent.alias ?? agent.name, event: 'QA report', result: bugs ? `${bugs} bug mentions` : 'see report', report: rel });
  return rel;
}

/** Mirror a decision into the matching room's DECISIONS.md (appended). */
export function mirrorDecision(workspace: string | null | undefined, decision: { summary: string; detail?: string | null }): void {
  try {
    const room = roomForWorkspace(workspace);
    if (!room) return;
    const detail = decision.detail?.trim() ? `\n  ${decision.detail.trim().replace(/\n/g, '\n  ')}` : '';
    fs.appendFileSync(path.join(room.root, 'DECISIONS.md'), `\n- ${stamp().when} — ${decision.summary.trim()}${detail}\n`, 'utf8');
  } catch (e) {
    logger.warn({ error: (e as Error).message }, 'Decision mirror failed');
  }
}

// --- briefing --------------------------------------------------------------------

function head(file: string, lines: number): string | null {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').slice(0, lines).join('\n').trim();
  } catch {
    return null;
  }
}

export function loadTemplate(room: Room, kind: TemplateKind): string {
  try {
    return fs.readFileSync(path.join(room.root, 'TEMPLATES', `${kind}.md`), 'utf8');
  } catch {
    return DEFAULT_TEMPLATES[kind];
  }
}

export function fillTemplate(template: string, vars: { task: string; room: string; done_when: string }): string {
  const filled = template
    .replaceAll('{task}', vars.task)
    .replaceAll('{room}', vars.room)
    .replaceAll('{done_when}', vars.done_when);
  return template.includes('{task}') ? filled : `${filled.trimEnd()}\n\n## Task\n${vars.task}\n`;
}

/**
 * What every dispatch starts with (spec §5e): the room index (file list +
 * the top of ROOM.md and SPEC.md) and the task wrapped in its template.
 */
export function roomBriefing(room: Room, kind: TemplateKind, task: string, viewer: Writer = { id: 'system', role: 'admin' }): string {
  const files = listDocs(room, viewer).map((d) => d.path);
  const roomMd = head(path.join(room.root, 'ROOM.md'), INDEX_LINES);
  const specMd = head(path.join(room.root, 'SPEC.md'), INDEX_LINES + 10);
  const index = [
    `## PROJECT ROOM: ${room.project}`,
    `Folder: ${room.root} (also .wavecode/room in your workspace). Files: ${files.join(', ')}`,
    ...(roomMd ? ['', '### ROOM.md (top)', roomMd] : []),
    ...(specMd ? ['', '### SPEC.md (top)', specMd] : []),
  ].join('\n');
  const templated = fillTemplate(loadTemplate(room, kind), { task, room: room.root, done_when: DONE_WHEN[kind] });
  return `${index}\n\n---\n${templated.trim()}`;
}

/** `<workspace>/.wavecode/room` → the room folder (replaced if it points elsewhere). */
export function linkRoomIntoWorkspace(workspace: string | null | undefined, room: Room): boolean {
  if (!workspace || !fs.existsSync(workspace)) return false;
  const dir = path.join(workspace, '.wavecode');
  const link = path.join(dir, 'room');
  try {
    fs.mkdirSync(dir, { recursive: true });
    try {
      const st = fs.lstatSync(link);
      if (!st.isSymbolicLink()) return false; // never clobber a real folder
      if (fs.readlinkSync(link) === room.root) return true;
      fs.unlinkSync(link);
    } catch {
      // no link yet
    }
    fs.symlinkSync(room.root, link, 'dir');
    // keep it out of git status when the workspace is a plain repo
    const exclude = path.join(workspace, '.git', 'info', 'exclude');
    if (fs.existsSync(path.dirname(exclude))) {
      const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
      if (!current.split('\n').includes('.wavecode/')) fs.appendFileSync(exclude, `${current.endsWith('\n') || !current ? '' : '\n'}.wavecode/\n`);
    }
    return true;
  } catch (e) {
    logger.warn({ workspace, error: (e as Error).message }, 'Room link failed');
    return false;
  }
}

/** For the orchestrator brief: where the rooms are and how to use them. */
export function roomsBriefLine(): string {
  let rooms: Room[] = [];
  try {
    rooms = listRooms();
  } catch {
    return '';
  }
  if (rooms.length === 0) return '';
  return `Project rooms (shared spec, ledger, decisions, reports): ${rooms.map((r) => `${r.project} at ${r.root}`).join('; ')}. `
    + 'Before answering about a project, read its ROOM.md (list_docs / read_doc); for "what are we building?" quote SPEC.md. '
    + 'After a decision, update ROOM.md (write_doc) — current goal, who is on what, open questions.';
}
