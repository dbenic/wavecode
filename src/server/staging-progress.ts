/**
 * Staging deploy progress, schema v1.
 *
 * A configured staging command prints one JSON object per line. Unknown fields
 * are ignored. A line whose schema version is present and not 1 is skipped.
 * This module only parses and fills argv; releases.ts runs the command.
 */

export const PROGRESS_STATUSES = ['start', 'ok', 'fail', 'skip', 'heartbeat'] as const;
export type ProgressStatus = (typeof PROGRESS_STATUSES)[number];

/** Display order. Middle phases sit between fetch and verify. */
export const PROGRESS_PHASES = [
  'queued', 'lock', 'fetch', 'tests', 'predeploy_dump', 'checkout', 'deps',
  'build', 'reload_migrate', 'verify', 'pin', 'done',
] as const;

export interface ProgressError {
  code: string;
  step_rc: number | null;
  msg: string;
}

export interface ProgressLine {
  deploy_id: string;
  phase: string;
  status: ProgressStatus;
  version?: string | null;
  pin_until?: string | null;
  url?: string | null;
  error?: ProgressError | null;
  rollback_status?: string | null;
  rollback_to?: string | null;
  staging_sha?: string | null;
}

const STATUS_SET = new Set<string>(PROGRESS_STATUSES);

function optString(obj: Record<string, unknown>, key: string): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
  const v = obj[key];
  if (v == null) return null;
  return typeof v === 'string' ? v : undefined;
}

function readError(v: unknown): ProgressError | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.code !== 'string' || typeof o.msg !== 'string') return undefined;
  return { code: o.code, step_rc: typeof o.step_rc === 'number' ? o.step_rc : null, msg: o.msg };
}

/** One stdout line. Empty, non-JSON, or the wrong schema version yields null. */
export function parseProgressLine(line: string): ProgressLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let value: unknown;
  try { value = JSON.parse(trimmed); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(obj, 'v') && obj.v !== 1) return null;
  if (typeof obj.phase !== 'string' || !obj.phase) return null;
  if (typeof obj.status !== 'string' || !STATUS_SET.has(obj.status)) return null;
  if (typeof obj.deploy_id !== 'string' || !obj.deploy_id) return null;
  const error = readError(obj.error);
  const out: ProgressLine = { deploy_id: obj.deploy_id, phase: obj.phase, status: obj.status as ProgressStatus };
  const version = optString(obj, 'version');
  const pin = optString(obj, 'pin_until');
  const url = optString(obj, 'url');
  const rollbackStatus = optString(obj, 'rollback_status');
  const rollbackTo = optString(obj, 'rollback_to');
  const stagingSha = optString(obj, 'staging_sha');
  if (version !== undefined) out.version = version;
  if (pin !== undefined) out.pin_until = pin;
  if (url !== undefined) out.url = url;
  if (error !== undefined) out.error = error;
  if (rollbackStatus !== undefined) out.rollback_status = rollbackStatus;
  if (rollbackTo !== undefined) out.rollback_to = rollbackTo;
  if (stagingSha !== undefined) out.staging_sha = stagingSha;
  return out;
}

export interface StagingArgVars {
  sha?: string | null;
  lane?: string | null;
  desk?: string | null;
  deploy_id?: string | null;
}

const PLACEHOLDER = /^\{(sha|lane|desk|deploy_id)\}$/;

/**
 * Fill `{sha}`, `{lane}`, `{desk}`, `{deploy_id}` in an argv template.
 * A placeholder that is its own argument and has no value is dropped, and so
 * is a preceding `--flag`, so an optional lane or desk does not become an
 * empty flag. Never interpreted by a shell.
 */
export function fillArgv(template: string[], vars: StagingArgVars): string[] {
  const value = (key: string): string => {
    const v = vars[key as keyof StagingArgVars];
    return v == null ? '' : String(v);
  };
  const out: string[] = [];
  for (const arg of template) {
    const whole = PLACEHOLDER.exec(arg);
    if (whole) {
      const filled = value(whole[1]);
      if (!filled) {
        if (out.length > 0 && out[out.length - 1].startsWith('--')) out.pop();
        continue;
      }
      out.push(filled);
      continue;
    }
    out.push(arg.replace(/\{(sha|lane|desk|deploy_id)\}/g, (_, key: string) => value(key)));
  }
  return out;
}
