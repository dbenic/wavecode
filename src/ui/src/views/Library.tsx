import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiGet, apiPost, apiDelete } from '../hooks/useApi';
import type { Agent } from '../types';
import { renderMarkdown } from '../utils/markdown';

interface GuideSource {
  id: string;
  name: string;
  kind: 'git' | 'local';
  url: string | null;
  path: string;
  glob: string;
  last_synced_at: string | null;
  created_at: string;
}

interface Guide {
  id: string;
  source_id: string;
  slug: string;
  title: string;
  file_path: string;
  description: string | null;
  tags: string | null;
  size_bytes: number;
  modified_at: string;
}

interface GuideDetail extends Guide {
  content: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function formatDate(iso: string | null): string {
  if (!iso) return 'never';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function AddSourceModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [glob, setGlob] = useState('**/*.md');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim() || !url.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiPost('/guide-sources', { name: name.trim(), url: url.trim(), glob: glob.trim() || undefined });
      onAdded();
      onClose();
    } catch (e) {
      setError((e as Error).message || 'Failed to add source');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-lg p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-bold text-slate-100 mb-4 tracking-wide">Add Guide Source</h3>
        <div className="space-y-3">
          <label className="block">
            <span className="text-[10px] text-slate-500 uppercase tracking-wider">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="awesome-design-md"
              className="w-full mt-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded text-xs text-slate-200 focus:border-emerald-500 focus:outline-none"
              autoFocus
            />
          </label>
          <label className="block">
            <span className="text-[10px] text-slate-500 uppercase tracking-wider">Git URL</span>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/VoltAgent/awesome-design-md"
              className="w-full mt-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded text-xs text-slate-200 font-mono focus:border-emerald-500 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-[10px] text-slate-500 uppercase tracking-wider">File glob</span>
            <input
              type="text"
              value={glob}
              onChange={(e) => setGlob(e.target.value)}
              className="w-full mt-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded text-xs text-slate-200 font-mono focus:border-emerald-500 focus:outline-none"
            />
          </label>
        </div>
        {error && <div className="text-[11px] text-red-400 mt-3">{error}</div>}
        <div className="flex gap-2 mt-5">
          <button
            onClick={onClose}
            className="flex-1 px-3 py-2 text-[11px] text-slate-400 hover:text-slate-200 border border-slate-700 rounded"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting || !name.trim() || !url.trim()}
            className="flex-1 px-3 py-2 text-[11px] text-emerald-300 bg-emerald-950/50 border border-emerald-500/40 rounded hover:bg-emerald-950 disabled:opacity-50"
          >
            {submitting ? 'Cloning...' : 'Clone & Index'}
          </button>
        </div>
      </div>
    </div>
  );
}

function AttachModal({
  guide, agents, onClose, onAttached,
}: { guide: Guide; agents: Agent[]; onClose: () => void; onAttached: () => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    if (selected.size === 0) return;
    setSubmitting(true);
    try {
      await Promise.all([...selected].map((agentId) =>
        apiPost(`/agents/${agentId}/guides`, { guide_ids: [guide.id] }),
      ));
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
      <div className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-lg p-5 max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-bold text-slate-100 mb-1">Attach to agents</h3>
        <div className="text-[10px] text-slate-500 mb-4 truncate">{guide.title}</div>
        <div className="flex-1 overflow-y-auto space-y-1">
          {agents.map((a) => (
            <label key={a.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-800/50 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.has(a.id)}
                onChange={() => toggle(a.id)}
                className="accent-emerald-500"
              />
              <span className="text-xs text-slate-300 font-mono">{a.name}</span>
              <span className="text-[9px] text-slate-600 ml-auto">{a.runtime}</span>
            </label>
          ))}
          {agents.length === 0 && (
            <div className="text-[11px] text-slate-600 text-center py-6">No agents</div>
          )}
        </div>
        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 px-3 py-2 text-[11px] text-slate-400 border border-slate-700 rounded">Cancel</button>
          <button
            onClick={submit}
            disabled={submitting || selected.size === 0}
            className="flex-1 px-3 py-2 text-[11px] text-emerald-300 bg-emerald-950/50 border border-emerald-500/40 rounded disabled:opacity-50"
          >
            {submitting ? 'Attaching...' : `Attach (${selected.size})`}
          </button>
        </div>
      </div>
    </div>
  );
}

function GuideViewer({ guideId, agents, onClose }: { guideId: string; agents: Agent[]; onClose: () => void }) {
  const [detail, setDetail] = useState<GuideDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAttach, setShowAttach] = useState(false);

  useEffect(() => {
    setLoading(true);
    apiGet<GuideDetail>(`/guides/${guideId}`)
      .then(setDetail)
      .catch(() => setDetail(null))
      .finally(() => setLoading(false));
  }, [guideId]);

  if (loading) {
    return <div className="text-[10px] text-slate-600 tracking-[0.3em] uppercase animate-pulse py-10 text-center">Loading...</div>;
  }
  if (!detail) {
    return (
      <div className="text-center py-10">
        <div className="text-slate-600 text-sm">Guide not found</div>
        <button onClick={onClose} className="mt-4 text-emerald-400 text-xs">← Back</button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-4">
        <button onClick={onClose} className="text-[10px] text-slate-600 hover:text-emerald-400">← Back</button>
        <button
          onClick={() => setShowAttach(true)}
          className="px-3 py-1.5 text-[10px] font-bold tracking-wider text-emerald-300 bg-emerald-950/50 border border-emerald-500/40 rounded hover:bg-emerald-950"
        >
          📎 ATTACH TO AGENT
        </button>
      </div>
      <div className="flex items-baseline justify-between gap-3 mb-4">
        <h2 className="text-base font-bold text-slate-100">{detail.title}</h2>
        <span className="text-[9px] text-slate-700 font-mono shrink-0 truncate max-w-[50%]">{detail.slug}</span>
      </div>
      <div className="prose-invert max-w-none" dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.content) }} />
      {showAttach && (
        <AttachModal
          guide={detail}
          agents={agents}
          onClose={() => setShowAttach(false)}
          onAttached={() => { /* no-op */ }}
        />
      )}
    </div>
  );
}

function GuidesTab({ agents }: { agents: Agent[] }) {
  const [sources, setSources] = useState<GuideSource[]>([]);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [search, setSearch] = useState('');
  const [selectedSource, setSelectedSource] = useState<string>('');
  const [showAddSource, setShowAddSource] = useState(false);
  const [selectedGuideId, setSelectedGuideId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);

  const loadGuides = useCallback(() => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (selectedSource) params.set('source', selectedSource);
    apiGet<Guide[]>('/guides' + (params.toString() ? `?${params}` : ''))
      .then(setGuides)
      .catch(() => setGuides([]));
  }, [search, selectedSource]);

  const loadSources = useCallback(() => {
    apiGet<GuideSource[]>('/guide-sources').then(setSources).catch(() => setSources([]));
  }, []);

  useEffect(() => { loadSources(); }, [loadSources]);
  useEffect(() => { loadGuides(); }, [loadGuides]);

  const syncSource = async (id: string) => {
    setSyncing(id);
    try {
      await apiPost(`/guide-sources/${id}/sync`);
      loadSources();
      loadGuides();
    } catch (e) {
      alert('Sync failed: ' + (e as Error).message);
    } finally {
      setSyncing(null);
    }
  };

  const deleteSource = async (id: string, name: string) => {
    if (!confirm(`Delete source '${name}' and all its guides?`)) return;
    try {
      await apiDelete(`/guide-sources/${id}`);
      loadSources();
      loadGuides();
    } catch (e) {
      alert('Delete failed: ' + (e as Error).message);
    }
  };

  if (selectedGuideId) {
    return (
      <GuideViewer
        guideId={selectedGuideId}
        agents={agents}
        onClose={() => setSelectedGuideId(null)}
      />
    );
  }

  return (
    <div>
      {/* Sources bar */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[9px] text-slate-600 uppercase tracking-wider">Sources</span>
          <button
            onClick={() => setShowAddSource(true)}
            className="px-2 py-1 text-[9px] font-bold tracking-wider text-emerald-300 bg-emerald-950/50 border border-emerald-500/40 rounded hover:bg-emerald-950"
          >
            + ADD SOURCE
          </button>
        </div>
        {sources.length === 0 ? (
          <div className="text-[11px] text-slate-600 italic">No sources yet — add one to get started</div>
        ) : (
          <div className="space-y-1">
            {sources.map((s) => (
              <div key={s.id} className="flex items-center gap-2 px-2 py-1.5 rounded bg-slate-900/40 border border-slate-800/40 text-[10px]">
                <span className="font-mono text-slate-300">{s.name}</span>
                <span className="text-slate-600 truncate flex-1">{s.url}</span>
                <span className="text-slate-700">synced {formatDate(s.last_synced_at)}</span>
                <button
                  onClick={() => syncSource(s.id)}
                  disabled={syncing === s.id}
                  className="px-1.5 text-emerald-400 hover:text-emerald-200 disabled:opacity-50"
                  title="Sync"
                >
                  {syncing === s.id ? '⋯' : '↻'}
                </button>
                <button
                  onClick={() => deleteSource(s.id, s.name)}
                  className="px-1.5 text-red-400/60 hover:text-red-400"
                  title="Delete"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Search + filter */}
      <div className="flex gap-2 mb-4">
        <input
          type="text"
          placeholder="Search guides..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 px-3 py-2 bg-slate-900/60 border border-slate-800 rounded text-xs text-slate-200 focus:border-emerald-500 focus:outline-none"
        />
        <select
          value={selectedSource}
          onChange={(e) => setSelectedSource(e.target.value)}
          className="px-2 py-2 bg-slate-900/60 border border-slate-800 rounded text-xs text-slate-300"
        >
          <option value="">All sources</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>

      {/* Guide list */}
      {guides.length === 0 ? (
        <div className="text-center py-10">
          <div className="text-2xl mb-3">📄</div>
          <div className="text-slate-600 text-sm">No guides</div>
        </div>
      ) : (
        <div className="space-y-2">
          {guides.map((g) => {
            const source = sources.find((s) => s.id === g.source_id);
            return (
              <button
                key={g.id}
                onClick={() => setSelectedGuideId(g.id)}
                className="w-full text-left px-4 py-3 rounded-lg bg-slate-900/60 border border-slate-800/40 hover:border-emerald-500/30 hover:bg-slate-900/80 transition-all group"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-slate-200 group-hover:text-emerald-400 transition-colors truncate">
                      {g.title}
                    </div>
                    {g.description && (
                      <div className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">{g.description}</div>
                    )}
                    <div className="flex items-center gap-2 mt-1">
                      {source && (
                        <span className="text-[8px] px-1.5 py-0.5 rounded bg-slate-800/60 text-slate-500 font-mono">
                          {source.name}
                        </span>
                      )}
                      <span className="text-[9px] text-slate-600 font-mono">{formatSize(g.size_bytes)}</span>
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {showAddSource && (
        <AddSourceModal
          onClose={() => setShowAddSource(false)}
          onAdded={() => { loadSources(); loadGuides(); }}
        />
      )}
    </div>
  );
}

interface Template {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  git_url: string | null;
  local_path: string;
  default_runtime: string | null;
  required_env: string | null;
  post_clone_cmd: string | null;
  attach_guide_slugs: string | null;
  trusted: number;
  created_at: string;
  last_synced_at: string | null;
}

function AddTemplateModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [url, setUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!url.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiPost('/templates', { git_url: url.trim() });
      onAdded();
      onClose();
    } catch (e) {
      setError((e as Error).message || 'Failed to add template');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-lg p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-bold text-slate-100 mb-4 tracking-wide">Add Template</h3>
        <label className="block">
          <span className="text-[10px] text-slate-500 uppercase tracking-wider">Git URL</span>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/user/template-repo"
            className="w-full mt-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded text-xs text-slate-200 font-mono focus:border-emerald-500 focus:outline-none"
            autoFocus
          />
        </label>
        <div className="text-[10px] text-slate-600 mt-2 leading-relaxed">
          Template repo should contain a <code className="text-emerald-400/80">wavecode.yaml</code> manifest
          (or one will be inferred from README).
        </div>
        {error && <div className="text-[11px] text-red-400 mt-3">{error}</div>}
        <div className="flex gap-2 mt-5">
          <button onClick={onClose} className="flex-1 px-3 py-2 text-[11px] text-slate-400 border border-slate-700 rounded">Cancel</button>
          <button
            onClick={submit}
            disabled={submitting || !url.trim()}
            className="flex-1 px-3 py-2 text-[11px] text-emerald-300 bg-emerald-950/50 border border-emerald-500/40 rounded hover:bg-emerald-950 disabled:opacity-50"
          >
            {submitting ? 'Cloning...' : 'Clone & Import'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SpawnTemplateModal({
  template, onClose, onSpawned,
}: { template: Template; onClose: () => void; onSpawned: (agentId: string) => void }) {
  const requiredEnv: string[] = template.required_env ? JSON.parse(template.required_env) : [];
  const runtimePrefix = (template.default_runtime ?? 'claude-code') === 'codex' ? 'co' : 'cl';
  const [agentName, setAgentName] = useState(`${runtimePrefix}-${template.slug}`);
  const [runtime, setRuntime] = useState(template.default_runtime ?? 'claude-code');
  const [envValues, setEnvValues] = useState<Record<string, string>>(
    Object.fromEntries(requiredEnv.map((k) => [k, ''])),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!agentName.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await apiPost<{ agent: { id: string }; steps: string[]; postCloneSkipped: boolean }>(
        `/templates/${template.id}/spawn`,
        { agent_name: agentName.trim(), runtime, env: envValues },
      );
      onSpawned(result.agent.id);
      onClose();
    } catch (e) {
      setError((e as Error).message || 'Spawn failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-lg p-5 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-bold text-slate-100 mb-1">Spawn from Template</h3>
        <div className="text-[10px] text-slate-500 mb-4 font-mono truncate">{template.slug}</div>

        {!template.trusted && template.post_clone_cmd && (
          <div className="mb-4 p-2 rounded bg-amber-950/30 border border-amber-500/30 text-[10px] text-amber-300">
            ⚠ Template is not trusted. <code className="text-amber-200">post_clone</code> step will be skipped.
          </div>
        )}

        <label className="block mb-3">
          <span className="text-[10px] text-slate-500 uppercase tracking-wider">Agent Name</span>
          <input
            type="text"
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            className="w-full mt-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded text-xs text-slate-200 font-mono focus:border-emerald-500 focus:outline-none"
            autoFocus
          />
        </label>

        <label className="block mb-3">
          <span className="text-[10px] text-slate-500 uppercase tracking-wider">Runtime</span>
          <select
            value={runtime}
            onChange={(e) => setRuntime(e.target.value)}
            className="w-full mt-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded text-xs text-slate-200 focus:border-emerald-500 focus:outline-none"
          >
            <option value="claude-code">claude-code</option>
            <option value="codex">codex</option>
            <option value="aider">aider</option>
          </select>
        </label>

        {requiredEnv.length > 0 && (
          <div className="mb-3">
            <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">Required Environment</div>
            <div className="space-y-2">
              {requiredEnv.map((key) => (
                <label key={key} className="block">
                  <span className="text-[10px] text-slate-400 font-mono">{key}</span>
                  <input
                    type="text"
                    value={envValues[key] ?? ''}
                    onChange={(e) => setEnvValues({ ...envValues, [key]: e.target.value })}
                    className="w-full mt-0.5 px-3 py-1.5 bg-slate-950 border border-slate-700 rounded text-xs text-slate-200 font-mono focus:border-emerald-500 focus:outline-none"
                  />
                </label>
              ))}
            </div>
          </div>
        )}

        {error && <div className="text-[11px] text-red-400 mt-3">{error}</div>}
        <div className="flex gap-2 mt-5">
          <button onClick={onClose} className="flex-1 px-3 py-2 text-[11px] text-slate-400 border border-slate-700 rounded">Cancel</button>
          <button
            onClick={submit}
            disabled={submitting || !agentName.trim()}
            className="flex-1 px-3 py-2 text-[11px] text-emerald-300 bg-emerald-950/50 border border-emerald-500/40 rounded hover:bg-emerald-950 disabled:opacity-50"
          >
            {submitting ? 'Spawning...' : 'Spawn Agent'}
          </button>
        </div>
      </div>
    </div>
  );
}

function TemplatesTab() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [spawnTarget, setSpawnTarget] = useState<Template | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    apiGet<Template[]>('/templates').then(setTemplates).catch(() => setTemplates([]));
  }, []);

  useEffect(() => { load(); }, [load]);

  const sync = async (id: string) => {
    setBusyId(id);
    try { await apiPost(`/templates/${id}/sync`); load(); }
    catch (e) { alert('Sync failed: ' + (e as Error).message); }
    finally { setBusyId(null); }
  };

  const trust = async (id: string) => {
    if (!confirm('Trust this template? Its post_clone script will run on spawn.')) return;
    try { await apiPost(`/templates/${id}/trust`); load(); }
    catch (e) { alert('Trust failed: ' + (e as Error).message); }
  };

  const remove = async (id: string, name: string) => {
    if (!confirm(`Delete template '${name}'?`)) return;
    try { await apiDelete(`/templates/${id}`); load(); }
    catch (e) { alert('Delete failed: ' + (e as Error).message); }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <span className="text-[9px] text-slate-600 uppercase tracking-wider">Templates</span>
        <button
          onClick={() => setShowAdd(true)}
          className="px-2 py-1 text-[9px] font-bold tracking-wider text-emerald-300 bg-emerald-950/50 border border-emerald-500/40 rounded hover:bg-emerald-950"
        >
          + ADD TEMPLATE
        </button>
      </div>

      {templates.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-2xl mb-3">🧩</div>
          <div className="text-slate-600 text-sm">No templates yet</div>
          <div className="text-[10px] text-slate-700 mt-2">Clone a git repo with a wavecode.yaml manifest</div>
        </div>
      ) : (
        <div className="space-y-2">
          {templates.map((t) => {
            const requiredEnv: string[] = t.required_env ? JSON.parse(t.required_env) : [];
            const guides: string[] = t.attach_guide_slugs ? JSON.parse(t.attach_guide_slugs) : [];
            return (
              <div key={t.id} className="px-4 py-3 rounded-lg bg-slate-900/60 border border-slate-800/40">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-slate-200 truncate">{t.name}</span>
                      {t.trusted ? (
                        <span className="text-[8px] px-1.5 py-0.5 rounded bg-emerald-950/60 border border-emerald-500/30 text-emerald-300 font-bold tracking-wider">TRUSTED</span>
                      ) : t.post_clone_cmd ? (
                        <span className="text-[8px] px-1.5 py-0.5 rounded bg-amber-950/40 border border-amber-500/30 text-amber-300 font-bold tracking-wider">UNTRUSTED</span>
                      ) : null}
                    </div>
                    {t.description && (
                      <div className="text-[11px] text-slate-500 mt-1 line-clamp-2">{t.description}</div>
                    )}
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      <span className="text-[8px] px-1.5 py-0.5 rounded bg-slate-800/60 text-slate-500 font-mono">{t.slug}</span>
                      {t.default_runtime && (
                        <span className="text-[8px] px-1.5 py-0.5 rounded bg-slate-800/60 text-slate-400 font-mono">{t.default_runtime}</span>
                      )}
                      {requiredEnv.length > 0 && (
                        <span className="text-[8px] text-slate-600">{requiredEnv.length} env var{requiredEnv.length > 1 ? 's' : ''}</span>
                      )}
                      {guides.length > 0 && (
                        <span className="text-[8px] text-violet-400/70">📎 {guides.length} guide{guides.length > 1 ? 's' : ''}</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1 mt-3">
                  <button
                    onClick={() => setSpawnTarget(t)}
                    className="px-2 py-1 text-[10px] font-bold tracking-wider text-emerald-300 bg-emerald-950/50 border border-emerald-500/40 rounded hover:bg-emerald-950"
                  >
                    SPAWN
                  </button>
                  <button
                    onClick={() => sync(t.id)}
                    disabled={busyId === t.id}
                    className="px-2 py-1 text-[10px] text-slate-400 border border-slate-700 rounded hover:text-slate-200 disabled:opacity-50"
                    title="git pull & re-parse manifest"
                  >
                    {busyId === t.id ? '⋯' : '↻ Sync'}
                  </button>
                  {!t.trusted && t.post_clone_cmd && (
                    <button
                      onClick={() => trust(t.id)}
                      className="px-2 py-1 text-[10px] text-amber-300 border border-amber-500/30 rounded hover:bg-amber-950/30"
                    >
                      Trust
                    </button>
                  )}
                  <button
                    onClick={() => remove(t.id, t.name)}
                    className="ml-auto px-2 py-1 text-[10px] text-red-400/60 hover:text-red-400"
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showAdd && <AddTemplateModal onClose={() => setShowAdd(false)} onAdded={load} />}
      {spawnTarget && (
        <SpawnTemplateModal
          template={spawnTarget}
          onClose={() => setSpawnTarget(null)}
          onSpawned={(agentId) => navigate(`/agent/${agentId}`)}
        />
      )}
    </div>
  );
}

export default function Library() {
  const navigate = useNavigate();
  const { tab, guideId } = useParams<{ tab?: string; guideId?: string }>();
  const [activeTab, setActiveTab] = useState<'guides' | 'templates'>(
    (tab === 'templates' ? 'templates' : 'guides'),
  );
  const [agents, setAgents] = useState<Agent[]>([]);

  useEffect(() => {
    apiGet<Agent[]>('/agents').then(setAgents).catch(() => {});
  }, []);

  // Deep link to a specific guide
  useEffect(() => {
    if (guideId) setActiveTab('guides');
  }, [guideId]);

  return (
    <div className="max-w-2xl mx-auto px-4 pt-6 pb-20">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-sm font-bold text-slate-300 tracking-[0.15em] uppercase">Library</h1>
        <button
          onClick={() => navigate('/settings')}
          className="text-[10px] text-slate-600 hover:text-slate-400"
        >
          Settings ⚙
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-5 border-b border-slate-800/60">
        {(['guides', 'templates'] as const).map((t) => (
          <button
            key={t}
            onClick={() => { setActiveTab(t); navigate(`/library/${t}`); }}
            className={`px-4 py-2 text-[11px] font-bold tracking-wider uppercase transition-colors border-b-2 -mb-px ${
              activeTab === t
                ? 'text-emerald-400 border-emerald-500'
                : 'text-slate-600 border-transparent hover:text-slate-400'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {activeTab === 'guides' ? <GuidesTab agents={agents} /> : <TemplatesTab />}
    </div>
  );
}
