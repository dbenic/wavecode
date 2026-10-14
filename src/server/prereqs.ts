/**
 * Operational prerequisites declared in a freeze note.
 *
 * The contract is a fenced YAML block in the freeze note (tied to a SHA).
 * Prose in CURRENT.md is not read. A candidate's prereqs are the union of
 * the freeze notes whose SHAs that candidate contains. Duplicate ids keep
 * the earliest order. `code_deploy` is a step, not a check: when no
 * `kind: code` step is declared, it is appended last on the production GO.
 *
 * No block means today's Promote. A declared id with no configured command
 * refuses Promote.
 */

import fs from 'node:fs';
import yaml from 'js-yaml';
import { getConfig, type PrereqCheckConfig } from './config.js';
import { emit } from './event-bus.js';
import { gitAncestor } from './git-memo.js';
import { execFileAsync } from './proc.js';
import { listFreezes } from './release-freezes.js';

export interface PrereqDecl {
  id: string;
  order: number;
  kind: 'check' | 'code';
}

export interface GoStep {
  id: string;
  order: number;
  kind: 'check' | 'code';
}

const FENCE = /```(?:ya?ml)\s*\n([\s\S]*?)```/gi;
const COMPARE = new Set(['>=', '>', '==', '<=', '<', '!=']);

export function parsePrereqBlock(text: string): PrereqDecl[] {
  const found: PrereqDecl[] = [];
  for (const match of text.matchAll(FENCE)) {
    let doc: unknown;
    try { doc = yaml.load(match[1]); } catch { continue; }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !('prereqs' in doc)) continue;
    const list = (doc as { prereqs?: unknown }).prereqs;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as { id?: unknown; order?: unknown; kind?: unknown };
      if (typeof rec.id !== 'string' || !rec.id.trim()) continue;
      const order = typeof rec.order === 'number' && Number.isFinite(rec.order) ? rec.order : found.length;
      const kind = rec.kind === 'code' || rec.id.trim() === 'code_deploy' ? 'code' : 'check';
      found.push({ id: rec.id.trim(), order, kind });
    }
  }
  return found.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function unionPrereqs(groups: PrereqDecl[][]): PrereqDecl[] {
  const byId = new Map<string, PrereqDecl>();
  const flat = groups.flat().slice().sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  for (const item of flat) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  return [...byId.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** Operational steps keep their order. A missing code step is appended last. An explicit `kind: code` keeps its declared order. */
export function goSteps(decls: PrereqDecl[]): GoStep[] {
  const steps = decls.map((d) => ({ id: d.id, order: d.order, kind: d.kind }));
  if (!steps.some((s) => s.kind === 'code')) {
    const last = steps.reduce((n, s) => Math.max(n, s.order), 0);
    steps.push({ id: 'code_deploy', order: last + 1, kind: 'code' });
  }
  return steps.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function stepsPrompt(steps: GoStep[]): string {
  const lines = steps.map((s, i) => `${i + 1}. ${s.id}${s.kind === 'code' ? ' — deploy this exact SHA' : ''}`);
  return [
    'Stop on the first failure. Leave the previous state live.',
    'Steps, in order:',
    ...lines,
    'If a step fails, stop and report failed_step as that step id.',
  ].join('\n');
}

async function contained(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  if (ancestor === descendant) return true;
  return (await gitAncestor(repo, ancestor, descendant)) === true;
}

function readFreezePrereqs(filePath: string | null): PrereqDecl[] {
  if (!filePath) return [];
  try { return parsePrereqBlock(fs.readFileSync(filePath, 'utf8')); } catch { return []; }
}

/** Union of freeze-note prereqs whose SHA is contained in `sha` (the lane itself, or every lane inside a candidate). */
export async function declaredPrereqs(project: string, sha: string): Promise<PrereqDecl[]> {
  const repo = getConfig().projects?.[project]?.repo ?? null;
  let rows: Array<{ sha: string; project: string | null; freeze_path: string | null }> = [];
  try { rows = listFreezes(); } catch { rows = []; }
  const groups: PrereqDecl[][] = [];
  for (const row of rows) {
    if (row.project && row.project !== project) continue;
    // read the note first: most freezes declare nothing, and git is only asked about the ones that do
    const decls = readFreezePrereqs(row.freeze_path);
    if (!decls.length) continue;
    const inside = row.sha === sha || (!!repo && await contained(repo, row.sha, sha));
    if (inside) groups.push(decls);
  }
  return unionPrereqs(groups);
}

function fill(argv: string[], sha: string, project: string): string[] {
  return argv.map((part) => part.replaceAll('{sha}', sha).replaceAll('{project}', project));
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 400);
}

function compareValue(actual: unknown, op: string, expected: number | string): boolean {
  if (op === '==') return String(actual) === String(expected);
  if (op === '!=') return String(actual) !== String(expected);
  const n = Number(actual);
  const e = Number(expected);
  if (!Number.isFinite(n) || !Number.isFinite(e)) return false;
  if (op === '>=') return n >= e;
  if (op === '>') return n > e;
  if (op === '<=') return n <= e;
  if (op === '<') return n < e;
  return false;
}

function lastField(stdout: string, field: string): { found: boolean; value: unknown } {
  let found = false;
  let value: unknown;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj && typeof obj === 'object' && field in obj) {
        found = true;
        value = obj[field];
      }
    } catch { /* not json */ }
  }
  return { found, value };
}

export interface CheckFailure {
  ok: false;
  error: string;
  id: string;
  output: string;
}

async function runOne(project: string, sha: string, id: string, spec: PrereqCheckConfig | undefined): Promise<CheckFailure | { ok: true }> {
  if (!spec?.command?.length) return { ok: false, error: `prereq ${id} has no check`, id, output: '' };
  const argv = fill(spec.command, sha, project);
  let stdout = '';
  let code = 0;
  try {
    stdout = await execFileAsync(argv[0], argv.slice(1), { timeout: 20000, maxBuffer: 1_000_000 });
  } catch (e) {
    const err = e as { status?: number | null; stdout?: string };
    code = typeof err.status === 'number' ? err.status : 1;
    stdout = err.stdout == null ? '' : String(err.stdout);
  }
  const output = oneLine(stdout);
  if (code !== 0) return { ok: false, error: `prereq ${id} failed: ${output || `exit ${code}`}`, id, output };
  if ((spec.type ?? 'exit') === 'ndjson') {
    const field = spec.field ?? '';
    const op = spec.compare ?? '';
    if (!field || !COMPARE.has(op) || spec.value === undefined) {
      return { ok: false, error: `prereq ${id} has no check`, id, output };
    }
    const read = lastField(stdout, field);
    if (!read.found || !compareValue(read.value, op, spec.value)) {
      const shown = output || `${field} ${op} ${spec.value} failed`;
      return { ok: false, error: `prereq ${id} failed: ${shown}`, id, output: shown };
    }
  }
  return { ok: true };
}

/** Run check steps in order. Stops at the first failure. `kind: code` is not a check. */
export async function runPrereqChecks(project: string, sha: string, decls: PrereqDecl[]): Promise<{ ok: true } | CheckFailure> {
  const checks = getConfig().projects?.[project]?.prereq_checks ?? {};
  for (const decl of decls.filter((d) => d.kind !== 'code')) {
    const result = await runOne(project, sha, decl.id, checks[decl.id]);
    if (!result.ok) return result;
  }
  return { ok: true };
}

export async function productionPrereqGate(
  project: string,
  sha: string,
  who: string | null,
): Promise<{ ok: true; steps: GoStep[] | null } | CheckFailure> {
  const decls = await declaredPrereqs(project, sha);
  if (decls.length === 0) return { ok: true, steps: null };
  const result = await runPrereqChecks(project, sha, decls);
  if (!result.ok) {
    emit('release.prereq', 'release', sha, {
      who: who ?? 'unknown', project, sha, id: result.id, output: result.output, error: result.error,
    }, null);
    return result;
  }
  return { ok: true, steps: goSteps(decls) };
}

/** What's-missing text. Does not write the audit (Promote does). */
export async function prereqStatusNote(project: string, sha: string): Promise<string | null> {
  const decls = await declaredPrereqs(project, sha);
  if (!decls.some((d) => d.kind !== 'code')) return null;
  const result = await runPrereqChecks(project, sha, decls);
  return result.ok ? null : result.error;
}
