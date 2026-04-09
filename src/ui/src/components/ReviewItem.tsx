import { useState, useEffect } from 'react';
import { apiGet, apiPost } from '../hooks/useApi';
import type { ReviewItem as ReviewItemType, Agent, CodeReview } from '../types';

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
          <span className="flex-shrink-0 text-[9px] font-bold tracking-wider text-slate-600 border border-slate-800 rounded px-1.5 py-0.5">
            #{item.run.attempt}
          </span>
        </div>

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
          <button
            onClick={() => act('promote')}
            disabled={acting !== null}
            className="px-2.5 py-1 rounded border border-emerald-500/30 text-[10px] font-semibold tracking-wider text-emerald-400 hover:bg-emerald-500/10 hover:border-emerald-500/50 transition-all active:scale-95 disabled:opacity-40"
          >
            {acting === 'promote' ? '...' : 'PROMOTE'}
          </button>
          <button
            onClick={() => act('retry')}
            disabled={acting !== null}
            className="px-2.5 py-1 rounded border border-amber-500/30 text-[10px] font-semibold tracking-wider text-amber-400 hover:bg-amber-500/10 hover:border-amber-500/50 transition-all active:scale-95 disabled:opacity-40"
          >
            {acting === 'retry' ? '...' : 'RETRY'}
          </button>
          <button
            onClick={() => setShowHandoff(!showHandoff)}
            disabled={acting !== null}
            className="px-2.5 py-1 rounded border border-cyan-500/30 text-[10px] font-semibold tracking-wider text-cyan-400 hover:bg-cyan-500/10 hover:border-cyan-500/50 transition-all active:scale-95 disabled:opacity-40"
          >
            HAND OFF
          </button>
          <button
            onClick={() => act('reject')}
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
