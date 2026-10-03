import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_VIEW_BYTES, readViewableFile } from './file-view.js';
import type { WaveConfig } from './config.js';

let root: string;
const cfg = (): WaveConfig => ({
  paths: { rooms_root: path.join(root, 'rooms'), worktrees_root: path.join(root, 'wt'), projects_root: '', transcripts_root: path.join(root, 'tr'), browse_roots: [path.join(root, 'inbox')] },
  artifacts: { storage: path.join(root, 'art') },
} as unknown as WaveConfig);

function write(rel: string, content: string | Buffer): string {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  return f;
}

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-fv-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('readViewableFile', () => {
  it('serves markdown and text under the browsable roots, including configured extra roots', () => {
    const md = write('rooms/wavepulse/REPORTS/a.md', '# Hello');
    const r = readViewableFile(md, cfg());
    expect(r).toMatchObject({ ok: true, data: { name: 'a.md', kind: 'markdown', content: '# Hello', size: 7 } });
    const txt = write('inbox/proposal.txt', 'plain');
    expect(readViewableFile(txt, cfg())).toMatchObject({ ok: true, data: { kind: 'text', content: 'plain' } });
  });

  it('refuses anything outside the roots, including symlink escapes and relative paths', () => {
    const secret = write('profiles/denis/claude/.credentials.json', '{"t":"x"}');
    expect(readViewableFile(secret, cfg())).toMatchObject({ ok: false, code: 'forbidden' });
    fs.mkdirSync(path.join(root, 'rooms'), { recursive: true });
    fs.symlinkSync(secret, path.join(root, 'rooms', 'leak.json'));
    expect(readViewableFile(path.join(root, 'rooms', 'leak.json'), cfg())).toMatchObject({ ok: false, code: 'forbidden' });
    expect(readViewableFile(path.join(root, 'rooms', '..', 'profiles', 'denis', 'claude', '.credentials.json'), cfg())).toMatchObject({ ok: false, code: 'forbidden' });
    expect(readViewableFile('rooms/a.md', cfg())).toMatchObject({ ok: false, code: 'invalid' });
    expect(readViewableFile('', cfg())).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('missing, directories, binary and oversized files are refused with distinct codes', () => {
    expect(readViewableFile(path.join(root, 'rooms', 'nope.md'), cfg())).toMatchObject({ ok: false, code: 'not_found' });
    fs.mkdirSync(path.join(root, 'rooms', 'dir'), { recursive: true });
    expect(readViewableFile(path.join(root, 'rooms', 'dir'), cfg())).toMatchObject({ ok: false, code: 'not_found' });
    const bin = write('rooms/x.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]));
    expect(readViewableFile(bin, cfg())).toMatchObject({ ok: false, code: 'binary' });
    const big = write('rooms/big.log', 'a'.repeat(MAX_VIEW_BYTES + 1));
    expect(readViewableFile(big, cfg())).toMatchObject({ ok: false, code: 'too_large' });
  });
});
