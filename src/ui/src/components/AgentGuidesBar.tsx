import { useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost, apiDelete } from '../hooks/useApi';

interface Guide {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  size_bytes: number;
}

interface Props {
  agentId: string;
  onAttachmentsChanged?: () => void;
}

function GuidePickerModal({
  agentId,
  attachedIds,
  onClose,
  onAttached,
}: {
  agentId: string;
  attachedIds: Set<string>;
  onClose: () => void;
  onAttached: () => void;
}) {
  const [guides, setGuides] = useState<Guide[]>([]);
  const [search, setSearch] = useState('');
  const [submitting, setSubmitting] = useState<string | null>(null);

  useEffect(() => {
    const params = search ? `?search=${encodeURIComponent(search)}` : '';
    apiGet<Guide[]>(`/guides${params}`).then(setGuides).catch(() => setGuides([]));
  }, [search]);

  const attach = async (guideId: string) => {
    setSubmitting(guideId);
    try {
      await apiPost(`/agents/${agentId}/guides`, { guide_ids: [guideId] });
      onAttached();
    } catch (e) {
      alert('Attach failed: ' + (e as Error).message);
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-lg p-4 max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-slate-100">Attach Guide</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 text-lg leading-none">×</button>
        </div>
        <input
          type="text"
          placeholder="Search guides..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full px-3 py-2 mb-3 bg-slate-950 border border-slate-700 rounded text-xs text-slate-200 focus:border-emerald-500 focus:outline-none"
          autoFocus
        />
        <div className="flex-1 overflow-y-auto space-y-1">
          {guides.length === 0 ? (
            <div className="text-[11px] text-slate-600 text-center py-6">
              No guides. Add a source from Library → Guides first.
            </div>
          ) : (
            guides.map((g) => {
              const already = attachedIds.has(g.id);
              return (
                <button
                  key={g.id}
                  disabled={already || submitting === g.id}
                  onClick={() => attach(g.id)}
                  className={`w-full text-left px-3 py-2 rounded border text-[11px] transition-colors ${
                    already
                      ? 'bg-emerald-950/30 border-emerald-500/20 text-emerald-400/60 cursor-default'
                      : 'bg-slate-800/40 border-slate-700/40 text-slate-300 hover:border-emerald-500/40 hover:bg-slate-800/80'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium truncate">{g.title}</span>
                    {already && <span className="text-[9px] shrink-0">✓ attached</span>}
                  </div>
                  <div className="text-[9px] text-slate-600 font-mono mt-0.5 truncate">{g.slug}</div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

export default function AgentGuidesBar({ agentId, onAttachmentsChanged }: Props) {
  const [attached, setAttached] = useState<Guide[]>([]);
  const [showPicker, setShowPicker] = useState(false);

  const load = useCallback(() => {
    apiGet<Guide[]>(`/agents/${agentId}/guides`).then(setAttached).catch(() => setAttached([]));
  }, [agentId]);

  useEffect(() => { load(); }, [load]);

  const detach = async (guideId: string) => {
    try {
      await apiDelete(`/agents/${agentId}/guides/${guideId}`);
      load();
      onAttachmentsChanged?.();
    } catch (e) {
      alert('Detach failed: ' + (e as Error).message);
    }
  };

  const attachedIds = new Set(attached.map((g) => g.id));

  return (
    <>
      <div className="border-t border-violet-500/20 bg-violet-950/20">
        <div className="max-w-3xl mx-auto px-4 py-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[9px] text-violet-400/70 font-bold tracking-wider">GUIDES</span>
            {attached.map((g) => (
              <span
                key={g.id}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-violet-950/50 border border-violet-500/30 text-[9px] text-violet-200 font-mono"
                title={g.slug}
              >
                📎 {g.title.length > 22 ? g.title.slice(0, 22) + '...' : g.title}
                <button
                  onClick={() => detach(g.id)}
                  className="text-violet-400/60 hover:text-violet-300 px-0.5"
                  title="Detach"
                >
                  ×
                </button>
              </span>
            ))}
            <button
              onClick={() => setShowPicker(true)}
              className="px-2 py-0.5 rounded bg-violet-950/30 border border-violet-500/20 text-[9px] text-violet-300 hover:border-violet-500/50 hover:bg-violet-950/50"
            >
              + Add
            </button>
          </div>
        </div>
      </div>
      {showPicker && (
        <GuidePickerModal
          agentId={agentId}
          attachedIds={attachedIds}
          onClose={() => setShowPicker(false)}
          onAttached={() => { load(); onAttachmentsChanged?.(); }}
        />
      )}
    </>
  );
}
