import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost, apiDelete } from '../hooks/useApi';
import { useSSE } from '../hooks/useSSE';
import type { Agent } from '../types';
import { renderMarkdown } from '../utils/markdown';

interface ProviderStatus {
  anthropic: boolean;
  openai: boolean;
  gemini: boolean;
  perplexity: boolean;
  xai: boolean;
}

interface ModelOption {
  value: string;
  label: string;
  provider: string;
  pricing: string;
}

const ALL_MODELS: ModelOption[] = [
  // Anthropic
  { value: 'claude-opus-4-5', label: 'Claude Opus 4.5', provider: 'anthropic', pricing: '$15/$75' },
  { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', provider: 'anthropic', pricing: '$3/$15' },
  { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'anthropic', pricing: '$1/$5' },
  // OpenAI
  { value: 'gpt-5.4-pro', label: 'GPT-5.4 Pro', provider: 'openai', pricing: '$15/$60' },
  { value: 'gpt-5.4', label: 'GPT-5.4', provider: 'openai', pricing: '$5/$20' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', provider: 'openai', pricing: '$1/$4' },
  { value: 'o3-pro', label: 'o3 Pro (reasoning)', provider: 'openai', pricing: '$20/$80' },
  { value: 'o3', label: 'o3 (reasoning)', provider: 'openai', pricing: '$2/$8' },
  { value: 'o4-mini', label: 'o4 Mini (reasoning)', provider: 'openai', pricing: '$1.1/$4.4' },
  { value: 'gpt-4.1', label: 'GPT-4.1', provider: 'openai', pricing: '$2/$8' },
  { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini', provider: 'openai', pricing: '$0.4/$1.6' },
  // Gemini
  { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'gemini', pricing: '$2.5/$15' },
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'gemini', pricing: '$0.15/$0.6' },
  // Perplexity
  { value: 'sonar-deep-research', label: 'Sonar Deep Research', provider: 'perplexity', pricing: '$2/$8' },
  { value: 'sonar-pro', label: 'Sonar Pro', provider: 'perplexity', pricing: '$3/$15' },
  { value: 'sonar', label: 'Sonar', provider: 'perplexity', pricing: '$1/$1' },
  // xAI
  { value: 'grok-3', label: 'Grok 3', provider: 'xai', pricing: '$3/$15' },
  { value: 'grok-3-mini', label: 'Grok 3 Mini', provider: 'xai', pricing: '$0.3/$0.5' },
];

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  perplexity: 'Perplexity',
  xai: 'xAI',
};

interface ResearchRun {
  id: string;
  title: string;
  prompt: string;
  provider: string;
  model: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  output_md: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  error: string | null;
  target_agent_id: string | null;
  artifact_id: string | null;
  parent_run_id: string | null;
  created_at: string;
  finished_at: string | null;
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = (now.getTime() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function NewSpecModal({ agents, onClose, onCreated }: {
  agents: Agent[];
  onClose: () => void;
  onCreated: (run: ResearchRun) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('claude-sonnet-4-5');
  const [targetAgentId, setTargetAgentId] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderStatus | null>(null);

  useEffect(() => {
    apiGet<ProviderStatus>('/providers').then(setProviders).catch(() => {});
  }, []);

  const availableModels = useMemo(() => {
    if (!providers) return ALL_MODELS.filter((m) => m.provider === 'anthropic');
    return ALL_MODELS.filter((m) => providers[m.provider as keyof ProviderStatus]);
  }, [providers]);

  // Reset model if current selection becomes unavailable
  useEffect(() => {
    if (availableModels.length > 0 && !availableModels.find((m) => m.value === model)) {
      setModel(availableModels[0].value);
    }
  }, [availableModels, model]);

  const selectedModel = availableModels.find((m) => m.value === model);

  const submit = async () => {
    if (prompt.trim().length < 3) return;
    setSubmitting(true);
    setError(null);
    try {
      const run = await apiPost<ResearchRun>('/specs', {
        prompt: prompt.trim(),
        model,
        provider: selectedModel?.provider ?? 'anthropic',
        target_agent_id: targetAgentId || null,
      });
      onCreated(run);
      onClose();
    } catch (e) {
      setError((e as Error).message || 'Failed to start research');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-lg p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-bold text-slate-100 mb-4 tracking-wide">New Research Spec</h3>

        <label className="block mb-3">
          <span className="text-[10px] text-slate-500 uppercase tracking-wider">What do you need researched?</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. Research rate-limiting strategies for a Node.js API serving 10k RPS. Compare token bucket, leaky bucket, sliding window."
            rows={4}
            className="w-full mt-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded text-xs text-slate-200 focus:border-emerald-500 focus:outline-none resize-none"
            autoFocus
          />
        </label>

        <div className="grid grid-cols-2 gap-3 mb-3">
          <label className="block">
            <span className="text-[10px] text-slate-500 uppercase tracking-wider">Model</span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full mt-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded text-xs text-slate-200 focus:border-emerald-500 focus:outline-none"
            >
              {Object.entries(
                availableModels.reduce<Record<string, ModelOption[]>>((acc, m) => {
                  (acc[m.provider] ??= []).push(m);
                  return acc;
                }, {})
              ).map(([prov, models]) => (
                <optgroup key={prov} label={PROVIDER_LABELS[prov] ?? prov}>
                  {models.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label} ({m.pricing}/M)
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[10px] text-slate-500 uppercase tracking-wider">Attach to agent</span>
            <select
              value={targetAgentId}
              onChange={(e) => setTargetAgentId(e.target.value)}
              className="w-full mt-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded text-xs text-slate-200 focus:border-emerald-500 focus:outline-none"
            >
              <option value="">None (just save spec)</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="text-[10px] text-slate-600 leading-relaxed">
          {selectedModel && <span className="text-slate-500">{PROVIDER_LABELS[selectedModel.provider]}</span>}
          {' '}— Uses web search where supported. Cost depends on output length and searches.
          {providers && Object.values(providers).filter(Boolean).length < 5 && (
            <span className="block mt-1 text-amber-600">Configure more providers in Settings → Research Providers for more model options.</span>
          )}
        </div>

        {error && <div className="text-[11px] text-red-400 mt-3">{error}</div>}

        <div className="flex gap-2 mt-5">
          <button onClick={onClose} className="flex-1 px-3 py-2 text-[11px] text-slate-400 border border-slate-700 rounded">Cancel</button>
          <button
            onClick={submit}
            disabled={submitting || prompt.trim().length < 3}
            className="flex-1 px-3 py-2 text-[11px] text-emerald-300 bg-emerald-950/50 border border-emerald-500/40 rounded hover:bg-emerald-950 disabled:opacity-50"
          >
            {submitting ? 'Starting...' : 'Run Research'}
          </button>
        </div>
      </div>
    </div>
  );
}

function AttachModal({ runId, agents, onClose, onAttached }: {
  runId: string;
  agents: Agent[];
  onClose: () => void;
  onAttached: () => void;
}) {
  const [agentId, setAgentId] = useState<string>(agents[0]?.id ?? '');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!agentId) return;
    setSubmitting(true);
    try {
      await apiPost(`/specs/${runId}/attach`, { agent_id: agentId });
      onAttached();
      onClose();
    } catch (e) {
      alert('Attach failed: ' + (e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-lg p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-bold text-slate-100 mb-4">Attach Spec to Agent</h3>
        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded text-xs text-slate-200 focus:border-emerald-500 focus:outline-none"
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 px-3 py-2 text-[11px] text-slate-400 border border-slate-700 rounded">Cancel</button>
          <button
            onClick={submit}
            disabled={submitting || !agentId}
            className="flex-1 px-3 py-2 text-[11px] text-emerald-300 bg-emerald-950/50 border border-emerald-500/40 rounded disabled:opacity-50"
          >
            {submitting ? 'Attaching...' : 'Attach'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SpecDetail({ run, agents, onBack, onChanged }: {
  run: ResearchRun;
  agents: Agent[];
  onBack: () => void;
  onChanged: () => void;
}) {
  const [showAttach, setShowAttach] = useState(false);
  const attachedAgent = agents.find((a) => a.id === run.target_agent_id);

  const copy = () => {
    navigator.clipboard.writeText(run.output_md).catch(() => {});
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-4">
        <button onClick={onBack} className="text-[10px] text-slate-600 hover:text-emerald-400">← Back</button>
        <div className="flex items-center gap-1">
          {run.status === 'done' && (
            <>
              <button
                onClick={copy}
                className="px-2 py-1 text-[10px] text-slate-400 border border-slate-700 rounded hover:text-slate-200"
              >
                Copy
              </button>
              <button
                onClick={() => setShowAttach(true)}
                className="px-2 py-1 text-[10px] font-bold tracking-wider text-emerald-300 bg-emerald-950/50 border border-emerald-500/40 rounded hover:bg-emerald-950"
              >
                📎 ATTACH
              </button>
            </>
          )}
        </div>
      </div>

      <div className="mb-4">
        <h2 className="text-base font-bold text-slate-100">{run.title}</h2>
        <div className="flex items-center gap-2 mt-2 flex-wrap text-[9px]">
          <span className="px-1.5 py-0.5 rounded bg-slate-800/60 text-slate-400 font-mono">{run.model}</span>
          {run.status === 'running' ? (
            <span className="px-1.5 py-0.5 rounded bg-amber-950/40 border border-amber-500/30 text-amber-300 font-bold tracking-wider animate-pulse">RUNNING</span>
          ) : run.status === 'done' ? (
            <span className="px-1.5 py-0.5 rounded bg-emerald-950/40 border border-emerald-500/30 text-emerald-300 font-bold tracking-wider">DONE</span>
          ) : (
            <span className="px-1.5 py-0.5 rounded bg-red-950/40 border border-red-500/30 text-red-300 font-bold tracking-wider">{run.status.toUpperCase()}</span>
          )}
          <span className="text-slate-500">{run.tokens_in + run.tokens_out} tokens</span>
          <span className="text-slate-500">{formatCost(run.cost_usd)}</span>
          {attachedAgent && (
            <span className="text-emerald-400/70">→ {attachedAgent.name}</span>
          )}
        </div>
      </div>

      {run.status === 'failed' && run.error && (
        <div className="mb-4 p-3 rounded bg-red-950/30 border border-red-500/30 text-[11px] text-red-300 font-mono whitespace-pre-wrap">
          {run.error}
        </div>
      )}

      {run.output_md ? (
        <div className="prose-invert max-w-none" dangerouslySetInnerHTML={{ __html: renderMarkdown(run.output_md) }} />
      ) : (
        <div className="text-[11px] text-slate-600 italic py-6 text-center">
          {run.status === 'running' ? 'Researching...' : 'No output'}
        </div>
      )}

      {showAttach && (
        <AttachModal
          runId={run.id}
          agents={agents}
          onClose={() => setShowAttach(false)}
          onAttached={onChanged}
        />
      )}
    </div>
  );
}

export default function Specs() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<ResearchRun[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(() => {
    apiGet<ResearchRun[]>('/specs').then(setRuns).catch(() => setRuns([]));
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    apiGet<Agent[]>('/agents').then(setAgents).catch(() => {});
  }, []);

  const reloadSelected = useCallback(async () => {
    if (!selectedId) return;
    try {
      const run = await apiGet<ResearchRun>(`/specs/${selectedId}`);
      setRuns((prev) => prev.map((r) => r.id === run.id ? run : r));
    } catch { /* ignore */ }
  }, [selectedId]);

  // Live updates via SSE
  useSSE((event) => {
    if (event.entityType !== 'research_run') return;
    const runId = event.entityId;
    if (event.type === 'research.chunk') {
      const chunk = event.payload?.chunk as string | undefined;
      if (!chunk) return;
      setRuns((prev) => prev.map((r) =>
        r.id === runId ? { ...r, output_md: r.output_md + chunk } : r,
      ));
    } else if (event.type === 'research.finished' || event.type === 'research.started') {
      // Re-fetch the run for authoritative state
      apiGet<ResearchRun>(`/specs/${runId}`).then((run) => {
        setRuns((prev) => {
          const exists = prev.some((r) => r.id === runId);
          if (exists) return prev.map((r) => r.id === runId ? run : r);
          return [run, ...prev];
        });
      }).catch(() => {});
    }
  });

  const selected = useMemo(() => runs.find((r) => r.id === selectedId) ?? null, [runs, selectedId]);

  const remove = async (id: string, title: string) => {
    if (!confirm(`Delete spec '${title}'?`)) return;
    try { await apiDelete(`/specs/${id}`); load(); }
    catch (e) { alert('Delete failed: ' + (e as Error).message); }
  };

  if (selected) {
    return (
      <div className="max-w-2xl mx-auto px-4 pt-6 pb-20">
        <SpecDetail
          run={selected}
          agents={agents}
          onBack={() => setSelectedId(null)}
          onChanged={() => { load(); reloadSelected(); }}
        />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 pt-6 pb-20">
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-sm font-bold text-slate-300 tracking-[0.15em] uppercase">Specs</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowNew(true)}
            className="px-3 py-1.5 text-[10px] font-bold tracking-wider text-emerald-300 bg-emerald-950/50 border border-emerald-500/40 rounded hover:bg-emerald-950"
          >
            + NEW SPEC
          </button>
          <button
            onClick={() => navigate('/settings')}
            className="text-[10px] text-slate-600 hover:text-slate-400"
            title="Settings"
          >
            ⚙
          </button>
        </div>
      </div>

      <div className="text-[10px] text-slate-600 mb-4 leading-relaxed">
        Run research jobs that produce markdown specs, then attach them to coding agents.
      </div>

      {runs.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-2xl mb-3">🔍</div>
          <div className="text-slate-600 text-sm">No specs yet</div>
          <div className="text-[10px] text-slate-700 mt-2">Research a topic, get a markdown spec, hand it to an agent</div>
        </div>
      ) : (
        <div className="space-y-2">
          {runs.map((r) => {
            const targetAgent = agents.find((a) => a.id === r.target_agent_id);
            return (
              <div key={r.id} className="group rounded-lg bg-slate-900/60 border border-slate-800/40 hover:border-emerald-500/30 transition-all">
                <button
                  onClick={() => setSelectedId(r.id)}
                  className="w-full text-left px-4 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        {r.status === 'running' && <span className="text-amber-400 text-[10px] animate-pulse">⋯</span>}
                        {r.status === 'done' && <span className="text-emerald-400 text-[10px]">●</span>}
                        {r.status === 'failed' && <span className="text-red-400 text-[10px]">✗</span>}
                        <span className="text-sm font-medium text-slate-200 truncate">{r.title}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap text-[9px]">
                        <span className="text-slate-500 font-mono">{r.model}</span>
                        <span className="text-slate-600">·</span>
                        <span className="text-slate-500">{formatCost(r.cost_usd)}</span>
                        <span className="text-slate-600">·</span>
                        <span className="text-slate-600">{formatDate(r.created_at)}</span>
                        {targetAgent && (
                          <>
                            <span className="text-slate-600">·</span>
                            <span className="text-emerald-400/70">→ {targetAgent.name}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); remove(r.id, r.title); }}
                      className="opacity-0 group-hover:opacity-100 text-red-400/60 hover:text-red-400 text-[11px] px-1"
                    >
                      ×
                    </button>
                  </div>
                </button>
              </div>
            );
          })}
        </div>
      )}

      {showNew && (
        <NewSpecModal
          agents={agents}
          onClose={() => setShowNew(false)}
          onCreated={(run) => {
            setRuns((prev) => [run, ...prev]);
            setSelectedId(run.id);
          }}
        />
      )}
    </div>
  );
}
