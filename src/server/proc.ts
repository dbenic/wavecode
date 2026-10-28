/**
 * Async process execution. The server must not call execFileSync, execSync,
 * spawnSync, or Atomics.wait: those stall the one Node thread, and static
 * pages wait behind them.
 */

import { execFile, type ExecFileOptions } from 'node:child_process';

export interface ExecFileAsyncOptions {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin, then the stream is closed. */
  input?: string;
  /** Aborting it kills the child (SIGTERM); the promise rejects like any other failure. */
  signal?: AbortSignal;
}

export interface ExecFileFailure extends Error {
  status: number | null;
  stdout: string;
  stderr: string;
}

function exitStatus(err: Error): number | null {
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'number') return code;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

/** stdout on exit 0. Rejects with `status` set the way execFileSync did. */
export function execFileAsync(file: string, args: string[], opts: ExecFileAsyncOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const options = {
      cwd: opts.cwd,
      timeout: opts.timeout,
      maxBuffer: opts.maxBuffer ?? 1024 * 1024,
      env: opts.env,
      ...(opts.signal ? { signal: opts.signal } : {}),
      encoding: 'utf8' as const,
      // Node ignores this. Callers and tests read it; the bytes also go to stdin.
      ...(opts.input != null ? { input: opts.input } : {}),
    } as ExecFileOptions & { input?: string };
    const child = execFile(file, args, options, (err, stdout, stderr) => {
      const out = String(stdout ?? '');
      const errText = String(stderr ?? '');
      if (err) {
        const failure = err as ExecFileFailure;
        failure.status = exitStatus(err);
        failure.stdout = out;
        failure.stderr = errText;
        reject(failure);
        return;
      }
      resolve(out);
    });
    if (opts.input != null) child.stdin?.end(opts.input);
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
