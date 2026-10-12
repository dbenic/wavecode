import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost } from '../hooks/useApi';
import { useSSE, type SSEEvent } from '../hooks/useSSE';
import type { Agent, DeployCardState, DevLane, ReleaseRequest, ReviewBoard, ReviewerLoadView, ReviewItem as ReviewItemType, User } from '../types';
import type { StageProgress } from '../components/StageChip';
import { isReviewEventType } from '../sse-events';
import ReviewItemCard from '../components/ReviewItem';
import RoomProposals from '../components/RoomProposals';

function LaneSection({ lanes, onSent }: { lanes: DevLane[]; onSent: () => void }) {
  const [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  if (lanes.length === 0) return null;
  return (
    <section id="lanes" className="space-y-2 pt-4" data-testid="lanes">
      <h2 className="text-[10px] font-bold tracking-[0.2em] text-slate-500 uppercase">Lanes</h2>
      {lanes.map((lane) => (
        <div key={`${lane.project}:${lane.lane}`} className="rounded-lg border border-slate-800/50 bg-slate-900/40 p-3 space-y-2" data-testid={`lane-${lane.lane}`}>
          <div className="flex flex-wrap items-center gap-2 text-[10px]">
            <span className="font-mono text-slate-300">{lane.lane}</span>
            <span className="font-mono text-slate-500">{lane.sha.slice(0, 8)}</span>
            {lane.author_name && <span className="text-cyan-300">@{lane.author_name}</span>}
          </div>
          <p className="text-[11px] text-slate-200" data-testid="lane-status">{lane.status_line}</p>
          {lane.full_fail_flag && <p className="text-[11px] font-semibold text-red-300" data-testid="full-fail-flag">{lane.full_fail_flag}</p>}
          {lane.before_freeze_tip && <p className="text-[10px] text-slate-500" data-testid="before-freeze-tip">{lane.before_freeze_tip}</p>}
          {lane.reviewers.length > 0 && lane.freeze_sha && (
            <div className="flex items-center gap-2">
              <select
                value={pick[lane.lane] ?? ''}
                onChange={(e) => setPick((p) => ({ ...p, [lane.lane]: e.target.value }))}
                className="flex-1 px-2 py-1 rounded border border-slate-800/60 bg-slate-950/50 text-xs text-slate-300 font-mono"
              >
                <option value="">Request review…</option>
                {lane.reviewers.map((r) => <option key={r.id} value={r.id}>@{r.alias ?? r.name}</option>)}
              </select>
              <button
                type="button"
                disabled={busy === lane.lane || !pick[lane.lane]}
                onClick={() => {
                  setBusy(lane.lane);
                  apiPost('/reviews/lanes/request-review', { project: lane.project, lane: lane.lane, reviewer: pick[lane.lane] })
                    .then(() => onSent())
                    .catch(() => {})
                    .finally(() => setBusy(null));
                }}
                className="px-2 py-1 rounded border border-cyan-500/30 text-[10px] font-semibold text-cyan-300 disabled:opacity-40"
              >
                Request review
              </button>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

function indexStaging(rows: ReleaseRequest[]): Map<string, StageProgress & { id?: string }> {
  const open = new Map<string, ReleaseRequest>();
  const newest = new Map<string, ReleaseRequest>();
  for (const row of rows) {
    if (row.target !== 'staging') continue;
    if (!newest.has(row.sha)) newest.set(row.sha, row);
    if ((row.status === 'sent' || row.status === 'requested') && !open.has(row.sha)) open.set(row.sha, row);
  }
  const out = new Map<string, StageProgress & { id?: string }>();
  for (const [sha, row] of newest) {
    const picked = open.get(sha) ?? row;
    out.set(sha, {
      id: picked.id,
      sha: picked.sha,
      status: picked.status,
      phase: picked.progress_phase ?? null,
      progress: picked.progress_status ?? null,
      version: picked.version,
      pinUntil: picked.pin_until ?? null,
      url: picked.staging_url ?? null,
      error: picked.error,
      rollbackStatus: picked.rollback_status ?? null,
    });
  }
  return out;
}

const ACTIONABLE: DeployCardState[] = [
  'needs_fixes', 'awaiting_review', 'awaiting_tests', 'ready_to_stage', 'on_staging', 'awaiting_prod_go', 'unknown',
];
const HISTORY: DeployCardState[] = ['live_on_prod', 'superseded', 'stale'];
const COLUMN_LABEL: Record<DeployCardState, string> = {
  needs_fixes: 'Needs fixes',
  awaiting_review: 'Awaiting review',
  awaiting_tests: 'Awaiting tests',
  ready_to_stage: 'Ready to stage',
  on_staging: 'On staging',
  awaiting_prod_go: 'Awaiting prod GO',
  live_on_prod: 'Live on prod',
  superseded: 'Superseded',
  stale: 'Stale',
  unknown: 'Unknown',
};

function columnOf(item: ReviewItemType): DeployCardState {
  if (item.deploy?.state) return item.deploy.state;
  const verdict = item.latestReview?.verdict ?? item.freeze?.verdict ?? null;
  if (verdict === 'needs-fixes' || verdict === 'reject') return 'needs_fixes';
  return 'awaiting_review';
}

function reconciledLabel(iso: string | null): string {
  if (!iso) return 'Not reconciled yet';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function ReviewQueue() {
  const navigate = useNavigate();
  const [reviews, setReviews] = useState<ReviewItemType[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [proposalsVersion, setProposalsVersion] = useState(0);
  const [stagingBySha, setStagingBySha] = useState<Map<string, StageProgress & { id?: string }>>(new Map());
  const [lanes, setLanes] = useState<DevLane[]>([]);
  const [reconciledAt, setReconciledAt] = useState<string | null>(null);
  const [reconcileStale, setReconcileStale] = useState(false);
  const [reviewerLoads, setReviewerLoads] = useState<ReviewerLoadView[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  const fetchData = useCallback(() => {
    Promise.all([
      apiGet<ReviewBoard>('/reviews/board'),
      apiGet<Agent[]>('/agents'),
      apiGet<User>('/me').catch(() => null),
      apiGet<ReleaseRequest[]>('/releases?target=staging&limit=200').catch(() => [] as ReleaseRequest[]),
      apiGet<DevLane[]>('/reviews/lanes').catch(() => [] as DevLane[]),
    ]).then(([board, a, me, releases, laneRows]) => {
      setReviews(Array.isArray(board?.items) ? board.items : []);
      setReconciledAt(board?.last_reconciled_at ?? null);
      setReconcileStale(board?.stale === true);
      setReviewerLoads(board?.reviewers ?? []);
      setAgents(a);
      setIsAdmin(me?.role === 'admin');
      setStagingBySha(indexStaging(releases));
      setLanes(Array.isArray(laneRows) ? laneRows : []);
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

  const grouped = new Map<DeployCardState, ReviewItemType[]>();
  for (const item of reviews) {
    const col = columnOf(item);
    const list = grouped.get(col) ?? [];
    list.push(item);
    grouped.set(col, list);
  }
  const visibleColumns = (showHistory ? [...ACTIONABLE, ...HISTORY] : ACTIONABLE).filter((col) => (grouped.get(col)?.length ?? 0) > 0);
  const historyCount = HISTORY.reduce((n, col) => n + (grouped.get(col)?.length ?? 0), 0);
  const actionableCount = reviews.length - historyCount;

  return (
    <div className="min-h-screen bg-slate-950 relative">
      {/* Scan-line */}
      <div
        className="pointer-events-none fixed inset-0 z-50 opacity-[0.015]"
        style={{
          backgroundImage:
            'repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(255,255,255,0.03) 3px, rgba(255,255,255,0.03) 6px)',
        }}
      />

      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-slate-800/60 bg-slate-950/90 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button onClick={() => navigate('/')} className="text-slate-500 hover:text-slate-300 transition-colors text-sm">
              &larr;
            </button>
            <div className="min-w-0">
              <h1 className="text-sm font-bold tracking-[0.15em] text-slate-100 uppercase">
                Reviews
              </h1>
              <p className="text-[9px] text-slate-600 tracking-[0.3em] uppercase truncate">
                {actionableCount} to act on
                {lanes.length > 0 && <> &middot; <a href="#lanes" className="text-sky-400/80 hover:text-sky-300">Lanes</a></>}
              </p>
              <p className={`text-[10px] mt-0.5 ${reconcileStale ? 'text-amber-300' : 'text-slate-500'}`} data-testid="last-reconciled">
                Last reconciled {reconciledLabel(reconciledAt)}
                {reconcileStale && <span data-testid="reconcile-stale"> · stale — more than 5 minutes</span>}
              </p>
            </div>
          </div>
          <button
            type="button"
            data-testid="history-toggle"
            onClick={() => setShowHistory((v) => !v)}
            className="shrink-0 px-2 py-1 rounded border border-slate-700 text-[10px] font-semibold tracking-wider text-slate-300 hover:border-slate-500"
          >
            {showHistory ? 'Hide history' : `History${historyCount ? ` (${historyCount})` : ''}`}
          </button>
        </div>
        {reviewerLoads.length > 0 && (
          <div className="max-w-6xl mx-auto px-4 pb-2 flex flex-wrap gap-x-3 gap-y-1" data-testid="reviewer-load">
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

      <main className="max-w-6xl mx-auto px-4 py-6">
        <RoomProposals version={proposalsVersion} />
        {!loaded ? (
          <div className="flex items-center justify-center py-20">
            <div className="text-[10px] text-slate-600 tracking-[0.3em] uppercase animate-pulse">
              Loading reviews...
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {actionableCount === 0 && !showHistory && lanes.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20 gap-4">
                <div className="w-16 h-16 rounded-lg border border-dashed border-slate-800 flex items-center justify-center">
                  <span className="text-2xl text-slate-700">&#10003;</span>
                </div>
                <div className="text-center">
                  <p className="text-sm text-slate-500">Queue clear</p>
                  <p className="text-[11px] text-slate-600 mt-1">
                    Nothing to act on. History holds live, superseded and stale cards.
                  </p>
                </div>
              </div>
            )}
            <div className="flex gap-3 overflow-x-auto pb-2" data-testid="review-columns">
              {visibleColumns.map((col) => (
                <section key={col} className="w-72 shrink-0 space-y-2" data-testid={`column-${col}`}>
                  <h2 className="text-[10px] font-bold tracking-[0.18em] text-slate-500 uppercase">
                    {COLUMN_LABEL[col]} · {grouped.get(col)?.length ?? 0}
                  </h2>
                  {(grouped.get(col) ?? []).map((item, i) => (
                    <ReviewItemCard
                      key={item.run.id}
                      item={item}
                      agents={agents}
                      onAction={fetchData}
                      index={i}
                      isAdmin={isAdmin}
                      staging={item.freeze ? stagingBySha.get(item.freeze.sha) ?? null : null}
                    />
                  ))}
                </section>
              ))}
            </div>
            <LaneSection lanes={lanes.filter((l) => !reviews.some((r) => r.run.id === l.run_id || (l.freeze_sha && r.freeze?.sha === l.freeze_sha)))} onSent={fetchData} />
          </div>
        )}
      </main>

      <style>{`
        @keyframes reviewIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
