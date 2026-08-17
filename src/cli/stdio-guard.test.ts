import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { installStdioEpipeGuard, isPipeClosedError, writeLine } from './stdio-guard.js';

describe('stdio-guard', () => {
  it('recognizes EPIPE', () => {
    const err = new Error('write EPIPE') as NodeJS.ErrnoException;
    err.code = 'EPIPE';
    expect(isPipeClosedError(err)).toBe(true);
    expect(isPipeClosedError(new Error('disk full'))).toBe(false);
  });

  it('writeLine does not throw when the stream raises EPIPE', () => {
    const stream = {
      write() {
        const err = new Error('write EPIPE') as NodeJS.ErrnoException;
        err.code = 'EPIPE';
        throw err;
      },
    };

    expect(() => writeLine(stream, '  task-1  ● running')).not.toThrow();
    expect(writeLine(stream, '  task-2  ● running')).toBe(false);
  });

  it('writeLine still throws non-EPIPE errors', () => {
    const stream = {
      write() {
        throw new Error('ENOSPC');
      },
    };
    expect(() => writeLine(stream, 'hello')).toThrow('ENOSPC');
  });

  it('installStdioEpipeGuard exits 0 on stdout EPIPE instead of crashing', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exit = vi.fn();

    installStdioEpipeGuard({ stdout, stderr, exit });

    const err = new Error('write EPIPE') as NodeJS.ErrnoException;
    err.code = 'EPIPE';
    stdout.emit('error', err);

    expect(exit).toHaveBeenCalledWith(0);
  });
});
