import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDaemonConnection } from './daemon-connection.js';
import { readSeatMcp } from '../server/seat-mcp.js';

const dirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-conn-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeSeatMcp(dir: string, token = 'wc_seat_secret', url = 'http://127.0.0.1:3777/mcp'): void {
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({
    mcpServers: { wavecode: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } },
  }));
}

describe('resolveDaemonConnection', () => {
  // Config is not loaded in these tests, so the last fallback is "no token".

  it('WAVECODE_TOKEN wins over a seat registration', () => {
    const dir = tmpDir();
    writeSeatMcp(dir);
    const conn = resolveDaemonConnection({ cwd: dir, env: { WAVECODE_TOKEN: 'from-env', WAVECODE_URL: 'http://10.0.0.5:4000' } });
    expect(conn).toEqual({ url: 'http://10.0.0.5:4000', token: 'from-env', tokenSource: 'env' });
  });

  it('a seat workspace: the bearer and daemon URL from its .mcp.json, so the CLI acts as the seat', () => {
    const dir = tmpDir();
    writeSeatMcp(dir, 'wc_seat_secret', 'http://127.0.0.1:3790/mcp');
    const conn = resolveDaemonConnection({ cwd: dir, env: {} });
    expect(conn).toEqual({ url: 'http://127.0.0.1:3790', token: 'wc_seat_secret', tokenSource: 'seat' });
  });

  it('a subdirectory of the seat workspace still finds the registration', () => {
    const dir = tmpDir();
    writeSeatMcp(dir);
    const nested = path.join(dir, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    expect(resolveDaemonConnection({ cwd: nested, env: {} }).tokenSource).toBe('seat');
  });

  it('WAVECODE_URL overrides the seat URL but the seat token still applies', () => {
    const dir = tmpDir();
    writeSeatMcp(dir);
    const conn = resolveDaemonConnection({ cwd: dir, env: { WAVECODE_URL: 'http://tail.net:3777' } });
    expect(conn).toEqual({ url: 'http://tail.net:3777', token: 'wc_seat_secret', tokenSource: 'seat' });
  });

  it('outside a seat workspace nothing is borrowed: no token without env or config', () => {
    const dir = tmpDir();
    const conn = resolveDaemonConnection({ cwd: dir, env: {} });
    expect(conn.token).toBeNull();
    expect(conn.tokenSource).toBe('none');
    expect(conn.url).toBe('http://localhost:3777');
  });
});

describe('readSeatMcp', () => {
  it('ignores .mcp.json files without a wavecode HTTP bearer', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { type: 'stdio', command: 'x' } } }));
    expect(readSeatMcp(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { wavecode: { type: 'http', url: 'http://127.0.0.1:3777/mcp' } } }));
    expect(readSeatMcp(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, '.mcp.json'), 'not json');
    expect(readSeatMcp(dir)).toBeNull();
  });

  it('returns the file it read and strips the /mcp suffix', () => {
    const dir = tmpDir();
    writeSeatMcp(dir, 'tok', 'http://127.0.0.1:3777/mcp/');
    expect(readSeatMcp(dir)).toEqual({ url: 'http://127.0.0.1:3777', token: 'tok', file: path.join(dir, '.mcp.json') });
  });
});
