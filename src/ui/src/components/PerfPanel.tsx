import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../hooks/useApi';
import { useSSE, type SSEEvent } from '../hooks/useSSE';
import type { PerfSnapshot, User } from '../types';

const JOB_LABEL: Record<string, string> = {
  deploy_reconcile: 'deploy reconcile',
  overview_reconcile: 'overview snapshot',
  lane_board: 'lane board',
  event_prune: 'event prune',
};

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function fmtBytes(n: number | null): string {
  if (n == null) return '?';
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(0)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

function ago(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`;
}

/**
 * Settings → Health (admins): is the daemon keeping up? Event-loop lag, what
 * it forks per minute, how long the background jobs take, and how big the
 * journal is. Reads once, again on a lag or prune event, or on REFRESH.
 */
interface HealthLag {
  event_loop?: { p99_ms: number; max_ms: number };
}

export default function PerfPanel() {
  const [me, setMe] = useState<Pick<User, 'role'> | null>(null);
  const [snap, setSnap] = useState<PerfSnapshot | null>(null);
  const [lag, setLag] = useState<{ p99_ms: number; max_ms: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    apiGet<PerfSnapshot>('/health/perf')
      .then((s) => { if (s && s.at) { setSnap(s); setError(null); } else { setError('no reading yet — the daemon may be restarting; press REFRESH'); } })
      .catch((e) => setError((e as Error).message || 'unavailable'));
    apiGet<HealthLag>('/health').then((s) => {
      if (s?.event_loop && typeof s.event_loop.p99_ms === 'number') setLag(s.event_loop);
    }).catch(() => { /* the perf snapshot still paints */ });
  }, []);

  useEffect(() => {
    apiGet<User>('/me').then((u) => setMe(u ?? null)).catch(() => setMe(null));
  }, []);
  useEffect(() => { if (me?.role === 'admin') load(); }, [me, load]);

  const handleSSE = useCallback((event: SSEEvent) => {
    if (me?.role === 'admin' && (event.type === 'perf.lag' || event.type === 'events.pruned')) load();
  }, [me, load]);
  useSSE(handleSSE);

  if (me?.role !== 'admin') return null;

  const lagging = !!snap?.loop_ms && snap.loop_ms.p99 >= snap.lag_threshold_ms;
  const topSpawns = Object.entries(snap?.last_minute.spawns ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const jobs = Object.entries(snap?.jobs ?? {}).sort((a, b) => b[1].last_ms - a[1].last_ms);

  return (
    <section className="rounded-lg border border-slate-800/50 bg-slate-900/50 overflow-hidden" data-testid="perf-panel">
      <div className="px-4 py-3 border-b border-slate-800/50 flex items-center justify-between">
        <h2 className="text-xs font-bold tracking-[0.2em] text-slate-300 uppercase">Health · daemon</h2>
        <div className="flex items-center gap-3">
          {snap && <span className="text-[10px] text-slate-500">read {ago(snap.at)} · up {Math.floor(snap.uptime_s / 3600)} h</span>}
          <button onClick={load} className="px-2 py-0.5 rounded border border-slate-700 text-[10px] font-semibold tracking-wider text-slate-300 hover:bg-slate-800">REFRESH</button>
        </div>
      </div>
      <div className="p-4 space-y-3 text-[11px]">
        {error && <p className="text-red-400">{error}</p>}
        {!snap ? (
          <p className="text-[10px] text-slate-600 animate-pulse">Loading…</p>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div className={`rounded border px-3 py-2 ${lagging ? 'border-amber-500/50 bg-amber-500/10' : 'border-slate-800/60'}`} data-testid="health-panel">
                <div className="text-[9px] uppercase tracking-wider text-slate-500">Event loop</div>
                {lag ? (
                  <div className="text-slate-200" data-testid="health-loop">
                    p99 <span className="font-mono">{fmtMs(lag.p99_ms)}</span> · max <span className="font-mono">{fmtMs(lag.max_ms)}</span>
                  </div>
                ) : <div className="text-slate-500">no samples yet</div>}
              </div>
              <div className={`rounded border px-3 py-2 ${lagging ? 'border-amber-500/50 bg-amber-500/10' : 'border-slate-800/60'}`} data-testid="perf-loop">
                <div className="text-[9px] uppercase tracking-wider text-slate-500">Event loop (1 min)</div>
                {snap.loop_ms ? (
                  <div className={lagging ? 'text-amber-200' : 'text-slate-200'}>
                    p99 <span className="font-mono">{fmtMs(snap.loop_ms.p99)}</span> · max <span className="font-mono">{fmtMs(snap.loop_ms.max)}</span>
                    <div className="text-[10px] text-slate-500">p50 {fmtMs(snap.loop_ms.p50)} · lagging above {fmtMs(snap.lag_threshold_ms)}</div>
                  </div>
                ) : <div className="text-slate-500">no samples yet</div>}
              </div>
              <div className="rounded border border-slate-800/60 px-3 py-2">
                <div className="text-[9px] uppercase tracking-wider text-slate-500">Process</div>
                <div className="text-slate-200">cpu <span className="font-mono">{snap.cpu_pct == null ? '…' : `${snap.cpu_pct}%`}</span> · rss <span className="font-mono">{snap.rss_mb} MB</span></div>
              </div>
              <div className="rounded border border-slate-800/60 px-3 py-2" data-testid="perf-spawns">
                <div className="text-[9px] uppercase tracking-wider text-slate-500">Child processes (1 min)</div>
                <div className="text-slate-200">
                  <span className="font-mono">{Object.values(snap.last_minute.spawns).reduce((a, b) => a + b, 0)}</span> forks
                  · <span className="font-mono">{snap.last_minute.sync_spawns}</span> blocking, <span className="font-mono">{fmtMs(snap.last_minute.sync_blocked_ms)}</span>
                </div>
                <div className="text-[10px] text-slate-500">15 min: {Object.values(snap.last_15_min.spawns).reduce((a, b) => a + b, 0)} forks, {fmtMs(snap.last_15_min.sync_blocked_ms)} blocked</div>
              </div>
              <div className="rounded border border-slate-800/60 px-3 py-2" data-testid="perf-storage">
                <div className="text-[9px] uppercase tracking-wider text-slate-500">Journal</div>
                <div className="text-slate-200"><span className="font-mono">{snap.storage.events.toLocaleString()}</span> events · db <span className="font-mono">{fmtBytes(snap.storage.db_bytes)}</span></div>
                <div className="text-[10px] text-slate-500">{snap.storage.events_short_lived.toLocaleString()} output ticks · {snap.storage.freezes} freezes · {snap.storage.runs} runs</div>
              </div>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <div className="text-[9px] uppercase tracking-wider text-slate-500 mb-1">Forks per minute by command</div>
                {topSpawns.length === 0 ? <div className="text-slate-600">none this minute</div> : (
                  <table className="w-full"><tbody>
                    {topSpawns.map(([cmd, n]) => (
                      <tr key={cmd}><td className="font-mono text-slate-300 py-0.5">{cmd}</td><td className="text-right font-mono text-slate-400">{n}</td></tr>
                    ))}
                  </tbody></table>
                )}
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-wider text-slate-500 mb-1">Background jobs</div>
                {jobs.length === 0 ? <div className="text-slate-600">none run yet</div> : (
                  <table className="w-full"><tbody>
                    {jobs.map(([name, j]) => (
                      <tr key={name} data-testid={`job-${name}`}>
                        <td className="text-slate-300 py-0.5">{JOB_LABEL[name] ?? name}</td>
                        <td className="text-right font-mono text-slate-400">{fmtMs(j.last_ms)}</td>
                        <td className="text-right text-[10px] text-slate-600 pl-2">max {fmtMs(j.max_ms)} · {ago(j.last_at)}</td>
                      </tr>
                    ))}
                  </tbody></table>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
