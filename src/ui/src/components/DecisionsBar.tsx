import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost, apiDelete } from '../hooks/useApi';
import { useSSE, type SSEEvent } from '../hooks/useSSE';

interface Decision {
  id: string;
  workspace: string;
  summary: string;
  detail: string | null;
  source_agent_id: string | null;
  source_run_id: string | null;
  created_at: string;
}

interface Agent {
  id: string;
  workspace: string | null;
}

export default function DecisionsBar({ agentId }: { agentId: string }) {
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [adding, setAdding] = useState(false);
  const [newSummary, setNewSummary] = useState('');
  const [expanded, setExpanded] = useState(false);

  const loadDecisions = useCallback(async () => {
    try {
      const a = await apiGet<Agent>(`/agents/${agentId}`);
      setAgent(a);
      if (a.workspace) {
        const list = await apiGet<Decision[]>(`/decisions?workspace=${encodeURIComponent(a.workspace)}`);
        setDecisions(list);
      }
    } catch { /* ignore */ }
  }, [agentId]);

  useEffect(() => { void loadDecisions(); }, [loadDecisions]);

  // Live updates
  useSSE((event: SSEEvent) => {
    if (event.type === 'decision.created' || event.type === 'decision.deleted') {
      void loadDecisions();
    }
  });

  const handleAdd = async () => {
    if (!newSummary.trim() || !agent?.workspace) return;
    try {
      await apiPost('/decisions', {
        agent_id: agentId,
        summary: newSummary.trim(),
      });
      setNewSummary('');
      setAdding(false);
      void loadDecisions();
    } catch { /* ignore */ }
  };

  const handleDelete = async (id: string) => {
    try {
      await apiDelete(`/decisions/${id}`);
      void loadDecisions();
    } catch { /* ignore */ }
  };

  if (!agent?.workspace) return null;

  const visibleDecisions = expanded ? decisions : decisions.slice(0, 3);

  return (
    <div className="border-t border-amber-500/20 bg-amber-950/10">
      <div className="max-w-4xl mx-auto px-4 py-2">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[10px] font-bold tracking-[0.2em] text-amber-400/70 uppercase">
            Decisions ({decisions.length})
          </span>
          <button
            onClick={() => setAdding(!adding)}
            className="text-[10px] text-amber-400/50 hover:text-amber-300 transition-colors"
          >
            {adding ? '✕' : '+ ADD'}
          </button>
          {decisions.length > 3 && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="ml-auto text-[10px] text-amber-400/40 hover:text-amber-300 transition-colors"
            >
              {expanded ? 'Show less' : `Show all ${decisions.length}`}
            </button>
          )}
        </div>

        {adding && (
          <div className="flex gap-2 mb-2">
            <input
              type="text"
              value={newSummary}
              onChange={(e) => setNewSummary(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              placeholder="Use RS256 for JWT signing..."
              className="flex-1 px-2.5 py-1.5 rounded-lg border border-amber-500/30 bg-amber-950/30 text-xs text-amber-100 placeholder:text-amber-600/50 focus:outline-none focus:border-amber-400/60"
              autoFocus
            />
            <button
              onClick={handleAdd}
              disabled={!newSummary.trim()}
              className="px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-900/40 text-[10px] font-bold text-amber-300 hover:bg-amber-800/50 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            >
              SAVE
            </button>
          </div>
        )}

        {decisions.length === 0 && !adding && (
          <p className="text-[10px] text-amber-500/40 italic">
            No decisions yet. Decisions are auto-extracted from completed runs or added manually.
          </p>
        )}

        <div className="flex flex-wrap gap-1.5">
          {visibleDecisions.map((d) => (
            <div
              key={d.id}
              className="group flex items-center gap-1.5 px-2 py-1 rounded-md bg-amber-900/30 border border-amber-500/20 hover:border-amber-400/40 transition-colors"
              title={d.detail ?? d.summary}
            >
              <span className="text-[10px] text-amber-200/80">{d.summary}</span>
              <button
                onClick={() => handleDelete(d.id)}
                className="text-amber-500/30 hover:text-red-400 text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
