/**
 * Subscription usage without spending agent tokens: every
 * `usage.probe_interval_min` (default 15) WaveCode types the CLI's own status
 * command into ONE idle agent per (runtime, profile) — `/status` for Codex,
 * `/usage` for Claude Code — reads the screen, closes it with Escape, and
 * stores the numbers. The header shows "65% left · resets 14 Oct 05:58".
 * Nothing is sent to a model; the status screen is local to the CLI.
 */

import { getConfig } from './config.js';
import { getDb, listAgents, type Agent } from './db.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import * as tmux from './tmux.js';
import { getRuntimeState } from './runtime-liveness.js';

export interface UsageMetric { label: string; left_pct: number | null; used_pct: number | null; resets: string | null; extra?: string }
export interface ProfileUsage {
  runtime: string;
  profile: string;            // 'home' for the service user's own login
  summary: string;            // one short line for the badge
  metrics: UsageMetric[];
  probed_at: string;
}

const PROBE_COMMAND: Record<string, string> = { codex: '/status', 'claude-code': '/usage' };
const SCREEN_WAIT_MS = 4000;
const CAPTURE_LINES = 90;
const TICK_MS = 60_000;

export function ensureUsageTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS profile_usage (
      runtime TEXT NOT NULL,
      profile TEXT NOT NULL,
      data TEXT NOT NULL,
      probed_at TEXT NOT NULL,
      PRIMARY KEY (runtime, profile)
    );
  `);
}

export function usageFor(runtime: string, profile: string | null | undefined): ProfileUsage | null {
  try {
    const row = getDb().prepare('SELECT data FROM profile_usage WHERE runtime = ? AND profile = ?').get(runtime, profile ?? 'home') as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as ProfileUsage) : null;
  } catch {
    return null;
  }
}

// --- parsers (exported for tests) ---

export function parseCodexStatus(screen: string): UsageMetric[] {
  const out: UsageMetric[] = [];
  const weekly = /Weekly limit:\s*\[[^\]]*\]\s*(\d+)% left \(resets ([^)]+)\)/.exec(screen);
  if (weekly) out.push({ label: 'weekly', left_pct: Number(weekly[1]), used_pct: 100 - Number(weekly[1]), resets: weekly[2].trim() });
  const fiveH = /5h limit:\s*\[[^\]]*\]\s*(\d+)% left \(resets ([^)]+)\)/.exec(screen);
  if (fiveH) out.push({ label: '5h', left_pct: Number(fiveH[1]), used_pct: 100 - Number(fiveH[1]), resets: fiveH[2].trim() });
  const ctx = /Context window:\s*(\d+)% left/.exec(screen);
  if (ctx) out.push({ label: 'context', left_pct: Number(ctx[1]), used_pct: 100 - Number(ctx[1]), resets: null });
  const credits = /Credits:\s*([\d,.]+ credits)/.exec(screen);
  if (credits) out.push({ label: 'credits', left_pct: null, used_pct: null, resets: null, extra: credits[1] });
  return out;
}

export function parseClaudeUsage(screen: string): UsageMetric[] {
  const lines = screen.split('\n').map((l) => l.trim());
  const out: UsageMetric[] = [];
  const block = (header: RegExp, label: string) => {
    const i = lines.findIndex((l) => header.test(l));
    if (i === -1) return;
    const window = lines.slice(i + 1, i + 5);
    const used = window.map((l) => /(\d+)% used/.exec(l)).find(Boolean);
    const resets = window.map((l) => /^Resets (.+)$/.exec(l)).find(Boolean);
    if (used) out.push({ label, left_pct: 100 - Number(used[1]), used_pct: Number(used[1]), resets: resets ? resets[1].trim() : null });
  };
  block(/^Current session$/, '5h');
  block(/^Current week \(all models\)$/, 'weekly');
  block(/^Current week \((?!all models)[^)]+\)$/, 'weekly-model');
  const creditsIdx = lines.findIndex((l) => /^Usage credits$/.test(l));
  if (creditsIdx !== -1) {
    const window = lines.slice(creditsIdx + 1, creditsIdx + 4);
    const used = window.map((l) => /(\d+)% used/.exec(l)).find(Boolean);
    const spent = window.map((l) => /^(.+?) spent(?: · Resets (.+))?$/.exec(l)).find(Boolean);
    if (used || spent) out.push({ label: 'credits', left_pct: used ? 100 - Number(used[1]) : null, used_pct: used ? Number(used[1]) : null, resets: spent?.[2]?.trim() ?? null, extra: spent?.[1]?.trim() });
  }
  return out;
}

export function summarize(metrics: UsageMetric[]): string {
  const weekly = metrics.find((m) => m.label === 'weekly');
  const five = metrics.find((m) => m.label === '5h');
  const parts: string[] = [];
  if (weekly?.left_pct !== null && weekly?.left_pct !== undefined) parts.push(`${weekly.left_pct}% left${weekly.resets ? ` · resets ${shortReset(weekly.resets)}` : ''}`);
  if (five?.used_pct !== null && five?.used_pct !== undefined) parts.push(`5h ${five.used_pct}% used`);
  return parts.join(' · ');
}

function shortReset(text: string): string {
  // "5:58 AM on 14 Oct" → "14 Oct 5:58 AM"; "Oct 14, 1:59am (UTC)" → "Oct 14 1:59am"
  const m = /^(.+?) on (.+)$/.exec(text);
  if (m) return `${m[2]} ${m[1]}`;
  return text.replace(/\s*\(UTC\)\s*$/, '').replace(/,\s*/, ' ');
}

// --- probing ---

const lastProbe = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | null = null;

function key(runtime: string, profile: string | null | undefined): string {
  return `${runtime}:${profile ?? 'home'}`;
}

/** One idle agent per (runtime, profile) whose probe is due. */
export function pickProbeTargets(agents: Agent[], now = Date.now(), intervalMs = 15 * 60_000): Agent[] {
  const chosen = new Map<string, Agent>();
  for (const a of agents) {
    if (!PROBE_COMMAND[a.runtime]) continue;
    if (a.status !== 'idle' || a.mode === 'file') continue;
    const k = key(a.runtime, a.profile);
    if (chosen.has(k)) continue;
    const last = lastProbe.get(k) ?? 0;
    if (now - last < intervalMs) continue;
    chosen.set(k, a);
  }
  return [...chosen.values()];
}

export async function probeAgent(agent: Agent): Promise<ProfileUsage | null> {
  const cmd = PROBE_COMMAND[agent.runtime];
  if (!cmd) return null;
  if (getRuntimeState(agent) !== 'alive') return null;
  const k = key(agent.runtime, agent.profile);
  lastProbe.set(k, Date.now());
  try {
    tmux.sendTextAndEnter(agent.tmux_session, cmd, { mode: 'type' });
    await sleep(SCREEN_WAIT_MS);
    const pane = tmux.capturePane(agent.tmux_session, CAPTURE_LINES);
    // close the overlay (Claude) / no-op at the prompt (Codex)
    tmux.sendRawKey(agent.tmux_session, 'Escape');
    await sleep(400);
    tmux.sendRawKey(agent.tmux_session, 'Escape');
    if (!pane.ok) return null;
    const metrics = agent.runtime === 'codex' ? parseCodexStatus(pane.data) : parseClaudeUsage(pane.data);
    if (metrics.length === 0) {
      logger.info({ agentId: agent.id, runtime: agent.runtime }, 'Usage probe: nothing parsable on screen');
      return null;
    }
    const usage: ProfileUsage = { runtime: agent.runtime, profile: agent.profile ?? 'home', summary: summarize(metrics), metrics, probed_at: new Date().toISOString() };
    getDb().prepare(`INSERT INTO profile_usage (runtime, profile, data, probed_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(runtime, profile) DO UPDATE SET data = excluded.data, probed_at = excluded.probed_at`)
      .run(usage.runtime, usage.profile, JSON.stringify(usage), usage.probed_at);
    emit('usage.probed', 'agent', agent.id, { runtime: usage.runtime, profile: usage.profile, summary: usage.summary, metrics }, null);
    return usage;
  } catch (e) {
    logger.warn({ agentId: agent.id, error: (e as Error).message }, 'Usage probe failed');
    return null;
  }
}

export async function probeDue(): Promise<void> {
  const cfg = getConfig();
  const minutes = cfg.usage?.probe_interval_min ?? 15;
  if (!minutes || minutes <= 0) return;
  for (const agent of pickProbeTargets(listAgents(), Date.now(), minutes * 60_000)) {
    await probeAgent(agent);
  }
}

export function startUsageProbe(): void {
  if (timer) return;
  timer = setInterval(() => { void probeDue(); }, TICK_MS);
  setTimeout(() => { void probeDue(); }, 20_000); // first pass shortly after boot
}

export function stopUsageProbe(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function resetUsageProbeForTest(): void {
  lastProbe.clear();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
