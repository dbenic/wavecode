import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost } from '../hooks/useApi';
import { useSSE, type SSEEvent } from '../hooks/useSSE';
import type { ReleaseRequest, ReviewItem } from '../types';
import { fileViewHref, internalLinkClickHandler } from '../utils/paths';

/** One row per reviewed lane: the freeze, its verdict and gate, what is on staging and in production, and the two actions. */
interface Lane {
  item: ReviewItem;
  staging: ReleaseRequest | null;
  production: ReleaseRequest | null;
}

function stateLabel(r: ReleaseRequest | null): { text: string; cls: string } {
  if (!r) return { text: '—', cls: 'text-slate-600' };
  switch (r.status) {
    case 'deployed': return { text: `deployed${r.version ? ` v${r.version}` : ''}`, cls: 'text-emerald-300' };
    case 'sent': return { text: 'in progress', cls: 'text-amber-300 animate-pulse' };
    case 'requested': return { text: 'requested', cls: 'text-amber-300' };
    case 'failed': return { text: 'failed', cls: 'text-red-300' };
    case 'rejected': return { text: 'rejected', cls: 'text-red-300' };
    default: return { text: r.status, cls: 'text-slate-400' };
  }
}

function when(iso: string): string {
  return iso.replace('T', ' ').slice(5, 16);
}

export default function Release() {
  const navigate = useNavigate();
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [releases, setReleases] = useState<ReleaseRequest[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(() => {
    Promise.all([apiGet<ReviewItem[]>('/reviews'), apiGet<ReleaseRequest[]>('/releases?limit=200')])
      .then(([r, rel]) => { setItems(r.filter((i) => i.freeze)); setReleases(rel); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSSE = useCallback((event: SSEEvent) => {
    if (event.type.startsWith('release.') || event.type.startsWith('review.') || event.type === 'run.finished') fetchData();
  }, [fetchData]);
  useSSE(handleSSE);

  const lanes: Lane[] = items.map((item) => {
    const sha = item.freeze!.sha;
    const forSha = releases.filter((r) => r.sha === sha);
    return {
      item,
      staging: forSha.find((r) => r.target === 'staging') ?? null,
      production: forSha.find((r) => r.target === 'production') ?? null,
    };
  });

  const act = async (lane: Lane, action: 'stage' | 'promote' | 'reject') => {
    setActing(`${lane.item.run.id}:${action}`);
    setError(null);
    try {
      if (action === 'reject') {
        const reason = window.prompt('Reject this freeze — reason:');
        if (reason === null) return;
        await apiPost(`/reviews/${lane.item.run.id}/reject`, { reason: reason.trim() });
      } else if (action === 'promote') {
        if (!window.confirm(`Send the PRODUCTION GO for ${lane.item.freeze!.sha.slice(0, 8)}${lane.item.freeze!.desk ? ` (Desk #${lane.item.freeze!.desk})` : ''}?`)) return;
        await apiPost(`/reviews/${lane.item.run.id}/promote`);
      } else {
        await apiPost(`/reviews/${lane.item.run.id}/stage`);
      }
      fetchData();
    } catch (e) {
      setError((e as Error).message || `${action} failed`);
    } finally {
      setActing(null);
    }
  };

  const openFile = internalLinkClickHandler(navigate);

  return (
    <div className="min-h-screen bg-slate-950">
      <header className="sticky top-0 z-40 border-b border-slate-800/60 bg-slate-950/90 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <button onClick={() => navigate('/')} className="text-slate-500 hover:text-slate-300 text-sm">&larr;</button>
          <div>
            <h1 className="text-sm font-bold tracking-[0.15em] text-slate-100 uppercase">Release</h1>
            <p className="text-[9px] text-slate-600 tracking-[0.3em] uppercase">{lanes.length} reviewed lane{lanes.length !== 1 ? 's' : ''} &middot; stage is automatic, promote is the production GO</p>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {error && <p className="text-[11px] text-red-400 border border-red-500/30 rounded px-3 py-2">{error}</p>}

        {!loaded ? (
          <p className="text-[10px] text-slate-600 tracking-[0.3em] uppercase animate-pulse py-16 text-center">Loading…</p>
        ) : lanes.length === 0 ? (
          <p className="text-[11px] text-slate-600 py-16 text-center">No reviewed lanes. A lane appears here once a freeze note or verdict file lands in the inbox.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-800/60">
            <table className="w-full text-[11px]" data-testid="lanes">
              <thead className="bg-slate-900/60 text-[9px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="text-left px-3 py-2">Lane</th>
                  <th className="text-left px-3 py-2">SHA</th>
                  <th className="text-left px-3 py-2">Review</th>
                  <th className="text-left px-3 py-2">Gate</th>
                  <th className="text-left px-3 py-2">Staging</th>
                  <th className="text-left px-3 py-2">Production</th>
                  <th className="text-right px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {lanes.map((lane) => {
                  const f = lane.item.freeze!;
                  const stale = f.status === 'stale';
                  const pass = f.verdict === 'pass';
                  const st = stateLabel(lane.staging);
                  const pr = stateLabel(lane.production);
                  const busy = (a: string) => acting === `${lane.item.run.id}:${a}`;
                  const openReq = (r: ReleaseRequest | null) => r && (r.status === 'sent' || r.status === 'requested');
                  return (
                    <tr key={lane.item.run.id} className={stale ? 'opacity-60' : ''} data-testid={`lane-${f.sha.slice(0, 8)}`}>
                      <td className="px-3 py-2 align-top">
                        <div className="text-slate-200">{f.project ?? '—'}{f.desk ? <span className="text-slate-400"> · Desk #{f.desk}</span> : null}</div>
                        <div className="font-mono text-[10px] text-slate-500">{f.lane ?? '—'}</div>
                        <div className="text-[10px] text-slate-500">@{f.author_name ?? '?'} → reviewed by @{f.reviewer_name ?? '?'}</div>
                      </td>
                      <td className="px-3 py-2 align-top font-mono text-slate-300" title={f.sha}>
                        {f.sha.slice(0, 10)}
                        {stale && <div className="text-[9px] text-slate-500">stale{f.superseded_by ? ` → ${f.superseded_by.slice(0, 8)}` : ''}</div>}
                        {f.status === 'merged' && <div className="text-[9px] text-emerald-400/80">on main</div>}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <span className={`text-[9px] font-bold tracking-wider rounded px-1.5 py-0.5 border ${pass ? 'text-emerald-300 border-emerald-500/40' : 'text-amber-300 border-amber-500/40'}`}>
                          {pass ? 'PASS' : (f.verdict ?? 'none').toUpperCase().replace('-', ' ')}
                        </span>
                        <div className="mt-1 flex gap-2 text-[9px]">
                          {f.freeze_path && <a href={fileViewHref(f.freeze_path)} onClick={openFile} className="text-sky-300 underline underline-offset-2">freeze</a>}
                          {f.verdict_path && <a href={fileViewHref(f.verdict_path)} onClick={openFile} className="text-sky-300 underline underline-offset-2">verdict</a>}
                        </div>
                      </td>
                      <td className="px-3 py-2 align-top">
                        {f.gate ? <span className={`text-[9px] font-bold ${f.gate === 'GREEN' ? 'text-emerald-300' : 'text-red-300'}`}>{f.gate}</span> : <span className="text-slate-600">—</span>}
                      </td>
                      <td className={`px-3 py-2 align-top ${st.cls}`}>
                        {st.text}
                        {lane.staging && <div className="text-[9px] text-slate-600">{when(lane.staging.updated_at)}{lane.staging.requested_by ? ` · ${lane.staging.requested_by}` : ''}</div>}
                        {lane.staging?.error && <div className="text-[9px] text-red-400/80 max-w-[14rem] truncate" title={lane.staging.error}>{lane.staging.error}</div>}
                      </td>
                      <td className={`px-3 py-2 align-top ${pr.cls}`}>
                        {pr.text}
                        {lane.production && <div className="text-[9px] text-slate-600">{when(lane.production.updated_at)}{lane.production.requested_by ? ` · ${lane.production.requested_by}` : ''}</div>}
                        {lane.production?.error && <div className="text-[9px] text-red-400/80 max-w-[14rem] truncate" title={lane.production.error}>{lane.production.error}</div>}
                      </td>
                      <td className="px-3 py-2 align-top text-right whitespace-nowrap">
                        <button
                          onClick={() => act(lane, 'stage')}
                          disabled={acting !== null || stale || !!openReq(lane.staging)}
                          title={stale ? 'Stale SHA: freeze the new one' : 'Automated deploy to staging, no GO'}
                          className="px-2 py-1 rounded border border-sky-500/30 text-[10px] font-semibold tracking-wider text-sky-300 hover:bg-sky-500/10 disabled:opacity-40"
                        >
                          {busy('stage') ? '...' : 'STAGE'}
                        </button>
                        <button
                          onClick={() => act(lane, 'promote')}
                          disabled={acting !== null || stale || !pass || !!openReq(lane.production) || lane.production?.status === 'deployed'}
                          title={!pass ? 'Needs an independent PASS on the exact SHA' : stale ? 'Stale SHA' : 'Production GO — sent to the deployer with your name'}
                          className="ml-1.5 px-2 py-1 rounded border border-emerald-500/30 text-[10px] font-semibold tracking-wider text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40"
                        >
                          {busy('promote') ? '...' : 'PROMOTE'}
                        </button>
                        <button
                          onClick={() => act(lane, 'reject')}
                          disabled={acting !== null}
                          className="ml-1.5 px-2 py-1 rounded border border-red-500/30 text-[10px] font-semibold tracking-wider text-red-300 hover:bg-red-500/10 disabled:opacity-40"
                        >
                          {busy('reject') ? '...' : 'REJECT'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {releases.length > 0 && (
          <section>
            <h2 className="text-[9px] uppercase tracking-[0.3em] text-slate-500 mb-2">History</h2>
            <ul className="divide-y divide-slate-800/40 rounded-lg border border-slate-800/60 text-[10px]" data-testid="history">
              {releases.slice(0, 50).map((r) => {
                const s = stateLabel(r);
                return (
                  <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1.5">
                    <span className="text-slate-600 tabular-nums">{when(r.created_at)}</span>
                    <span className={`font-semibold tracking-wider ${r.target === 'production' ? 'text-emerald-400' : 'text-sky-400'}`}>{r.target.toUpperCase()}</span>
                    <span className="text-slate-300">{r.project ?? ''}{r.desk ? ` Desk #${r.desk}` : ''}</span>
                    <span className="font-mono text-slate-400" title={r.sha}>{r.sha.slice(0, 8)}</span>
                    <span className={s.cls}>{s.text}</span>
                    {r.requested_by && <span className="text-slate-500">by {r.requested_by}</span>}
                    {(r.report ?? r.error) && <span className="text-slate-500 truncate max-w-[28rem]" title={r.report ?? r.error ?? ''}>{r.report ?? r.error}</span>}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}
