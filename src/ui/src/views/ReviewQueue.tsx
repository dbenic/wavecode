import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost } from '../hooks/useApi';
import { useSSE, type SSEEvent } from '../hooks/useSSE';
import type { LaneCard, ReleaseView, ReviewBoard, ReviewerLoadView } from '../types';
import { isReviewEventType } from '../sse-events';
import { fileViewHref, internalLinkClickHandler } from '../utils/paths';
import RoomProposals from '../components/RoomProposals';

const HOW_IT_WORKS = [
  'Freeze the lane when the work is ready.',
  'The quick check runs, then a reviewer reads that exact SHA.',
  'You press Stage, or it stages itself. Then check it on staging.',
  'Press Ready for prod. Denis ships that release.',
  'Behind main, merge main and freeze again. Your agent is told.',
];

function reconciledLabel(iso: string | null): string {
  if (!iso) return 'not yet';
  const match = iso.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!match) return iso;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[Number(match[2]) - 1] ?? match[2];
  return `${Number(match[3])} ${month} ${match[4]}:${match[5]} UTC`;
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 8) : '';
}

function Pipeline({ card }: { card: LaneCard }) {
  const blocked = card.pipeline.find((step) => step.mark === 'blocked');
  return (
    <div data-testid="pipeline">
      <ol className="flex flex-wrap items-center gap-1">
        {card.pipeline.map((step, index) => (
          <li key={step.id} className="flex items-center gap-1">
            {index > 0 && <span className="text-[10px] text-slate-600" aria-hidden="true">&gt;</span>}
            <span
              data-testid={`step-${step.id}`}
              data-mark={step.mark}
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${
                step.mark === 'blocked'
                  ? 'bg-red-950 text-red-200 ring-1 ring-red-500/50'
                  : step.mark === 'current'
                    ? 'bg-sky-950 text-sky-100 ring-1 ring-sky-400/60'
                    : step.mark === 'done'
                      ? 'text-emerald-400'
                      : 'text-slate-600'
              }`}
            >
              {step.label}
            </span>
          </li>
        ))}
      </ol>
      {blocked?.reason && blocked.reason !== card.action && (
        <p className="mt-1 text-[11px] text-red-300" data-testid="blocked-reason">{blocked.reason}</p>
      )}
    </div>
  );
}

function LaneCardView({ card, onDone }: { card: LaneCard; onDone: () => void }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [openOlder, setOpenOlder] = useState(false);
  const openFile = internalLinkClickHandler(navigate);
  const press = async () => {
    const button = card.button;
    if (!button || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (button.kind === 'stage' && button.run_id) {
        await apiPost(`/reviews/${button.run_id}/stage`);
      } else if (button.kind === 'ready') {
        await apiPost('/releases/verify', { sha: button.sha, project: button.project, note: 'Checked on staging' });
      } else if (button.kind === 'promote' && button.run_id) {
        await apiPost(`/reviews/${button.run_id}/promote`);
      } else if (button.kind === 'clear' && button.release_id) {
        const why = reason.trim();
        if (!why) {
          setError('A reason is required');
          setBusy(false);
          return;
        }
        await apiPost(`/releases/${button.release_id}/clear`, { reason: why });
      }
      onDone();
    } catch (e) {
      setError((e as Error).message || 'That did not go through');
    } finally {
      setBusy(false);
    }
  };
  return (
    <article
      data-testid={`lane-card-${card.lane ?? card.key}`}
      className={`rounded-xl border bg-slate-900/70 p-4 space-y-2 ${card.needs_you ? 'border-sky-500/40' : 'border-slate-800'}`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-100" data-testid="lane-title">{card.title}</h2>
        {card.sha && <span className="font-mono text-[10px] text-slate-500">{shortSha(card.sha)}</span>}
      </div>
      {card.lane && <p className="text-[10px] font-mono text-slate-600">{card.lane}</p>}
      <p className="text-lg font-semibold text-slate-50" data-testid="lane-status">{card.status}</p>
      <p className="text-sm text-slate-200" data-testid="lane-action">{card.action}</p>
      {card.link && (
        <a
          href={fileViewHref(card.link.path)}
          onClick={openFile}
          className="inline-block text-sm text-sky-300 underline underline-offset-2"
          data-testid="verdict-link"
        >
          {card.link.label}
        </a>
      )}
      <p className="text-[11px] text-slate-400" data-testid="lane-owner">Owner · {card.owner_label}</p>
      <Pipeline card={card} />
      {card.button?.kind === 'clear' && (
        <input
          data-testid="clear-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why this request is stuck"
          className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
        />
      )}
      {card.button && (
        <button
          type="button"
          data-testid={`action-${card.button.kind}`}
          disabled={busy}
          onClick={press}
          className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-50 ${card.button.kind === 'clear' ? 'border-amber-500/50 bg-amber-950 text-amber-100 hover:bg-amber-900' : 'border-emerald-500/50 bg-emerald-950 text-emerald-100 hover:bg-emerald-900'}`}
        >
          {busy ? 'Sending…' : card.button.label}
        </button>
      )}
      {card.ops_push && card.sha && (
        <>
          <button
            type="button"
            data-testid="push-staging"
            disabled={busy || !card.ops_push.enabled}
            title={card.ops_push.reason ?? 'Record a stager job. A bot pulls it. WaveCode does not run the scripts.'}
            onClick={() => {
              if (!card.ops_push?.enabled || busy) return;
              setBusy(true);
              setError(null);
              apiPost('/ops/stage', { sha: card.sha })
                .then(() => onDone())
                .catch((e: Error) => setError(e.message || 'That did not go through'))
                .finally(() => setBusy(false));
            }}
            className="mt-1 w-full rounded-lg border border-sky-500/40 px-3 py-2 text-sm font-semibold text-sky-100 disabled:opacity-40"
          >
            Push to staging
          </button>
          {!card.ops_push.enabled && card.ops_push.reason && (
            <p className="text-[11px] text-amber-200/90" data-testid="push-staging-reason">{card.ops_push.reason}</p>
          )}
        </>
      )}
      {error && <p className="text-[11px] text-red-300">{error}</p>}
      {card.older.length > 0 && (
        <div>
          <button
            type="button"
            data-testid="older-freezes"
            onClick={() => setOpenOlder((open) => !open)}
            className="text-[11px] text-slate-400 underline underline-offset-2"
          >
            {card.older.length} older freeze{card.older.length === 1 ? '' : 's'}
          </button>
          {openOlder && (
            <ul className="mt-1 space-y-1" data-testid="older-list">
              {card.older.map((row) => (
                <li key={row.sha} className="text-[11px] text-slate-500">
                  {row.title} · {row.when} · {shortSha(row.sha)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}

function ReleasePanel({ release }: { release: ReleaseView }) {
  const tip = (label: string, row: { version: string | null; sha: string | null }) => (
    <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-4" data-testid={`release-${label.toLowerCase()}`}>
      <h2 className="text-[10px] font-bold tracking-[0.18em] text-slate-500 uppercase">{label}</h2>
      <p className="mt-1 text-lg font-semibold text-slate-50">{row.version ? row.version : 'Version unknown'}</p>
      <p className="font-mono text-xs text-slate-400">{row.sha ? shortSha(row.sha) : 'SHA unknown'}</p>
    </section>
  );
  return (
    <div className="space-y-3" data-testid="release-view">
      <div className="grid gap-3 sm:grid-cols-2">
        {tip('Production', release.prod)}
        {tip('Staging', release.staging)}
      </div>
      <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-4" data-testid="release-queue">
        <h2 className="text-[10px] font-bold tracking-[0.18em] text-slate-500 uppercase">
          Next release{release.next_version ? ` ${release.next_version}` : ''}
        </h2>
        {release.queued.length === 0 ? (
          <p className="mt-2 text-sm text-slate-400">Nothing queued for the next release.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {release.queued.map((row) => (
              <li key={row.sha} data-testid={`queued-${row.lane ?? row.sha}`} className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-slate-100">{row.title}</span>
                <span className="font-mono text-[10px] text-slate-500">{shortSha(row.sha)}{row.lane ? ` · ${row.lane}` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default function ReviewQueue() {
  const navigate = useNavigate();
  const [cards, setCards] = useState<LaneCard[]>([]);
  const [release, setRelease] = useState<ReleaseView>({ prod: { version: null, sha: null }, staging: { version: null, sha: null }, next_version: null, queued: [] });
  const [viewer, setViewer] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [proposalsVersion, setProposalsVersion] = useState(0);
  const [reconciledAt, setReconciledAt] = useState<string | null>(null);
  const [reconcileStale, setReconcileStale] = useState(false);
  const [reviewerLoads, setReviewerLoads] = useState<ReviewerLoadView[]>([]);
  const [view, setView] = useState<'lanes' | 'release' | 'history'>('lanes');
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const scopeInit = useRef(false);

  const fetchData = useCallback(() => {
    apiGet<ReviewBoard>('/reviews/board').then((board) => {
      const nextCards = Array.isArray(board?.cards) ? board.cards : [];
      const name = board?.viewer?.name ?? null;
      setCards(nextCards);
      setRelease(board?.release ?? { prod: { version: null, sha: null }, staging: { version: null, sha: null }, next_version: null, queued: [] });
      setViewer(name);
      if (!scopeInit.current) {
        scopeInit.current = true;
        setScope(name ? 'mine' : 'all');
      } else if (!name) {
        setScope('all');
      }
      setReconciledAt(board?.last_reconciled_at ?? null);
      setReconcileStale(board?.stale === true);
      setReviewerLoads(board?.reviewers ?? []);
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSSE = useCallback((event: SSEEvent) => {
    if (isReviewEventType(event.type) || event.type === 'deploy.reconciled' || event.type === 'run.finished' || event.type.startsWith('release.') || event.type.startsWith('lane.') || event.type.startsWith('tests.') || event.type.startsWith('pipeline.')) {
      fetchData();
    }
    if (event.type.startsWith('room.proposal_')) setProposalsVersion((v) => v + 1);
  }, [fetchData]);

  useSSE(handleSSE);

  const mineKnown = !!viewer;
  const scoped = cards.filter((card) => (scope === 'all' || !mineKnown ? true : card.mine));
  const visible = view === 'history'
    ? scoped.filter((card) => card.history)
    : scoped.filter((card) => !card.history);
  const todo = cards.filter((card) => card.mine && card.needs_you && !card.history).length;
  const historyCount = cards.filter((card) => card.history && (scope === 'all' || !mineKnown || card.mine)).length;

  const tab = (id: 'lanes' | 'release' | 'history', label: string) => (
    <button
      type="button"
      data-testid={`view-${id === 'lanes' ? scope : id}`}
      onClick={() => setView(id)}
      className={`rounded-full px-3 py-1 text-[11px] font-semibold ${view === id ? 'bg-slate-100 text-slate-950' : 'border border-slate-700 text-slate-300'}`}
    >
      {label}
    </button>
  );

  return (
    <div className="min-h-screen bg-slate-950">
      <header className="sticky top-0 z-40 border-b border-slate-800/60 bg-slate-950/90 backdrop-blur-xl">
        <div className="max-w-3xl mx-auto px-4 py-3 space-y-2">
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => navigate('/')} className="text-slate-500 hover:text-slate-300 text-sm">&larr;</button>
            <div>
              <h1 className="text-sm font-bold tracking-[0.15em] text-slate-100 uppercase">Reviews</h1>
              {mineKnown && (
                <p className="text-sm text-slate-200" data-testid="things-to-do">
                  You have {todo} {todo === 1 ? 'thing' : 'things'} to do
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {tab('lanes', mineKnown && scope === 'mine' ? 'My lanes' : 'All lanes')}
            {mineKnown && (
              <button
                type="button"
                data-testid="scope-toggle"
                onClick={() => { setScope((s) => (s === 'mine' ? 'all' : 'mine')); setView('lanes'); }}
                className="rounded-full border border-slate-700 px-3 py-1 text-[11px] font-semibold text-slate-300"
              >
                {scope === 'mine' ? 'All lanes' : 'My lanes'}
              </button>
            )}
            {tab('release', 'Release')}
            {tab('history', historyCount ? `History (${historyCount})` : 'History')}
          </div>
          <p className={`text-[10px] ${reconcileStale ? 'text-amber-300' : 'text-slate-500'}`} data-testid="last-reconciled">
            Last reconciled {reconciledLabel(reconciledAt)}
            {reconcileStale && <span data-testid="reconcile-stale"> · stale — more than 5 minutes</span>}
          </p>
        </div>
        {reviewerLoads.length > 0 && (
          <div className="max-w-3xl mx-auto px-4 pb-2 flex flex-wrap gap-x-3 gap-y-1" data-testid="reviewer-load">
            {reviewerLoads.map((seat) => (
              <span
                key={seat.id}
                data-testid={`reviewer-load-${seat.name}`}
                className={`text-[10px] font-mono ${seat.busy ? 'text-amber-300' : 'text-slate-400'}`}
              >
                @{seat.alias ?? seat.name} {seat.busy ? 'busy' : 'idle'} · queue {seat.queue}
              </span>
            ))}
          </div>
        )}
      </header>

      <main className="max-w-3xl mx-auto px-4 py-4 space-y-4">
        <RoomProposals version={proposalsVersion} />
        {view === 'lanes' && (
          <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-3" data-testid="how-it-works">
            <h2 className="text-[10px] font-bold tracking-[0.18em] text-slate-500 uppercase">How it works</h2>
            <ol className="mt-1 list-decimal pl-4 text-[12px] text-slate-300 space-y-0.5">
              {HOW_IT_WORKS.map((line) => <li key={line}>{line}</li>)}
            </ol>
          </section>
        )}
        {!loaded ? (
          <p className="py-16 text-center text-[10px] tracking-[0.3em] text-slate-600 uppercase">Loading reviews...</p>
        ) : view === 'release' ? (
          <ReleasePanel release={release} />
        ) : visible.length === 0 ? (
          <p className="py-16 text-center text-sm text-slate-300" data-testid="empty-state">Nothing for you, everything is moving.</p>
        ) : (
          <div className="space-y-3" data-testid="lane-list">
            {visible.map((card) => <LaneCardView key={card.key} card={card} onDone={fetchData} />)}
          </div>
        )}
      </main>
    </div>
  );
}
