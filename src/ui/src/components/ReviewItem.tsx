import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost } from '../hooks/useApi';
import type { ReviewItem as ReviewItemType, Agent, CodeReview } from '../types';
import { fileViewHref, internalLinkClickHandler } from '../utils/paths';

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '--:--';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export default function ReviewItem({
  item,
  agents,
  onAction,
  index,
}: {
  item: ReviewItemType;
  agents: Agent[];
  onAction: () => void;
  index: number;
}) {
  const navigate = useNavigate();
  const [acting, setActing] = useState<string | null>(null);
  const [showHandoff, setShowHandoff] = useState(false);
  const [handoffAgent, setHandoffAgent] = useState('');
  const [aiReviews, setAiReviews] = useState<CodeReview[]>([]);
  const [showAiReview, setShowAiReview] = useState(false);
  const [requesting, setRequesting] = useState(false);

  // Fetch AI reviews for this run
  useEffect(() => {
    apiGet<CodeReview[]>(`/reviews/${item.run.id}/ai-reviews`)
      .then(setAiReviews)
      .catch(() => {});
  }, [item.run.id]);

  const requestReview = async (type: 'self' | 'cross-model') => {
    setRequesting(true);
    try {
      await apiPost(`/reviews/${item.run.id}/ai-review`, { type });
      // Refresh reviews after a delay
      setTimeout(() => {
        apiGet<CodeReview[]>(`/reviews/${item.run.id}/ai-reviews`).then(setAiReviews).catch(() => {});
      }, 2000);
    } catch {} finally { setRequesting(false); }
  };

  const sendFixes = async (reviewId: string) => {
    try {
      await apiPost(`/ai-reviews/${reviewId}/send-fixes`);
    } catch {}
  };

  const act = async (action: string, body?: Record<string, unknown>) => {
    setActing(action);
    try {
      await apiPost(`/reviews/${item.run.id}/${action}`, body);
      onAction();
    } catch {
      // action failed
    } finally {
      setActing(null);
      setShowHandoff(false);
    }
  };

  // Promote is gated on a passing AI verdict; a blocked promote can be
  // pushed through with an explicit override reason, which the server stores.
  const promote = async () => {
    setActing('promote');
    try {
      await apiPost(`/reviews/${item.run.id}/promote`);
      onAction();
    } catch (e) {
      const msg = (e as Error).message ?? '';
      if (msg.includes('Promotion blocked')) {
        const reason = window.prompt(`${msg}\n\nOverride reason (leave empty to cancel):`);
        if (reason?.trim()) {
          try {
            await apiPost(`/reviews/${item.run.id}/promote`, { overrideReason: reason.trim() });
            onAction();
          } catch { /* second failure already surfaced via error banner */ }
        }
      }
    } finally {
      setActing(null);
    }
  };

  const verdict = item.latestReview?.verdict ?? aiReviews.find((r) => r.status === 'done')?.verdict ?? null;
  const freeze = item.freeze;
  const freezeStale = freeze?.status === 'stale';
  // A freeze card promotes only on an independent PASS on the exact SHA; a stale SHA never.
  const canPromote = !freeze || (freeze.verdict === 'pass' && !freezeStale);
  const openFile = internalLinkClickHandler(navigate);

  const reject = async () => {
    if (!freeze) return act('reject');
    const reason = window.prompt('Reject this freeze — reason (stored with the decision):');
    if (reason === null) return;
    await act('reject', { reason: reason.trim() });
  };

  return (
    <div
      className="rounded-lg border border-slate-800/50 bg-gradient-to-br from-slate-900/80 to-slate-950/90 overflow-hidden transition-all duration-200 hover:border-slate-700/50"
      style={{
        animationDelay: `${index * 80}ms`,
        animation: 'reviewIn 0.4s ease-out both',
      }}
    >
      <div className="p-4 space-y-3">
        {/* Header: task prompt + attempt badge */}
        <div className="flex items-start justify-between gap-3">
          <p className="text-[12px] text-slate-200 font-mono leading-relaxed line-clamp-2 flex-1">
            {item.task.prompt}
          </p>
          <div className="flex-shrink-0 flex items-center gap-1.5">
            {verdict && (
              <span className={`text-[9px] font-bold tracking-wider rounded px-1.5 py-0.5 border ${
                verdict === 'pass'
                  ? 'text-emerald-300 border-emerald-500/40 bg-emerald-950/50'
                  : verdict === 'reject'
                    ? 'text-red-300 border-red-500/40 bg-red-950/50'
                    : 'text-amber-300 border-amber-500/40 bg-amber-950/50'
              }`}>
                {verdict === 'pass' ? '✓ PASS' : verdict === 'reject' ? '✗ REJECT' : '⚠ NEEDS FIXES'}
              </span>
            )}
            <span className="text-[9px] font-bold tracking-wider text-slate-600 border border-slate-800 rounded px-1.5 py-0.5">
              #{item.run.attempt}
            </span>
          </div>
        </div>

        {/* Release freeze: what was frozen, who reviewed it, where the files are */}
        {freeze && (
          <div className="rounded border border-slate-800/60 bg-slate-950/60 px-3 py-2 space-y-1 text-[10px]" data-testid="freeze-card">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-bold tracking-wider text-violet-300">RELEASE FREEZE</span>
              {freeze.project && <span className="text-slate-300">{freeze.project}</span>}
              {freeze.desk && <span className="text-slate-300">Desk #{freeze.desk}</span>}
              {freeze.lane && <span className="font-mono text-slate-400">{freeze.lane}</span>}
              {freezeStale && (
                <span className="text-[9px] font-bold tracking-wider rounded px-1.5 py-0.5 border text-slate-400 border-slate-600 bg-slate-900" title={freeze.superseded_by ? `Lane moved on to ${freeze.superseded_by.slice(0, 8)}` : 'A newer commit landed on this lane'}>
                  STALE{freeze.superseded_by ? ` → ${freeze.superseded_by.slice(0, 8)}` : ''}
                </span>
              )}
              {freeze.gate && (
                <span className={`text-[9px] font-bold tracking-wider rounded px-1.5 py-0.5 border ${freeze.gate === 'GREEN' ? 'text-emerald-300 border-emerald-500/40' : 'text-red-300 border-red-500/40'}`}>
                  GATE {freeze.gate}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono text-slate-200 select-all" title={freeze.sha}>{freeze.sha.slice(0, 12)}</span>
              <span className="text-slate-400">author <span className="text-cyan-300">@{freeze.author_name ?? '?'}</span></span>
              <span className="text-slate-400">reviewer <span className="text-cyan-300">@{freeze.reviewer_name ?? '?'}</span></span>
              {freeze.freeze_path && (
                <a href={fileViewHref(freeze.freeze_path)} onClick={openFile} className="text-sky-300 hover:text-sky-200 underline underline-offset-2">freeze note</a>
              )}
              {freeze.verdict_path && (
                <a href={fileViewHref(freeze.verdict_path)} onClick={openFile} className="text-sky-300 hover:text-sky-200 underline underline-offset-2">verdict</a>
              )}
            </div>
          </div>
        )}

        {/* Meta row: agent, duration, artifacts */}
        <div className="flex items-center gap-3 text-[10px]">
          <span className="px-2 py-0.5 rounded border border-cyan-500/20 bg-cyan-500/5 text-cyan-400 font-semibold tracking-wider uppercase">
            {item.agentName}
          </span>
          <span className="text-slate-500 font-mono tracking-wider">
            {formatDuration(item.duration)}
          </span>
          {item.artifacts.length > 0 && (
            <span className="text-slate-600">
              {item.artifacts.length} artifact{item.artifacts.length > 1 ? 's' : ''}
            </span>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 pt-1">
          {canPromote && (
            <button
              onClick={promote}
              disabled={acting !== null}
              title={verdict !== 'pass' ? 'Requires a passing AI review (or an explicit override reason)' : freeze ? `Send the GO for ${freeze.sha.slice(0, 8)} to the deployer` : undefined}
              className="px-2.5 py-1 rounded border border-emerald-500/30 text-[10px] font-semibold tracking-wider text-emerald-400 hover:bg-emerald-500/10 hover:border-emerald-500/50 transition-all active:scale-95 disabled:opacity-40"
            >
              {acting === 'promote' ? '...' : 'PROMOTE'}
            </button>
          )}
          {freeze && !canPromote && (
            <span className="text-[10px] text-slate-500" title="Promote needs an independent PASS on the exact SHA; a stale SHA must be frozen and reviewed again">
              {freezeStale ? 'stale — not promotable' : 'no PASS — not promotable'}
            </span>
          )}
          {!freeze && (
            <button
              onClick={() => act('retry')}
              disabled={acting !== null}
              className="px-2.5 py-1 rounded border border-amber-500/30 text-[10px] font-semibold tracking-wider text-amber-400 hover:bg-amber-500/10 hover:border-amber-500/50 transition-all active:scale-95 disabled:opacity-40"
            >
              {acting === 'retry' ? '...' : 'RETRY'}
            </button>
          )}
          {!freeze && (
            <button
              onClick={() => setShowHandoff(!showHandoff)}
              disabled={acting !== null}
              className="px-2.5 py-1 rounded border border-cyan-500/30 text-[10px] font-semibold tracking-wider text-cyan-400 hover:bg-cyan-500/10 hover:border-cyan-500/50 transition-all active:scale-95 disabled:opacity-40"
            >
              HAND OFF
            </button>
          )}
          <button
            onClick={reject}
            disabled={acting !== null}
            className="px-2.5 py-1 rounded border border-red-500/30 text-[10px] font-semibold tracking-wider text-red-400 hover:bg-red-500/10 hover:border-red-500/50 transition-all active:scale-95 disabled:opacity-40 ml-auto"
          >
            {acting === 'reject' ? '...' : 'REJECT'}
          </button>
        </div>

        {/* Hand-off agent selector */}
        {showHandoff && (
          <div className="flex items-center gap-2 pt-1 border-t border-slate-800/30">
            <select
              value={handoffAgent}
              onChange={(e) => setHandoffAgent(e.target.value)}
              className="flex-1 px-2 py-1 rounded border border-slate-800/60 bg-slate-950/50 text-xs text-slate-300 font-mono focus:outline-none focus:border-cyan-500/40"
            >
              <option value="">Select agent...</option>
              {agents
                .filter((a) => a.id !== item.run.agent_id)
                .map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
            </select>
            <button
              onClick={() => handoffAgent && act('handoff', { targetAgentId: handoffAgent })}
              disabled={!handoffAgent || acting !== null}
              className="px-3 py-1 rounded border border-cyan-500/30 text-[10px] font-semibold text-cyan-400 hover:bg-cyan-500/10 transition-all disabled:opacity-40"
            >
              {acting === 'handoff' ? '...' : 'GO'}
            </button>
          </div>
        )}

        {/* AI Review section */}
        <div className="pt-2 border-t border-slate-800/30 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-slate-500 font-bold tracking-wider">AI REVIEW</span>
            {aiReviews.length === 0 ? (
              <div className="flex gap-1.5">
                <button
                  onClick={() => requestReview('self')}
                  disabled={requesting}
                  className="px-2 py-0.5 rounded bg-slate-800 border border-slate-600/50 text-[9px] font-bold text-slate-300 hover:bg-slate-700 transition-all active:scale-95 disabled:opacity-40"
                >
                  {requesting ? '...' : 'SELF REVIEW'}
                </button>
                <button
                  onClick={() => requestReview('cross-model')}
                  disabled={requesting}
                  className="px-2 py-0.5 rounded bg-violet-950 border border-violet-500/40 text-[9px] font-bold text-violet-300 hover:bg-violet-900 transition-all active:scale-95 disabled:opacity-40"
                >
                  {requesting ? '...' : '✦ CROSS-MODEL'}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowAiReview(!showAiReview)}
                className="text-[9px] text-emerald-400 font-bold tracking-wider"
              >
                {aiReviews[0].issues_found > 0
                  ? `⚠ ${aiReviews[0].issues_found} ISSUES`
                  : '✓ PASS'
                } {showAiReview ? '▼' : '▶'}
              </button>
            )}
          </div>

          {/* Review feedback display */}
          {showAiReview && aiReviews.map((review) => (
            <div key={review.id} className="rounded bg-black/30 border border-slate-800/50 p-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`px-1.5 py-0.5 rounded text-[8px] font-bold ${
                    review.reviewer_type === 'self'
                      ? 'bg-slate-800 text-slate-300'
                      : 'bg-violet-950 border border-violet-500/30 text-violet-300'
                  }`}>
                    {review.reviewer_type === 'self' ? 'SELF' : review.reviewer_runtime ?? 'LLM'}
                  </span>
                  <span className={`text-[9px] font-bold ${
                    review.status === 'done' ? 'text-emerald-400' :
                    review.status === 'reviewing' ? 'text-amber-400 animate-pulse' :
                    review.status === 'failed' ? 'text-red-400' : 'text-slate-500'
                  }`}>
                    {review.status === 'reviewing' ? 'REVIEWING...' : review.status.toUpperCase()}
                  </span>
                </div>
                {review.status === 'done' && review.issues_found > 0 && (
                  <button
                    onClick={() => sendFixes(review.id)}
                    className="px-2 py-0.5 rounded bg-amber-950 border border-amber-500/40 text-[9px] font-bold text-amber-300 hover:bg-amber-900 transition-all active:scale-95"
                  >
                    SEND FIXES TO AGENT
                  </button>
                )}
              </div>
              {review.feedback && (
                <pre className="text-[10px] text-slate-300 font-mono whitespace-pre-wrap leading-relaxed max-h-[300px] overflow-y-auto">
                  {review.feedback}
                </pre>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
