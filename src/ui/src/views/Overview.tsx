import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost } from '../hooks/useApi';
import { useSSE, type SSEEvent } from '../hooks/useSSE';
import type { Board, OverlordReport, OverviewResponse, Recommendation } from '../types';

function ago(min: number | null): string {
  if (min === null) return '';
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h`;
  return `${Math.round(min / 1440)} d`;
}

const STATUS_CLS: Record<string, string> = {
  working: 'text-amber-300 border-amber-500/40',
  idle: 'text-emerald-300 border-emerald-500/40',
  error: 'text-red-300 border-red-500/40',
};

const KIND_CLS: Record<string, string> = {
  promote: 'text-emerald-300 border-emerald-500/40',
  stage: 'text-sky-300 border-sky-500/40',
  reject: 'text-red-300 border-red-500/40',
  nudge: 'text-amber-300 border-amber-500/40',
  reassign: 'text-violet-300 border-violet-500/40',
  refreeze: 'text-amber-300 border-amber-500/40',
  info: 'text-slate-400 border-slate-600/40',
};

/** The board (what every agent is doing, what every lane needs) plus the overlord's latest report. */
export default function Overview() {
  const navigate = useNavigate();
  const [board, setBoard] = useState<Board | null>(null);
  const [report, setReport] = useState<OverlordReport | null>(null);
  const [overlord, setOverlord] = useState<OverviewResponse['overlord'] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(() => {
    apiGet<OverviewResponse>('/overview')
      .then((r) => { setBoard(r.board); setReport(r.report); setOverlord(r.overlord); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSSE = useCallback((event: SSEEvent) => {
    if (/^(overlord|release|review|run|agent)\./.test(event.type)) fetchData();
  }, [fetchData]);
  useSSE(handleSSE);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setActing(key);
    setError(null);
    try {
      await fn();
      fetchData();
    } catch (e) {
      setError((e as Error).message || 'action failed');
    } finally {
      setActing(null);
    }
  };

  const runRecommendation = (r: Recommendation, i: number) => {
    const key = `rec-${i}`;
    if ((r.kind === 'promote' || r.kind === 'stage' || r.kind === 'reject') && r.run_id) {
      const runId = r.run_id;
      if (r.kind === 'promote' && !window.confirm(`Send the PRODUCTION GO for ${r.sha?.slice(0, 8) ?? 'this lane'}?`)) return;
      if (r.kind === 'reject') {
        const reason = window.prompt('Reject — reason:');
        if (reason === null) return;
        return act(key, () => apiPost(`/reviews/${runId}/reject`, { reason: reason.trim() }));
      }
      return act(key, () => apiPost(`/reviews/${runId}/${r.kind}`));
    }
    if (r.kind === 'nudge' && r.agent_id) {
      const agentId = r.agent_id;
      return act(key, () => apiPost(`/agents/${agentId}/send`, { text: `[Overlord] ${r.text}` }));
    }
  };

  const noteFor = (agentId: string) => report?.agents.find((a) => a.id === agentId)?.note ?? null;

  return (
    <div className="min-h-screen bg-slate-950">
      <header className="sticky top-0 z-40 border-b border-slate-800/60 bg-slate-950/90 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/')} className="text-slate-500 hover:text-slate-300 text-sm">&larr;</button>
            <div>
              <h1 className="text-sm font-bold tracking-[0.15em] text-slate-100 uppercase">Overview</h1>
              {board && (
                <p className="text-[9px] text-slate-600 tracking-[0.3em] uppercase">
                  {board.counts.working} working &middot; {board.counts.idle} idle{board.counts.error ? ` · ${board.counts.error} error` : ''} &middot; {board.counts.open_lanes} lanes &middot; {board.counts.promotable} promotable
                </p>
              )}
            </div>
          </div>
          {overlord && (
            <div className="flex items-center gap-2 text-[10px]">
              <span className={`rounded px-1.5 py-0.5 border ${overlord.enabled ? 'text-violet-300 border-violet-500/40' : 'text-slate-500 border-slate-700'}`}>
                OVERLORD {overlord.enabled ? overlord.model : 'off'}
              </span>
              {overlord.enabled && (
                <button
                  onClick={() => act('wake', () => apiPost('/overview/wake', {}))}
                  disabled={acting !== null}
                  className="px-2 py-0.5 rounded border border-violet-500/30 text-violet-300 font-semibold tracking-wider hover:bg-violet-500/10 disabled:opacity-40"
                >
                  {acting === 'wake' ? '...' : 'ASK NOW'}
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {error && <p className="text-[11px] text-red-400 border border-red-500/30 rounded px-3 py-2">{error}</p>}
        {!loaded || !board ? (
          <p className="text-[10px] text-slate-600 tracking-[0.3em] uppercase animate-pulse py-16 text-center">Loading…</p>
        ) : (
          <>
            {/* Overlord report */}
            <section className="rounded-lg border border-violet-500/25 bg-violet-950/10 p-3 space-y-2" data-testid="overlord-report">
              <div className="flex items-center justify-between text-[10px]">
                <span className="font-semibold tracking-wider text-violet-300">OVERLORD</span>
                {report ? <span className="text-slate-500">{report.created_at.slice(0, 16)} · {report.trigger}</span> : <span className="text-slate-600">no report yet</span>}
              </div>
              {report?.digest && <p className="text-[12px] text-slate-200 whitespace-pre-wrap">{report.digest}</p>}
              {report && report.plan.length > 0 && (
                <div className="space-y-1" data-testid="release-plan">
                  <p className="text-[9px] font-semibold tracking-wider text-slate-500">RELEASE PLAN</p>
                  {report.plan.map((g, i) => (
                    <div key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px]">
                      <span className={`text-[9px] font-bold tracking-wider rounded px-1.5 py-0.5 border uppercase ${g.target === 'production' ? 'text-emerald-300 border-emerald-500/40' : g.target === 'hold' ? 'text-amber-300 border-amber-500/40' : 'text-sky-300 border-sky-500/40'}`}>{g.target}</span>
                      <span className="text-slate-200">{g.title}</span>
                      <span className="font-mono text-[10px] text-slate-500">{g.shas.map((s) => s.slice(0, 8)).join(' → ')}</span>
                      <span className="text-slate-400 basis-full">{g.why}</span>
                    </div>
                  ))}
                </div>
              )}
              {report && report.recommendations.length > 0 && (
                <ul className="space-y-1.5">
                  {report.recommendations.map((r, i) => {
                    const actionable = ((r.kind === 'promote' || r.kind === 'stage' || r.kind === 'reject') && r.run_id) || (r.kind === 'nudge' && r.agent_id);
                    return (
                      <li key={i} className="flex items-start gap-2 text-[11px]">
                        <span className={`shrink-0 text-[9px] font-bold tracking-wider rounded px-1.5 py-0.5 border uppercase ${KIND_CLS[r.kind] ?? KIND_CLS.info}`}>{r.kind}</span>
                        <span className="text-slate-300 flex-1">{r.text}</span>
                        {actionable && (
                          <button
                            onClick={() => runRecommendation(r, i)}
                            disabled={acting !== null}
                            className="shrink-0 px-2 py-0.5 rounded border border-slate-600 text-[9px] font-semibold tracking-wider text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                          >
                            {acting === `rec-${i}` ? '...' : 'DO IT'}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {!overlord?.enabled && <p className="text-[10px] text-slate-600">Enable with <code className="text-slate-400">overlord.enabled: true</code> and an LLM key in config.yaml. The board below works without it.</p>}
            </section>

            {/* Attention */}
            {board.attention.length > 0 && (
              <section className="rounded-lg border border-amber-500/25 bg-amber-950/10 p-3" data-testid="attention">
                <p className="text-[10px] font-semibold tracking-wider text-amber-300 mb-1.5">NEEDS A DECISION</p>
                <ul className="space-y-1 text-[11px] text-slate-300">
                  {board.attention.map((a, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <span className="text-[9px] text-amber-400/80 uppercase tracking-wider w-28 shrink-0">{a.kind.replace(/_/g, ' ')}</span>
                      <span className="flex-1">{a.text}</span>
                      {a.run_id && (a.kind === 'promotable') && (
                        <button onClick={() => navigate('/release')} className="text-[9px] text-emerald-300 underline underline-offset-2">release</button>
                      )}
                      {a.agent_id && (
                        <button onClick={() => navigate(`/agent/${a.agent_id}`)} className="text-[9px] text-sky-300 underline underline-offset-2">open</button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Agents */}
            <section>
              <p className="text-[9px] uppercase tracking-[0.3em] text-slate-500 mb-2">Agents</p>
              <div className="overflow-x-auto rounded-lg border border-slate-800/60">
                <table className="w-full text-[11px]" data-testid="agents">
                  <thead className="bg-slate-900/60 text-[9px] uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="text-left px-3 py-2">Agent</th>
                      <th className="text-left px-3 py-2">Status</th>
                      <th className="text-left px-3 py-2">Doing</th>
                      <th className="text-left px-3 py-2">Last reply</th>
                      <th className="text-left px-3 py-2">Blocked on</th>
                      <th className="text-left px-3 py-2">Usage</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    {board.agents.map((a) => {
                      const note = noteFor(a.id);
                      return (
                        <tr key={a.id} className="align-top" data-testid={`agent-${a.name}`}>
                          <td className="px-3 py-2">
                            <button onClick={() => navigate(`/agent/${a.id}`)} className="text-cyan-300 hover:text-cyan-200">@{a.alias ?? a.name}</button>
                            <div className="text-[9px] text-slate-600">{a.runtime}{a.model ? ` · ${a.model}` : ''}</div>
                          </td>
                          <td className="px-3 py-2">
                            <span className={`text-[9px] font-bold tracking-wider rounded px-1.5 py-0.5 border ${STATUS_CLS[a.status] ?? ''}`}>{a.status.toUpperCase()}</span>
                            <div className="text-[9px] text-slate-600">{ago(a.for_min)}</div>
                          </td>
                          <td className="px-3 py-2 max-w-[22rem]">
                            {a.current ? (
                              <div className="text-slate-300 line-clamp-2" title={a.current.prompt}>{a.current.num ? `#${a.current.num} ` : ''}{a.current.prompt}</div>
                            ) : <span className="text-slate-600">—</span>}
                            {note && <div className="text-[10px] text-violet-300/90 mt-0.5">{note}</div>}
                          </td>
                          <td className="px-3 py-2 max-w-[22rem]">
                            {a.last_reply ? <div className="text-slate-400 line-clamp-2" title={a.last_reply.text}>{a.last_reply.text}</div> : <span className="text-slate-600">—</span>}
                          </td>
                          <td className="px-3 py-2">{a.blocked_on ? <span className="text-amber-300">{a.blocked_on}</span> : <span className="text-slate-600">—</span>}</td>
                          <td className="px-3 py-2 text-slate-400">{a.usage ?? '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Lanes */}
            <section>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[9px] uppercase tracking-[0.3em] text-slate-500">Lanes</p>
                <button onClick={() => navigate('/release')} className="text-[10px] text-sky-300 underline underline-offset-2">Release view</button>
              </div>
              {board.lanes.length === 0 ? (
                <p className="text-[11px] text-slate-600">No reviewed lanes.</p>
              ) : (
                <ul className="divide-y divide-slate-800/50 rounded-lg border border-slate-800/60 text-[11px]" data-testid="lanes">
                  {board.lanes.map((l) => (
                    <li key={l.sha} className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 ${l.status === 'stale' ? 'opacity-60' : ''}`}>
                      <span className="text-slate-200">{l.project ?? '—'}{l.desk ? ` · Desk #${l.desk}` : ''}</span>
                      <span className="font-mono text-slate-400" title={l.sha}>{l.sha.slice(0, 8)}</span>
                      <span className="font-mono text-[10px] text-slate-600">{l.lane ?? ''}</span>
                      <span className={`text-[9px] font-bold tracking-wider rounded px-1.5 py-0.5 border ${l.verdict === 'pass' ? 'text-emerald-300 border-emerald-500/40' : 'text-amber-300 border-amber-500/40'}`}>{(l.verdict ?? 'none').toUpperCase().replace('-', ' ')}</span>
                      {l.gate && <span className={`text-[9px] font-bold ${l.gate === 'GREEN' ? 'text-emerald-300' : 'text-red-300'}`}>{l.gate}</span>}
                      <span className="text-[10px] text-slate-500">staging: {l.staging?.status ?? '—'} · prod: {l.production?.status ?? '—'}</span>
                      <span className="text-[10px] text-slate-400 ml-auto">{l.next}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
