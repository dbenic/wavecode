import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost } from '../hooks/useApi';
import { useSSE, type SSEEvent } from '../hooks/useSSE';
import type { AuditEntry, Board, CandidateRow, LaneBoardRow, OverviewResponse, ReviewItem } from '../types';
import { fileViewHref, internalLinkClickHandler } from '../utils/paths';

/**
 * Releases follow the deployer's model: a composed candidate is the unit that goes to
 * production (one combined gate), a lane is reviewed work that gets staged on its own and
 * waits to be composed. Stale and merged lanes are hidden unless asked for.
 */

function cellLabel(r: LaneBoardRow['staging']): { text: string; cls: string } {
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

function when(iso: string | null): string {
  return iso ? iso.replace('T', ' ').slice(5, 16) : '';
}

const ACTION_CLS: Record<AuditEntry['action'], string> = {
  promote: 'text-emerald-300',
  deployed: 'text-emerald-300',
  stage: 'text-sky-300',
  'auto-stage': 'text-sky-300',
  verify: 'text-violet-300',
  reject: 'text-red-300',
  failed: 'text-red-300',
};

export default function Release() {
  const navigate = useNavigate();
  const [board, setBoard] = useState<Board | null>(null);
  const [cards, setCards] = useState<Map<string, ReviewItem>>(new Map());
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [showStale, setShowStale] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(() => {
    Promise.all([apiGet<OverviewResponse>('/overview'), apiGet<ReviewItem[]>('/reviews'), apiGet<AuditEntry[]>('/releases/audit?limit=100')])
      .then(([ov, items, au]) => {
        setBoard(ov.board);
        setCards(new Map(items.filter((i) => i.freeze).map((i) => [i.freeze!.sha, i])));
        setAudit(au);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSSE = useCallback((event: SSEEvent) => {
    if (event.type.startsWith('release.') || event.type.startsWith('review.') || event.type === 'run.finished') fetchData();
  }, [fetchData]);
  useSSE(handleSSE);

  const run = async (key: string, fn: () => Promise<unknown>) => {
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

  const verify = (sha: string, project: string | null, label: string) => {
    const note = window.prompt(`Verified on staging — what did you check for ${label}? (optional note)`);
    if (note === null) return;
    return run(`verify:${sha}`, () => apiPost('/releases/verify', { sha, project, note: note.trim() }));
  };

  const candidateGo = (c: CandidateRow) => {
    const summary = [
      'DEPLOY TO PRODUCTION',
      '',
      `${c.project} · candidate ${c.name}`,
      `tip SHA ${c.tip}`,
      c.lanes.length ? `contains: ${c.lanes.map((l) => `${l.desk ? `Desk #${l.desk} ` : ''}${l.sha.slice(0, 8)}`).join(', ')}` : 'contains: no lanes WaveCode knows',
      `staging: ${cellLabel(c.staging).text}${c.verified ? `, verified by ${c.verified.by}` : ', NOT verified'}`,
      '',
      'This sends the production GO for the whole candidate to the deployer with your name on it. Continue?',
    ].join('\n');
    if (!window.confirm(summary)) return;
    return run(`go:${c.name}`, () => apiPost(`/releases/candidates/${encodeURIComponent(c.name)}/promote`, { project: c.project }));
  };

  const candidateStage = (c: CandidateRow) => run(`stage:${c.name}`, () => apiPost(`/releases/candidates/${encodeURIComponent(c.name)}/stage`, { project: c.project }));

  const laneStage = (l: LaneBoardRow) => {
    if (!l.run_id) return;
    const runId = l.run_id;
    return run(`stage:${l.sha}`, () => apiPost(`/reviews/${runId}/stage`));
  };

  const laneReject = (l: LaneBoardRow) => {
    if (!l.run_id) return;
    const runId = l.run_id;
    const reason = window.prompt('Reject this freeze — reason:');
    if (reason === null) return;
    return run(`reject:${l.sha}`, () => apiPost(`/reviews/${runId}/reject`, { reason: reason.trim() }));
  };

  const openFile = internalLinkClickHandler(navigate);
  const busy = (k: string) => acting === k;

  const lanes = board?.lanes ?? [];
  const active = lanes.filter((l) => l.status === 'open' && !l.candidate);
  const hidden = lanes.filter((l) => !(l.status === 'open' && !l.candidate));
  const inCandidate = hidden.filter((l) => l.candidate && l.status === 'open');
  const staleOrMerged = hidden.filter((l) => !(l.candidate && l.status === 'open'));

  const LaneRow = ({ l }: { l: LaneBoardRow }) => {
    const card = cards.get(l.sha)?.freeze ?? null;
    const st = cellLabel(l.staging);
    const openReq = !!l.staging && (l.staging.status === 'sent' || l.staging.status === 'requested');
    const verified = l.staging?.verified_by ?? null;
    return (
      <tr className={l.status !== 'open' ? 'opacity-60' : ''} data-testid={`lane-${l.sha.slice(0, 8)}`}>
        <td className="px-3 py-2 align-top">
          <div className="text-slate-200">{l.project ?? '—'}{l.desk ? <span className="text-slate-400"> · Desk #{l.desk}</span> : null}</div>
          <div className="font-mono text-[10px] text-slate-500">{l.lane ?? '—'}</div>
          <div className="text-[10px] text-slate-500">@{l.author ?? '?'} → reviewed by @{l.reviewer ?? '?'}</div>
        </td>
        <td className="px-3 py-2 align-top font-mono text-slate-300" title={l.sha}>
          {l.sha.slice(0, 10)}
          {l.status === 'stale' && <div className="text-[9px] text-slate-500">stale{l.superseded_by ? ` → ${l.superseded_by.slice(0, 8)}` : ''}</div>}
          {l.status === 'merged' && <div className="text-[9px] text-emerald-400/80">on main</div>}
          {l.candidate && <div className="text-[9px] text-violet-300">in {l.candidate}</div>}
        </td>
        <td className="px-3 py-2 align-top">
          <span className={`text-[9px] font-bold tracking-wider rounded px-1.5 py-0.5 border ${l.verdict === 'pass' ? 'text-emerald-300 border-emerald-500/40' : 'text-amber-300 border-amber-500/40'}`}>
            {(l.verdict ?? 'none').toUpperCase().replace('-', ' ')}
          </span>
          {l.gate && <span className={`ml-2 text-[9px] font-bold ${l.gate === 'GREEN' ? 'text-emerald-300' : 'text-red-300'}`}>{l.gate}</span>}
          <div className="mt-1 flex gap-2 text-[9px]">
            {card?.freeze_path && <a href={fileViewHref(card.freeze_path)} onClick={openFile} className="text-sky-300 underline underline-offset-2">freeze</a>}
            {card?.verdict_path && <a href={fileViewHref(card.verdict_path)} onClick={openFile} className="text-sky-300 underline underline-offset-2">verdict</a>}
          </div>
        </td>
        <td className={`px-3 py-2 align-top ${st.cls}`}>
          {st.text}
          {l.staging && <div className="text-[9px] text-slate-600">{when(l.staging.at)}{l.staging.by ? ` · ${l.staging.by}` : ''}</div>}
          {verified && <div className="text-[9px] text-violet-300">verified by {verified}</div>}
        </td>
        <td className="px-3 py-2 align-top text-[10px] text-slate-400">{l.next}</td>
        <td className="px-3 py-2 align-top text-right whitespace-nowrap space-x-1.5">
          {l.status === 'open' && !l.candidate && (
            <>
              <button
                onClick={() => laneStage(l)}
                disabled={acting !== null || openReq || !l.run_id}
                title="Automated staging of this lane alone, no GO"
                className="px-2 py-1 rounded border border-sky-500/30 text-[10px] font-semibold tracking-wider text-sky-300 hover:bg-sky-500/10 disabled:opacity-40"
              >
                {busy(`stage:${l.sha}`) ? '...' : 'STAGE'}
              </button>
              {l.staging?.status === 'deployed' && !verified && (
                <button onClick={() => verify(l.sha, l.project, `${l.desk ? `Desk #${l.desk} ` : ''}${l.sha.slice(0, 8)}`)} disabled={acting !== null} className="px-2 py-1 rounded border border-violet-500/40 text-[10px] font-semibold tracking-wider text-violet-200 hover:bg-violet-500/10 disabled:opacity-40">
                  {busy(`verify:${l.sha}`) ? '...' : 'VERIFIED ON STAGING'}
                </button>
              )}
            </>
          )}
          {l.run_id && l.status !== 'merged' && (
            <button onClick={() => laneReject(l)} disabled={acting !== null} className="px-2 py-1 rounded border border-red-500/30 text-[10px] font-semibold tracking-wider text-red-300 hover:bg-red-500/10 disabled:opacity-40">
              {busy(`reject:${l.sha}`) ? '...' : 'REJECT'}
            </button>
          )}
        </td>
      </tr>
    );
  };

  return (
    <div className="min-h-screen bg-slate-950">
      <header className="sticky top-0 z-40 border-b border-slate-800/60 bg-slate-950/90 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <button onClick={() => navigate('/')} className="text-slate-500 hover:text-slate-300 text-sm">&larr;</button>
          <div>
            <h1 className="text-sm font-bold tracking-[0.15em] text-slate-100 uppercase">Release</h1>
            <p className="text-[9px] text-slate-600 tracking-[0.3em] uppercase">candidates go to production &middot; lanes get staged and composed &middot; every click is in the audit trail</p>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {error && <p className="text-[11px] text-red-400 border border-red-500/30 rounded px-3 py-2">{error}</p>}

        {!loaded || !board ? (
          <p className="text-[10px] text-slate-600 tracking-[0.3em] uppercase animate-pulse py-16 text-center">Loading…</p>
        ) : (
          <>
            {/* 1. Candidates: the unit of production */}
            <section data-testid="candidates">
              <h2 className="text-[9px] uppercase tracking-[0.3em] text-slate-500 mb-2">Release candidates</h2>
              {board.candidates.length === 0 ? (
                <p className="text-[11px] text-slate-600">No unreleased candidate branch. The deployer composes one from reviewed lanes; it appears here with its lanes.</p>
              ) : (
                <ul className="space-y-3">
                  {board.candidates.map((c) => {
                    const st = cellLabel(c.staging);
                    const pr = cellLabel(c.production);
                    const goOpen = !!c.production && (c.production.status === 'sent' || c.production.status === 'requested');
                    const done = c.production?.status === 'deployed';
                    return (
                      <li key={`${c.project}:${c.name}`} className="rounded-lg border border-violet-500/30 bg-violet-950/10 p-3 space-y-2" data-testid={`candidate-${c.name}`}>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                          <span className="text-[10px] font-bold tracking-wider text-violet-300 uppercase">{c.project}</span>
                          <span className="font-mono text-slate-100">{c.name}</span>
                          <span className="font-mono text-[10px] text-slate-500" title={c.tip}>tip {c.tip.slice(0, 10)}</span>
                          {c.committed_at && <span className="text-[10px] text-slate-600">{when(c.committed_at)}</span>}
                          <span className="ml-auto text-[10px] text-slate-400">{c.next}</span>
                        </div>
                        <div className="flex flex-wrap gap-1.5 text-[10px]">
                          {c.lanes.length === 0 && <span className="text-slate-600">contains no lane WaveCode knows about</span>}
                          {c.lanes.map((l) => (
                            <span key={l.sha} className="rounded border border-slate-700/60 px-1.5 py-0.5 text-slate-300" title={l.sha}>
                              {l.desk ? `Desk #${l.desk} · ` : ''}{l.sha.slice(0, 8)}{l.author ? ` · @${l.author}` : ''}
                            </span>
                          ))}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
                          <span>staging: <span className={st.cls}>{st.text}</span>{c.verified ? <span className="text-violet-300"> · verified by {c.verified.by}{c.verified.note ? ` — ${c.verified.note}` : ''}</span> : <span className="text-amber-300"> · not verified</span>}</span>
                          <span>production: <span className={pr.cls}>{pr.text}</span>{c.production?.by ? <span className="text-slate-500"> · GO by {c.production.by}</span> : null}</span>
                          <span className="ml-auto flex items-center gap-1.5">
                            <button onClick={() => candidateStage(c)} disabled={acting !== null || (!!c.staging && (c.staging.status === 'sent' || c.staging.status === 'requested'))} title="Ask the deployer to put this candidate on staging" className="px-2 py-1 rounded border border-sky-500/30 text-[10px] font-semibold tracking-wider text-sky-300 hover:bg-sky-500/10 disabled:opacity-40">
                              {busy(`stage:${c.name}`) ? '...' : 'STAGE'}
                            </button>
                            {!c.verified && (
                              <button onClick={() => verify(c.tip, c.project, c.name)} disabled={acting !== null} className="px-2 py-1 rounded border border-violet-500/40 text-[10px] font-semibold tracking-wider text-violet-200 hover:bg-violet-500/10 disabled:opacity-40">
                                {busy(`verify:${c.tip}`) ? '...' : 'VERIFIED ON STAGING'}
                              </button>
                            )}
                            <button
                              onClick={() => candidateGo(c)}
                              disabled={acting !== null || goOpen || done}
                              title={c.verified ? 'Production GO for the whole candidate, with your name' : 'Not verified on staging yet — the confirmation says so'}
                              className={`px-2.5 py-1 rounded border text-[10px] font-bold tracking-wider disabled:opacity-40 ${c.verified ? 'border-emerald-400/60 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25' : 'border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10'}`}
                            >
                              {busy(`go:${c.name}`) ? '...' : 'DEPLOY TO PRODUCTION'}
                            </button>
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* 2. Reviewed lanes waiting to be composed */}
            <section>
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-[9px] uppercase tracking-[0.3em] text-slate-500">Reviewed lanes not yet in a candidate</h2>
                {hidden.length > 0 && (
                  <button onClick={() => setShowStale((v) => !v)} className="text-[10px] text-slate-500 underline underline-offset-2">
                    {showStale ? 'hide' : 'show'} {inCandidate.length} in candidates · {staleOrMerged.length} stale/merged
                  </button>
                )}
              </div>
              {active.length === 0 && !showStale ? (
                <p className="text-[11px] text-slate-600">Nothing waiting. Reviewed lanes appear here until the deployer composes them into a candidate.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-slate-800/60">
                  <table className="w-full text-[11px]" data-testid="lanes">
                    <thead className="bg-slate-900/60 text-[9px] uppercase tracking-wider text-slate-500">
                      <tr>
                        <th className="text-left px-3 py-2">Lane</th>
                        <th className="text-left px-3 py-2">SHA</th>
                        <th className="text-left px-3 py-2">Review · gate</th>
                        <th className="text-left px-3 py-2">Staging</th>
                        <th className="text-left px-3 py-2">Next</th>
                        <th className="text-right px-3 py-2">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/50">
                      {active.map((l) => <LaneRow key={l.sha} l={l} />)}
                      {showStale && [...inCandidate, ...staleOrMerged].map((l) => <LaneRow key={l.sha} l={l} />)}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {audit.length > 0 && (
              <section>
                <h2 className="text-[9px] uppercase tracking-[0.3em] text-slate-500 mb-2">Audit trail — who did what</h2>
                <div className="overflow-x-auto rounded-lg border border-slate-800/60">
                  <table className="w-full text-[10px]" data-testid="audit">
                    <thead className="bg-slate-900/60 text-[9px] uppercase tracking-wider text-slate-500">
                      <tr>
                        <th className="text-left px-3 py-1.5">When</th>
                        <th className="text-left px-3 py-1.5">Who</th>
                        <th className="text-left px-3 py-1.5">Action</th>
                        <th className="text-left px-3 py-1.5">Target</th>
                        <th className="text-left px-3 py-1.5">Lane</th>
                        <th className="text-left px-3 py-1.5">SHA</th>
                        <th className="text-left px-3 py-1.5">Detail</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/40">
                      {audit.map((e, i) => (
                        <tr key={i}>
                          <td className="px-3 py-1 text-slate-500 tabular-nums whitespace-nowrap">{when(e.at)}</td>
                          <td className="px-3 py-1 text-slate-200">{e.who}</td>
                          <td className={`px-3 py-1 font-semibold tracking-wider uppercase ${ACTION_CLS[e.action]}`}>{e.action}</td>
                          <td className="px-3 py-1 text-slate-400">{e.target ?? '—'}</td>
                          <td className="px-3 py-1 text-slate-300">{e.project ?? ''}{e.desk ? ` Desk #${e.desk}` : ''}</td>
                          <td className="px-3 py-1 font-mono text-slate-400" title={e.sha ?? ''}>{e.sha?.slice(0, 8) ?? '—'}</td>
                          <td className="px-3 py-1 text-slate-500 max-w-[24rem] truncate" title={e.detail ?? ''}>{e.detail ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
