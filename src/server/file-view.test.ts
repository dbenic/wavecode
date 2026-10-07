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
    const bin = write('rooms/x.bin', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]));
    expect(readViewableFile(bin, cfg())).toMatchObject({ ok: false, code: 'binary' });
    const big = write('rooms/big.log', 'a'.repeat(MAX_VIEW_BYTES + 1));
    expect(readViewableFile(big, cfg())).toMatchObject({ ok: false, code: 'too_large' });
  });
});

describe('confinement', () => {
  it('a symlinked file inside an allowed root is refused (O_NOFOLLOW), even when it points inside another allowed root', () => {
    const target = write('inbox/real.md', '# real');
    fs.mkdirSync(path.join(root, 'rooms'), { recursive: true });
    fs.symlinkSync(target, path.join(root, 'rooms', 'link.md'));
    expect(readViewableFile(path.join(root, 'rooms', 'link.md'), cfg())).toMatchObject({ ok: false, code: 'forbidden' });
    // the real file itself is fine
    expect(readViewableFile(target, cfg())).toMatchObject({ ok: true });
  });

  it('a symlinked directory that leads into another allowed root is refused: the root is chosen from the requested path', () => {
    write('inbox/secret-ish.md', 'x');
    fs.mkdirSync(path.join(root, 'rooms'), { recursive: true });
    fs.symlinkSync(path.join(root, 'inbox'), path.join(root, 'rooms', 'jump'));
    expect(readViewableFile(path.join(root, 'rooms', 'jump', 'secret-ish.md'), cfg())).toMatchObject({ ok: false, code: 'forbidden' });
    // a literal `..` in the request (path.join would already collapse it) is refused outright
    expect(readViewableFile(`${root}/rooms/../inbox/secret-ish.md`, cfg())).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('diagram, svg and image kinds', () => {
  it('.d2/.mmd/.puml are diagrams with a language, .svg is svg text, .png is a base64 image with mime', () => {
    expect(readViewableFile(write('rooms/arch.d2', 'a -> b'), cfg())).toMatchObject({ ok: true, data: { kind: 'diagram', lang: 'd2', content: 'a -> b' } });
    expect(readViewableFile(write('rooms/flow.mmd', 'flowchart TD'), cfg())).toMatchObject({ ok: true, data: { kind: 'diagram', lang: 'mermaid' } });
    expect(readViewableFile(write('rooms/seq.puml', '@startuml'), cfg())).toMatchObject({ ok: true, data: { kind: 'diagram', lang: 'plantuml' } });
    expect(readViewableFile(write('rooms/pic.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'), cfg())).toMatchObject({ ok: true, data: { kind: 'svg' } });
    const png = write('rooms/shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]));
    const r = readViewableFile(png, cfg());
    expect(r).toMatchObject({ ok: true, data: { kind: 'image', mime: 'image/png' } });
    expect(r.ok && Buffer.from(r.data.content, 'base64')[0]).toBe(0x89);
  });
});
