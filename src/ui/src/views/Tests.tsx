import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost } from '../hooks/useApi';
import { useSSE, type SSEEvent } from '../hooks/useSSE';
import type { Agent, TestPortalDoc, TestPortalState } from '../types';

/** `wave.countix-dev.claude5` → `claude5`; anything else → null. */
export function agentNameOf(label: string | null | undefined): string | null {
  if (!label) return null;
  const m = /^wave\.[^.]+\.([A-Za-z0-9][\w.-]*)$/.exec(label);
  return m ? m[1] : null;
}

export function fmtDuration(s: number | null | undefined): string {
  if (s == null) return '–';
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor(s / 60) % 60).padStart(2, '0')} min`;
}

function ago(iso: string | null): string {
  if (!iso) return '–';
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s} s ago` : `${Math.floor(s / 60)} min ago`;
}

const RESULT_TONE: Record<string, string> = {
  GREEN: 'text-emerald-300 border-emerald-500/40 bg-emerald-950/40',
  RED: 'text-red-300 border-red-500/40 bg-red-950/40',
  ERROR: 'text-amber-200 border-amber-500/40 bg-amber-950/40',
  ABORTED: 'text-slate-300 border-slate-600/50 bg-slate-900',
};

/**
 * Tests: the countix-testing portal inside WaveCode. Queue, active runs
 * against their budget, runner health, the newest results and the scaler.
 * The daemon polls the portal (tailnet only, no CORS) and tells this page
 * over SSE when something material changed; elapsed times tick locally.
 */
export default function Tests() {
  const navigate = useNavigate();
  const [state, setState] = useState<TestPortalState | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [now, setNow] = useState(Date.now());
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    apiGet<TestPortalState>('/tests/status').then((s) => setState(s ?? null)).catch(() => setState({ enabled: true, host: null, doc: null, fetched_at: null, error: 'daemon unreachable', next_in_s: 0, schema_ok: true }));
  }, []);
  useEffect(() => { load(); apiGet<Agent[]>('/agents').then((a) => setAgents(a ?? [])).catch(() => {}); }, [load]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const handleSSE = useCallback((event: SSEEvent) => { if (event.type === 'tests.portal') load(); }, [load]);
  useSSE(handleSSE);

  const agentIds = new Map(agents.map((a) => [a.name, a.id]));
  const agentLink = (label: string) => {
    const name = agentNameOf(label);
    const id = name ? agentIds.get(name) : undefined;
    if (!name) return <span className="text-slate-400">{label || 'unknown'}</span>;
    return id
      ? <button onClick={() => navigate(`/agent/${id}`)} className="text-cyan-300 hover:underline">{name}</button>
      : <span className="text-cyan-200/70">{name}</span>;
  };

  const refresh = async () => {
    setRefreshing(true);
    try { const s = await apiPost<TestPortalState>('/tests/status/refresh'); if (s) setState(s); } catch { /* the poller keeps going */ } finally { setRefreshing(false); }
  };

  const doc: TestPortalDoc | null = state?.doc ?? null;
  const elapsedOf = (startedAt: string | null, fallback: number | null) => (startedAt ? Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000)) : fallback);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <header className="sticky top-0 z-10 border-b border-slate-800/50 bg-slate-950/90 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <h1 className="text-sm font-bold tracking-[0.15em] text-slate-100 uppercase">Tests</h1>
          {state?.host && <span className="text-[10px] text-slate-500 font-mono">{state.host}</span>}
          <span className="ml-auto text-[10px] text-slate-500" data-testid="tests-fetched">
            {state?.error ? <span className="text-amber-300">status unavailable ({state.error}) · retry in {state.next_in_s} s</span> : state?.fetched_at ? `read ${ago(state.fetched_at)}` : ''}
          </span>
          <button onClick={() => void refresh()} disabled={refreshing} className="px-2 py-0.5 rounded border border-slate-700 text-[10px] font-semibold tracking-wider text-slate-300 hover:bg-slate-800 disabled:opacity-40">{refreshing ? '…' : 'REFRESH'}</button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-5 space-y-5 text-[11px]">
        {!state ? (
          <p className="text-[10px] text-slate-600 animate-pulse">Loading…</p>
        ) : !state.enabled ? (
          <p className="text-slate-500">No test portal configured (test_portal.url in config.yaml).</p>
        ) : !doc ? (
          <p className="text-slate-500">No snapshot yet{state.error ? `: ${state.error}` : ''}.</p>
        ) : (
          <>
            {!state.schema_ok && <p className="text-amber-300">The portal reports schema {doc.schema}; this page understands schema 1 and may be incomplete.</p>}

            {doc.alerts.length > 0 ? (
              <section className="rounded-lg border border-amber-500/40 bg-amber-950/30 px-4 py-3" data-testid="tests-alerts">
                <div className="text-[9px] uppercase tracking-wider text-amber-300 mb-1">Alerts</div>
                <ul className="space-y-0.5">{doc.alerts.map((a, i) => <li key={i}><span className="font-mono text-amber-200">{a.name}</span> <span className="text-amber-100/80">{a.detail}</span></li>)}</ul>
              </section>
            ) : (
              <p className="text-[10px] text-emerald-300/80" data-testid="tests-healthy">No alerts · {doc.runners.filter((r) => r.state === 'busy').length} of {doc.runners.length} runners busy · {doc.queue.length} queued</p>
            )}

            <div className="grid lg:grid-cols-2 gap-5">
              <section className="rounded-lg border border-slate-800/50 bg-slate-900/50 overflow-hidden" data-testid="tests-runs">
                <div className="px-4 py-2.5 border-b border-slate-800/50 flex items-center justify-between">
                  <h2 className="text-xs font-bold tracking-[0.2em] text-slate-300 uppercase">Running · {doc.runs.length}</h2>
                  <span className="text-[10px] text-slate-500">~ is the typical duration of that kind; amber past 1.5×, red past 2.5×</span>
                </div>
                <div className="p-3">
                  {doc.runs.length === 0 ? <p className="text-slate-600">nothing running</p> : (
                    <table className="w-full"><tbody className="divide-y divide-slate-800/50">
                      {doc.runs.map((r, i) => {
                        const el = elapsedOf(r.started_at, r.elapsed_s);
                        // typical duration (median of that kind) when the portal gives it, else the fixed budget
                        const typical = r.median_s ?? r.expected_s;
                        const pct = el == null ? 0 : Math.min(100, Math.round((el / Math.max(1, typical)) * 100));
                        const pace: '' | 'amber' | 'red' = r.pace ?? (el != null && el > 2.5 * typical ? 'red' : el != null && el > 1.5 * typical ? 'amber' : '');
                        const over = pace !== '';
                        const tone = pace === 'red' ? 'text-red-300' : pace === 'amber' ? 'text-amber-300' : 'text-slate-300';
                        const bar = pace === 'red' ? 'bg-red-500' : pace === 'amber' ? 'bg-amber-500' : 'bg-cyan-500';
                        return (
                          <tr key={`${r.place}-${i}`} data-testid={`run-${r.place}`}>
                            <td className="py-1.5 pr-2 font-mono text-slate-300">{r.place}</td>
                            <td className="py-1.5 pr-2">{agentLink(r.agent)}</td>
                            <td className="py-1.5 pr-2 text-slate-400">{r.tier}{r.lane && r.lane !== r.tier ? ` · ${r.lane}` : ''}</td>
                            <td className="py-1.5 pr-2 font-mono text-slate-500">{r.sha || '–'}</td>
                            <td className="py-1.5 w-40">
                              <div className={`flex items-center gap-2 ${tone}`} title={r.median_s != null ? `typical ${fmtDuration(r.median_s)} for ${r.tier || r.lane || 'this kind'} · fixed budget ${fmtDuration(r.expected_s)}` : `fixed budget ${fmtDuration(r.expected_s)}`}>
                                <div className="h-1.5 flex-1 rounded bg-slate-800 overflow-hidden"><div className={`h-full ${bar}`} style={{ width: `${pct}%` }} /></div>
                                <span className="font-mono whitespace-nowrap">{fmtDuration(el)} / ~{fmtDuration(typical)}{over ? ` ${pace}` : ''}</span>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody></table>
                  )}
                </div>
              </section>

              <section className="rounded-lg border border-slate-800/50 bg-slate-900/50 overflow-hidden" data-testid="tests-queue">
                <div className="px-4 py-2.5 border-b border-slate-800/50"><h2 className="text-xs font-bold tracking-[0.2em] text-slate-300 uppercase">Queued · {doc.queue.length}</h2></div>
                <div className="p-3">
                  {doc.queue.length === 0 ? <p className="text-slate-600">queue empty</p> : (
                    <table className="w-full"><tbody className="divide-y divide-slate-800/50">
                      {doc.queue.map((q, i) => (
                        <tr key={`${q.ticket}-${i}`}>
                          <td className="py-1.5 pr-2">{agentLink(q.agent)}</td>
                          <td className="py-1.5 pr-2 text-slate-400">{q.tier}{q.lane && q.lane !== q.tier ? ` · ${q.lane}` : ''}</td>
                          <td className="py-1.5 pr-2 font-mono text-slate-500">{q.sha || '–'}</td>
                          <td className="py-1.5 pr-2"><span className={`rounded border px-1 text-[9px] ${q.priority === 'gate' ? 'border-violet-500/40 text-violet-200' : 'border-slate-700 text-slate-400'}`}>{q.priority}</span></td>
                          <td className="py-1.5 text-right font-mono text-slate-300">waiting {fmtDuration(q.wait_s)}</td>
                        </tr>
                      ))}
                    </tbody></table>
                  )}
                </div>
              </section>
            </div>

            <section className="rounded-lg border border-slate-800/50 bg-slate-900/50 overflow-hidden" data-testid="tests-runners">
              <div className="px-4 py-2.5 border-b border-slate-800/50 flex items-center justify-between">
                <h2 className="text-xs font-bold tracking-[0.2em] text-slate-300 uppercase">Runners · {doc.runners.length}</h2>
                <span className="text-[10px] text-slate-500">
                  scaler {doc.scaler.mode}{doc.scaler.mode !== 'absent' ? ` · ${doc.scaler.actual} up, ${doc.scaler.desired} wanted` : ''}
                  {doc.scaler.eur_today != null ? ` · €${doc.scaler.eur_today.toFixed(2)} of €${doc.scaler.cap_eur.toFixed(0)} today${doc.scaler.cap_reached ? ' (cap reached)' : ''}` : ''}
                  {doc.scaler.mode === 'shadow' ? ' · shadow numbers, not real capacity' : ''}
                </span>
              </div>
              <div className="p-3 overflow-x-auto">
                <table className="w-full">
                  <thead className="text-[9px] uppercase tracking-wider text-slate-500"><tr><th className="text-left pr-2">Runner</th><th className="text-left pr-2">Type</th><th className="text-left pr-2">Health</th><th className="text-left pr-2">State</th><th className="text-right pr-2">Load</th><th className="text-right pr-2">Mem free</th><th className="text-right pr-2">Disk</th><th className="text-right">Age</th></tr></thead>
                  <tbody className="divide-y divide-slate-800/50">
                    {doc.runners.filter((r) => r.type !== 'gateway').map((r) => (
                      <tr key={r.name} data-testid={`runner-${r.name}`} className={r.health === 'unhealthy' ? 'bg-red-950/20' : ''}>
                        <td className="py-1.5 pr-2 font-mono text-slate-200">{r.name}{r.role && <span className="ml-1.5 text-[9px] font-sans text-slate-500">{r.role}</span>}{r.state === 'busy' && r.agent && <span className="ml-1.5 text-[9px] font-sans text-slate-500">· {agentNameOf(r.agent) ?? r.agent}{r.sha ? ` ${r.sha}` : ''}</span>}</td>
                        <td className="py-1.5 pr-2 text-slate-400">{r.server_type || (r.type && r.type !== 'legacy' && r.type !== 'main' ? r.type : '–')}</td>
                        <td className="py-1.5 pr-2"><span className={r.health === 'ok' ? 'text-emerald-300' : r.health === 'unhealthy' ? 'text-red-300' : 'text-slate-500'}>{r.health}</span>{r.preflight !== 'ok' && r.preflight !== r.health && <span className="ml-1 text-[9px] text-slate-500">preflight {r.preflight}</span>}</td>
                        <td className="py-1.5 pr-2"><span className={r.state === 'busy' ? 'text-cyan-200' : 'text-slate-400'}>{r.state}</span></td>
                        <td className="py-1.5 pr-2 text-right font-mono text-slate-300">{r.load == null ? '–' : r.load.toFixed(1)}</td>
                        <td className="py-1.5 pr-2 text-right font-mono text-slate-300">{r.mem_avail_gb == null ? '–' : `${r.mem_avail_gb.toFixed(0)} GB`}</td>
                        <td className="py-1.5 pr-2 text-right font-mono text-slate-300">{r.disk_used_pct == null ? '–' : `${r.disk_used_pct.toFixed(0)}%`}</td>
                        <td className="py-1.5 text-right font-mono text-slate-500">{fmtDuration(r.age_s)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="rounded-lg border border-slate-800/50 bg-slate-900/50 overflow-hidden" data-testid="tests-results">
              <div className="px-4 py-2.5 border-b border-slate-800/50"><h2 className="text-xs font-bold tracking-[0.2em] text-slate-300 uppercase">Recent results · {doc.results.length}</h2></div>
              <div className="p-3">
                {doc.results.length === 0 ? <p className="text-slate-600">no results yet</p> : (
                  <table className="w-full"><tbody className="divide-y divide-slate-800/50">
                    {doc.results.map((r, i) => (
                      <tr key={i}>
                        <td className="py-1 pr-2 w-20"><span className={`rounded border px-1.5 py-px text-[10px] font-semibold ${RESULT_TONE[r.result] ?? 'text-slate-400 border-slate-700'}`}>{r.result || 'UNKNOWN'}</span></td>
                        <td className="py-1 pr-2">{agentLink(r.agent)}</td>
                        <td className="py-1 pr-2 text-slate-400">{r.tier}</td>
                        <td className="py-1 pr-2 font-mono text-slate-500">{r.sha || '–'}</td>
                        <td className="py-1 pr-2 text-right font-mono text-slate-300">{fmtDuration(r.duration_s)}</td>
                        <td className="py-1 text-[9px] text-amber-300">{r.infra_error ? 'infra error' : ''}</td>
                      </tr>
                    ))}
                  </tbody></table>
                )}
              </div>
            </section>
            <p className="text-[10px] text-slate-600">Snapshot generated {ago(doc.generated_at)} by the portal; the daemon polls it every {state.next_in_s || 20} s.</p>
          </>
        )}
      </main>
    </div>
  );
}
