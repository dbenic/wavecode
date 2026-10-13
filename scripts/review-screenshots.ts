/**
 * Screenshots of the Reviews page against a seeded board that mirrors
 * tonight's lanes. Serves the built UI and the board JSON. No daemon.
 *
 *   npm run build:ui && npx tsx scripts/review-screenshots.ts
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  buildLaneCards, buildReleaseView,
  type LaneFreezeFact, type LaneViewer, type WorkingLaneFact,
} from '../src/server/lane-cards.js';

const DIST = path.resolve('src/ui/dist');
const OUT = path.resolve('docs/screenshots');
const PORT = 4178;

const OWNERS = [
  { name: 'Antonio', lanes: ['wc-s3-*', 'wc-eba-*', 'wc-canary*', 'wc-pd111*'] },
  { name: 'Aleš', lanes: ['wc-ales-*', 'wc-recognition-*'] },
];

function sha(prefix: string, fill: string): string {
  return (prefix + fill.repeat(40)).slice(0, 40);
}

function fact(over: Partial<LaneFreezeFact> & Pick<LaneFreezeFact, 'sha' | 'lane'>): LaneFreezeFact {
  return {
    project: 'countix',
    desk: null,
    title: null,
    summary: null,
    author_name: null,
    reviewer_name: null,
    verdict: null,
    verdict_path: null,
    created_at: '2026-10-12T18:00:00.000Z',
    state: 'awaiting_review',
    version: null,
    behind_main: false,
    superseded: false,
    in_staging: false,
    in_prod: false,
    action: 'none',
    action_lock: null,
    run_id: 'run-1',
    run_backed: true,
    quick_running: false,
    eta_min: null,
    conflict_files: [],
    auto_merge_main: false,
    auto_stage: false,
    reviewing_since: null,
    unknown_reason: null,
    live_at: null,
    ...over,
  };
}

const freezes: LaneFreezeFact[] = [
  fact({
    sha: sha('d7b7b1fb', 'a'), lane: 'wc-s3-104', desk: 104, title: 'S3', author_name: 'antonio',
    reviewer_name: 'codex2', reviewing_since: '2026-10-12T19:10:00.000Z', created_at: '2026-10-12T19:00:00.000Z',
  }),
  fact({
    sha: sha('0a0a0a0a', '1'), lane: 'wc-s3-104', desk: 104, title: 'S3', author_name: 'antonio',
    created_at: '2026-10-11T09:00:00.000Z', state: 'superseded', superseded: true,
  }),
  fact({
    sha: sha('e69d42f4', 'b'), lane: 'wc-eba-viewer', title: 'EBA viewer', author_name: 'antonio',
    state: 'on_staging', action: 'ready', in_staging: true, created_at: '2026-10-12T17:40:00.000Z',
  }),
  fact({
    sha: sha('2b104dd9', 'c'), lane: 'wc-ales-106', desk: 106, title: 'S3', author_name: 'ales',
    verdict: 'needs-fixes', state: 'needs_fixes',
    summary: 'The timeout still fires on the second scan.',
    verdict_path: '/home/wave/inbox/freezes/ales-106-verdict.md',
    created_at: '2026-10-12T16:20:00.000Z',
  }),
  fact({
    sha: sha('7b2bccd8', 'd'), lane: 'wc-canary', title: 'Canary', author_name: 'antonio',
    state: 'awaiting_prod_go', version: '0.443.4', created_at: '2026-10-12T15:00:00.000Z',
  }),
  fact({
    sha: sha('c4a1a4e4', '4'), lane: 'wc-canary-v4', title: 'Canary v4', author_name: 'antonio',
    state: 'ready_to_stage', action: 'stage', action_lock: null, run_id: 'run-canary-v4', run_backed: true,
    created_at: '2026-10-12T20:10:00.000Z',
  }),
  fact({
    sha: sha('56f6a55d', 'f'), lane: 'wc-recognition-timeout', title: 'Recognition timeout', author_name: 'ales',
    behind_main: true, created_at: '2026-10-12T14:10:00.000Z',
  }),
];

const working: WorkingLaneFact[] = [{
  project: 'countix',
  lane: 'wc-pd111-s3',
  sha: sha('cfec444f', 'e'),
  author_name: 'antonio',
  title: 'PD-111 S3',
  desk: 111,
}];

const releaseTips = {
  prod: { version: '0.442.9', sha: sha('a11c0de0', '9') },
  staging: { version: '0.443.2', sha: sha('e69d42f4', 'b') },
};

function boardFor(viewer: LaneViewer | null) {
  const cards = buildLaneCards(freezes, working, viewer, OWNERS);
  return {
    last_reconciled_at: '2026-10-12T20:05:00.000Z',
    stale: false,
    items: [],
    reviewers: [
      { id: 'codex2', name: 'codex2', alias: null, busy: true, queue: 1 },
      { id: 'codex3', name: 'codex3', alias: 'c3', busy: false, queue: 0 },
    ],
    cards,
    viewer: { name: viewer?.name ?? null },
    release: buildReleaseView(cards, releaseTips),
  };
}

const BOARDS: Record<string, ReturnType<typeof boardFor>> = {
  'antonio-token': boardFor(OWNERS[0]),
  'ales-token': boardFor(OWNERS[1]),
};

function bearer(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim();
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function startServer(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const token = bearer(req);
    if (url.pathname === '/api/auth/status') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ method: 'token', tokenConfigured: true }));
      return;
    }
    if (url.pathname === '/api/auth/verify') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === '/api/reviews/board') {
      const body = BOARDS[token ?? ''] ?? boardFor(null);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
      return;
    }
    if (url.pathname === '/api/me') {
      const name = token === 'ales-token' ? 'ales' : token === 'antonio-token' ? 'antonio' : 'owner';
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: name, name, role: 'developer', color: '#2563eb' }));
      return;
    }
    if (url.pathname === '/api/proposals' || url.pathname === '/api/agents') {
      res.setHeader('content-type', 'application/json');
      res.end('[]');
      return;
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      return;
    }
    const rel = decodeURIComponent(url.pathname);
    const candidate = path.normalize(path.join(DIST, rel === '/' ? 'index.html' : rel));
    const file = candidate.startsWith(DIST) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
      ? candidate
      : path.join(DIST, 'index.html');
    res.setHeader('content-type', MIME[path.extname(file)] ?? 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

async function shoot(token: string, file: string, release: boolean): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  await page.addInitScript((value) => {
    localStorage.setItem('wavecode.access_token', value);
  }, token);
  await page.goto(`http://127.0.0.1:${PORT}/review`, { waitUntil: 'load' });
  await page.getByTestId('how-it-works').waitFor();
  if (release) {
    await page.getByTestId('view-release').click();
    await page.getByTestId('release-view').waitFor();
  } else {
    await page.getByTestId('lane-list').waitFor();
  }
  await page.screenshot({ path: file, fullPage: true });
  await browser.close();
}

const server = await startServer();
fs.mkdirSync(OUT, { recursive: true });
await shoot('antonio-token', path.join(OUT, 'reviews-my-lanes-antonio.png'), false);
await shoot('ales-token', path.join(OUT, 'reviews-my-lanes-ales.png'), false);
await shoot('antonio-token', path.join(OUT, 'reviews-release.png'), true);
server.close();
console.log('wrote', OUT);
