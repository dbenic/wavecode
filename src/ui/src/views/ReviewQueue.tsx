import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet } from '../hooks/useApi';
import { useSSE, type SSEEvent } from '../hooks/useSSE';
import type { Agent, ReviewItem as ReviewItemType } from '../types';
import { isReviewEventType } from '../sse-events';
import ReviewItemCard from '../components/ReviewItem';

export default function ReviewQueue() {
  const navigate = useNavigate();
  const [reviews, setReviews] = useState<ReviewItemType[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loaded, setLoaded] = useState(false);

  const fetchData = useCallback(() => {
    Promise.all([
      apiGet<ReviewItemType[]>('/reviews'),
      apiGet<Agent[]>('/agents'),
    ]).then(([r, a]) => {
      setReviews(r);
      setAgents(a);
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSSE = useCallback((event: SSEEvent) => {
    if (isReviewEventType(event.type) || event.type === 'run.finished') {
      fetchData();
    }
  }, [fetchData]);

  useSSE(handleSSE);

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
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/')} className="text-slate-500 hover:text-slate-300 transition-colors text-sm">
              &larr;
            </button>
            <div>
              <h1 className="text-sm font-bold tracking-[0.15em] text-slate-100 uppercase">
                Review Queue
              </h1>
              <p className="text-[9px] text-slate-600 tracking-[0.3em] uppercase">
                {reviews.length} pending &middot; Quality Gate
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6">
        {!loaded ? (
          <div className="flex items-center justify-center py-20">
            <div className="text-[10px] text-slate-600 tracking-[0.3em] uppercase animate-pulse">
              Loading reviews...
            </div>
          </div>
        ) : reviews.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <div className="w-16 h-16 rounded-lg border border-dashed border-slate-800 flex items-center justify-center">
              <span className="text-2xl text-slate-700">&#10003;</span>
            </div>
            <div className="text-center">
              <p className="text-sm text-slate-500">Queue clear</p>
              <p className="text-[11px] text-slate-600 mt-1">
                All runs reviewed. Check back when agents complete tasks.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {reviews.map((item, i) => (
              <ReviewItemCard
                key={item.run.id}
                item={item}
                agents={agents}
                onAction={fetchData}
                index={i}
              />
            ))}
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
