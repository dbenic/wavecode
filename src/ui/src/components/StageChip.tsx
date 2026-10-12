import { useEffect, useState } from 'react';

/**
 * Live staging deploy chip. Phases follow schema v1:
 * queued → lock → fetch → build (tests, checkout, deps, reload sit here) → verify → pin.
 * Success and failure stay on the release record, so a reload shows the same state.
 */

export interface StageProgress {
  sha: string;
  status: string;
  phase?: string | null;
  progress?: string | null;
  version?: string | null;
  pinUntil?: string | null;
  url?: string | null;
  error?: string | null;
  rollbackStatus?: string | null;
}

const PIPE = ['queued', 'lock', 'fetch', 'build', 'verify', 'pin'] as const;
const MIDDLE = new Set(['tests', 'predeploy_dump', 'checkout', 'deps', 'build', 'reload_migrate']);
const RANK: Record<string, number> = {
  queued: 0, lock: 1, fetch: 2, tests: 3, predeploy_dump: 4, checkout: 5, deps: 6,
  build: 7, reload_migrate: 8, verify: 9, pin: 10, done: 11, failed: 11,
};

const seenStatus = new Map<string, string>();
const toasted = new Set<string>();
const animated = new Set<string>();

export function resetStageChipSessionForTest(): void {
  seenStatus.clear();
  toasted.clear();
  animated.clear();
}

function noteTransition(key: string, status: string): boolean {
  const prev = seenStatus.get(key);
  seenStatus.set(key, status);
  if (!prev || prev === 'deployed' || status !== 'deployed' || toasted.has(key)) return false;
  toasted.add(key);
  return true;
}

function httpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function pinClock(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function slotOf(phase: string): (typeof PIPE)[number] {
  if (MIDDLE.has(phase)) return 'build';
  if ((PIPE as readonly string[]).includes(phase)) return phase as (typeof PIPE)[number];
  return 'build';
}

export default function StageChip({ progress, releaseId }: { progress: StageProgress; releaseId?: string }) {
  const key = releaseId || progress.sha;
  const [burst, setBurst] = useState(false);
  const [toast, setToast] = useState(false);
  const link = httpUrl(progress.url);
  const pin = pinClock(progress.pinUntil);
  const sha9 = progress.sha.slice(0, 9);
  const version = progress.version ? `v${progress.version}` : '';

  useEffect(() => {
    if (progress.status !== 'deployed' || animated.has(key)) return;
    animated.add(key);
    setBurst(true);
    const timer = window.setTimeout(() => setBurst(false), 1600);
    return () => window.clearTimeout(timer);
  }, [key, progress.status]);

  useEffect(() => {
    if (!noteTransition(key, progress.status)) return;
    setToast(true);
    const timer = window.setTimeout(() => setToast(false), 6500);
    return () => window.clearTimeout(timer);
  }, [key, progress.status]);

  const toastLine = `On staging: ${sha9}${version ? ` ${version}` : ''}`;

  return (
    <span className="inline-flex flex-col items-start gap-0.5 max-w-full">
      {progress.status === 'deployed' ? (
        <span data-testid="stage-chip" className="inline-flex flex-col gap-0.5">
          <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-emerald-300">
            <span className="relative inline-flex h-3.5 w-3.5 items-center justify-center" data-testid="staging-success">
              {burst && <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400/50 animate-ping" />}
              <span className={`relative ${burst ? 'animate-pulse' : ''}`}>✓</span>
            </span>
            {toastLine}
          </span>
          {link && (
            <a href={link} target="_blank" rel="noreferrer" className="text-[10px] text-sky-300 underline underline-offset-2">Open staging</a>
          )}
          {pin && <span className="text-[9px] text-slate-400">pinned until {pin}</span>}
        </span>
      ) : progress.status === 'failed' ? (
        <span data-testid="stage-chip" className="inline-flex flex-col gap-0.5 rounded border border-red-500/50 bg-red-950/50 px-2 py-1 text-[10px] text-red-200">
          <span className="font-semibold tracking-wider">Failed at {progress.phase || 'staging'}</span>
          {progress.error && <span className="text-red-300/90 break-words">{progress.error}</span>}
          <span>rollback {progress.rollbackStatus || 'unknown'}</span>
        </span>
      ) : (
        <Pipeline progress={progress} />
      )}
      {toast && (
        <span
          data-testid="staging-toast"
          className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-emerald-400/40 bg-slate-950/95 px-3 py-2 text-[12px] text-emerald-100 shadow-lg shadow-emerald-900/40"
        >
          {toastLine}
          {link ? <> — <a href={link} target="_blank" rel="noreferrer" className="underline">Open staging</a></> : null}
          {pin ? <span className="mt-0.5 block text-[10px] text-slate-300">pinned until {pin}</span> : null}
        </span>
      )}
    </span>
  );
}

function slotEnd(slot: (typeof PIPE)[number]): number {
  if (slot === 'build') return RANK.reload_migrate;
  return RANK[slot];
}

function Pipeline({ progress }: { progress: StageProgress }) {
  const phase = progress.phase || 'queued';
  const state = progress.progress || 'start';
  const currentRank = RANK[phase] ?? 0;
  const currentSlot = slotOf(phase);
  return (
    <span data-testid="stage-chip" className="inline-flex flex-wrap items-center gap-1" title="queued → lock → fetch → build → verify → pin">
      {PIPE.map((slot, i) => {
        const past = currentRank > slotEnd(slot);
        const active = slot === currentSlot;
        const label = slot === 'build' && active && phase !== 'build' && MIDDLE.has(phase) ? phase : slot;
        const cls = active && state === 'fail'
          ? 'text-red-300 border-red-500/50'
          : active && (state === 'start' || state === 'heartbeat')
            ? 'text-amber-200 border-amber-400/50 animate-pulse'
            : past || (active && (state === 'ok' || state === 'skip'))
              ? 'text-emerald-300 border-emerald-500/30'
              : 'text-slate-600 border-slate-800';
        return (
          <span key={slot} className="inline-flex items-center gap-1">
            {i > 0 && <span className="text-[8px] text-slate-700">{slot === 'verify' ? '…' : '›'}</span>}
            <span data-testid={`phase-${slot}`} className={`rounded border px-1 py-0.5 text-[9px] font-semibold tracking-wide ${cls}`}>{label}</span>
          </span>
        );
      })}
    </span>
  );
}
