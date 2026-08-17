/**
 * Keep CLI list commands from crashing when a downstream consumer
 * (`head`, a pager, CountixDev piping `wavecode tasks`) closes stdout.
 */

export function isPipeClosedError(err: unknown): boolean {
  return Boolean(
    err
    && typeof err === 'object'
    && 'code' in err
    && (err as NodeJS.ErrnoException).code === 'EPIPE',
  );
}

export function installStdioEpipeGuard(opts?: {
  stdout?: NodeJS.EventEmitter;
  stderr?: NodeJS.EventEmitter;
  exit?: (code: number) => void;
}): void {
  const exit = opts?.exit ?? ((code: number) => {
    process.exit(code);
  });
  const handle = (err: Error): void => {
    if (isPipeClosedError(err)) exit(0);
  };
  (opts?.stdout ?? process.stdout).on('error', handle);
  (opts?.stderr ?? process.stderr).on('error', handle);
}

/**
 * Write one line. Returns false when the pipe is already closed so the
 * caller can stop printing instead of throwing EPIPE.
 */
export function writeLine(stream: { write(chunk: string): unknown }, line: string): boolean {
  const payload = line.endsWith('\n') ? line : `${line}\n`;
  try {
    stream.write(payload);
    return true;
  } catch (err) {
    if (isPipeClosedError(err)) return false;
    throw err;
  }
}
