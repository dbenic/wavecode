import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost } from '../hooks/useApi';
import { useSSE, type SSEEvent } from '../hooks/useSSE';
import type { Agent, ProfileInfo, TmuxSession } from '../types';
import { shouldReloadAgentList } from '../sse-events';
import AgentCard from '../components/AgentCard';

interface SpawnSettings { runtimes: string[]; projects: Array<{ name: string; repo: string | null }>; spawn: { max_per_user: number | null } }

const RUNTIME_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', grok: 'Grok', aider: 'Aider' };

/**
 * Add an agent on your own subscription: pick the CLI, the project (its base clone gives the
 * agent a worktree and a branch), a name; see whether your profile is logged in for that CLI
 * and which account it runs on before you press Spawn.
 */
function SpawnAgentModal({
  onClose,
  onSpawned,
}: {
  onClose: () => void;
  onSpawned: (agent: Agent) => void;
}) {
  const navigate = useNavigate();
  const [settings, setSettings] = useState<SpawnSettings | null>(null);
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [me, setMe] = useState<{ name: string; role: string; profile: string | null } | null>(null);
  const [runtime, setRuntime] = useState('claude-code');
  const [project, setProject] = useState('');
  const [repo, setRepo] = useState('');
  const [name, setName] = useState('');
  const [profile, setProfile] = useState<string>('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([apiGet<SpawnSettings>('/settings'), apiGet<ProfileInfo[]>('/profiles'), apiGet<{ name: string; role: string; profile: string | null }>('/me')])
      .then(([st, ps, u]) => {
        setSettings(st);
        setProfiles(ps);
        setMe(u);
        if (st.runtimes.length && !st.runtimes.includes(runtime)) setRuntime(st.runtimes[0]);
        const first = st.projects.find((x) => x.repo);
        if (first) { setProject(first.name); setRepo(first.repo ?? ''); }
        const mine = ps.find((x) => x.mine);
        setProfile(mine?.name ?? '');
        if (!name && u.name) setName(`${u.name}-${(st.runtimes.includes('codex') ? 'codex' : 'claude')}`.replace(/[^a-zA-Z0-9._-]/g, '-'));
      })
      .catch(() => { /* the form still works with typed values */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isAdmin = me?.role === 'admin';
  const chosen = profiles.find((x) => x.name === profile) ?? null;
  const rtState = chosen?.runtimes[runtime] ?? null;
  const loggedIn = !chosen || !rtState ? null : rtState.logged_in;
  const subscription = rtState?.subscription ?? null;
  const quota = settings?.spawn.max_per_user ?? null;
  const used = rtState ? Object.values(chosen!.runtimes).reduce((n, r) => n + r.agents, 0) : 0;

  const handleSubmit = async () => {
    if (!name.trim() || !runtime) return;
    setSubmitting(true);
    setError(null);
    try {
      const agent = await apiPost<Agent>('/agents/spawn', {
        name: name.trim(),
        runtime,
        ...(repo.trim() ? { repo: repo.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(effort ? { effort } : {}),
        ...(isAdmin && profile && !chosen?.mine ? { profile } : {}),
      });
      onSpawned(agent);
    } catch (e) {
      setError((e as Error).message || 'Spawn failed');
    } finally {
      setSubmitting(false);
    }
  };

  const field = 'w-full px-3 py-2 rounded border border-slate-700/60 bg-slate-950/50 text-sm text-slate-200 font-mono focus:outline-none focus:border-emerald-500/40';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg border border-slate-700/60 bg-slate-900 p-5 space-y-4" onClick={(e) => e.stopPropagation()} data-testid="spawn-modal">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold tracking-[0.15em] text-slate-100 uppercase">Add agent</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 text-sm">&times;</button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-[9px] uppercase tracking-wider text-slate-500">CLI</span>
            <select value={runtime} onChange={(e) => setRuntime(e.target.value)} className={field} aria-label="Runtime">
              {(settings?.runtimes ?? ['claude-code', 'codex']).map((rt) => <option key={rt} value={rt}>{RUNTIME_LABEL[rt] ?? rt}</option>)}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-[9px] uppercase tracking-wider text-slate-500">Project</span>
            <select
              value={project}
              onChange={(e) => { const p = settings?.projects.find((x) => x.name === e.target.value); setProject(e.target.value); setRepo(p?.repo ?? ''); }}
              className={field}
              aria-label="Project"
            >
              <option value="">custom path…</option>
              {(settings?.projects ?? []).map((p) => <option key={p.name} value={p.name} disabled={!p.repo}>{p.name}{p.repo ? '' : ' (no repo)'}</option>)}
            </select>
          </label>
        </div>

        <label className="block space-y-1">
          <span className="text-[9px] uppercase tracking-wider text-slate-500">Repo (base clone — the agent gets its own worktree and branch wc-&lt;name&gt;)</span>
          <input value={repo} onChange={(e) => { setRepo(e.target.value); setProject(''); }} placeholder="/home/wave/repos/wavepulse" className={field} aria-label="Repo" />
        </label>

        <label className="block space-y-1">
          <span className="text-[9px] uppercase tracking-wider text-slate-500">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="antonio-codex" className={field} aria-label="Name" />
        </label>

        {/* Subscription: the profile the agent runs on */}
        <div className="rounded border border-slate-800/60 bg-slate-950/50 px-3 py-2 text-[11px] space-y-1" data-testid="spawn-subscription">
          <div className="flex items-center gap-2">
            <span className="text-[9px] uppercase tracking-wider text-slate-500">Subscription</span>
            {isAdmin ? (
              <select value={profile} onChange={(e) => setProfile(e.target.value)} className="px-2 py-0.5 rounded border border-slate-800/60 bg-slate-950/50 text-[10px] text-slate-300 font-mono" aria-label="Profile">
                {profiles.map((p) => <option key={p.name} value={p.name}>{p.name}{p.mine ? ' (you)' : p.public ? ' (pool)' : p.shared ? ' (shared)' : ''}</option>)}
              </select>
            ) : (
              <span className="font-mono text-slate-200">{profile || 'home login'}</span>
            )}
          </div>
          {chosen && (
            loggedIn ? (
              <p className="text-emerald-300">{RUNTIME_LABEL[runtime] ?? runtime} logged in{subscription ? ` · ${[subscription.account, subscription.plan].filter(Boolean).join(' · ')}` : ''}</p>
            ) : (
              <p className="text-amber-300">
                {RUNTIME_LABEL[runtime] ?? runtime} is not logged in on this profile.{' '}
                <button onClick={() => navigate('/settings')} className="underline underline-offset-2">Log in under Settings → Profiles</button> first.
              </p>
            )
          )}
          {quota !== null && !isAdmin && <p className="text-[10px] text-slate-500">{used} of {quota} agents on your profile</p>}
        </div>

        <details className="text-[11px]">
          <summary className="cursor-pointer text-slate-500">Model and effort (optional pins)</summary>
          <div className="grid grid-cols-2 gap-3 mt-2">
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="model id (default: the CLI's own)" className={field} aria-label="Model" />
            <select value={effort} onChange={(e) => setEffort(e.target.value)} className={field} aria-label="Effort">
              <option value="">effort: default</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="xhigh">xhigh</option>
            </select>
          </div>
        </details>

        {error && <p className="text-[11px] text-red-400 border border-red-500/30 rounded px-3 py-2">{error}</p>}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-3 py-1.5 text-[11px] text-slate-400 hover:text-slate-200">Cancel</button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !name.trim() || loggedIn === false}
            title={loggedIn === false ? 'Log the profile in first' : undefined}
            className="px-4 py-1.5 rounded border border-emerald-500/40 text-[11px] font-semibold tracking-wider text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40"
          >
            {submitting ? 'Spawning...' : 'Spawn Agent'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const navigate = useNavigate();
  const [scanning, setScanning] = useState(false);
  const [sessions, setSessions] = useState<TmuxSession[] | null>(null);
  const [adoptingSession, setAdoptingSession] = useState<string | null>(null);
  const [showSpawn, setShowSpawn] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Fetch agents on mount
  useEffect(() => {
    apiGet<Agent[]>('/agents')
      .then((data) => {
        setAgents(data);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  // SSE live updates
  const handleSSE = useCallback((event: SSEEvent) => {
    if (event.entityType !== 'agent') return;

    if (event.type === 'agent.status_changed' || event.type === 'agent.output_updated') {
      setAgents((prev) =>
        prev.map((a) =>
          a.id === event.entityId
            ? {
                ...a,
                status: (event.payload?.status as Agent['status']) ?? a.status,
                lastOutputLine:
                  (event.payload?.lastOutputLine as string) ?? a.lastOutputLine,
              }
            : a,
        ),
      );
    }

    if (shouldReloadAgentList(event.type)) {
      // Refetch to get the new agent
      apiGet<Agent[]>('/agents').then(setAgents).catch(() => {});
    }

    if (event.type === 'agent.detached' || event.type === 'agent.killed') {
      setAgents((prev) => prev.filter((a) => a.id !== event.entityId));
    }
  }, []);

  useSSE(handleSSE);

  // Scan for tmux sessions
  const handleScan = async () => {
    setScanning(true);
    try {
      const data = await apiPost<TmuxSession[]>('/agents/scan');
      setSessions(data);
    } catch {
      // Scan failed
    } finally {
      setScanning(false);
    }
  };

  // Adopt a session
  const handleAdopt = async (session: TmuxSession) => {
    setAdoptingSession(session.name);
    try {
      await apiPost('/agents/adopt', {
        sessionName: session.name,
        runtime: 'claude-code', // Default; could add a selector
      });
      // Refetch agents
      const data = await apiGet<Agent[]>('/agents');
      setAgents(data);
      // Remove from sessions list
      setSessions((prev) =>
        prev ? prev.map((s) => (s.name === session.name ? { ...s, adopted: true } : s)) : null,
      );
    } catch {
      // Adopt failed
    } finally {
      setAdoptingSession(null);
    }
  };

  const workingCount = agents.filter((a) => a.status === 'working').length;
  const errorCount = agents.filter((a) => a.status === 'error').length;

  const handleStopAll = async () => {
    if (!window.confirm('EMERGENCY STOP: kill all spawned agents, interrupt adopted ones, and disable auto-dispatch?')) {
      return;
    }
    try {
      await apiPost('/system/stop-all');
      const data = await apiGet<Agent[]>('/agents');
      setAgents(data);
    } catch {
      // Stop-all failed; SSE will reconcile state
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 relative">
      {/* Global scan-line overlay */}
      <div
        className="pointer-events-none fixed inset-0 z-50 opacity-[0.015]"
        style={{
          backgroundImage:
            'repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(255,255,255,0.03) 3px, rgba(255,255,255,0.03) 6px)',
        }}
      />

      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-slate-800/60 bg-slate-950/90 backdrop-blur-xl">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Logo */}
            <img src="/favicon.svg" alt="WaveCode" className="w-8 h-8" />
            <div>
              <h1 className="text-sm font-bold tracking-[0.15em] text-slate-100 uppercase">
                WaveCode
              </h1>
              <p className="text-[9px] text-slate-600 tracking-[0.3em] uppercase">
                Agent Orchestrator
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Status summary */}
            {agents.length > 0 && (
              <div className="hidden sm:flex items-center gap-3 text-[10px] tracking-wider mr-2">
                <span className="text-slate-500">
                  {agents.length} AGENT{agents.length !== 1 ? 'S' : ''}
                </span>
                {workingCount > 0 && (
                  <span className="text-emerald-400">{workingCount} ACTIVE</span>
                )}
                {errorCount > 0 && (
                  <span className="text-red-400">{errorCount} ERROR</span>
                )}
              </div>
            )}

            {/* Emergency stop — always visible, including mobile */}
            {agents.length > 0 && (
              <button
                onClick={handleStopAll}
                title="Kill all spawned agents, interrupt adopted ones, disable auto-dispatch"
                className="inline-flex px-3 py-1.5 rounded bg-red-950 border border-red-500/60 text-[11px] font-bold tracking-wider uppercase text-red-300 hover:bg-red-900 hover:border-red-400 transition-all duration-200 active:scale-95 shadow-[0_0_8px_rgba(239,68,68,0.15)]"
              >
                Stop All
              </button>
            )}

            {/* Nav buttons — hidden on mobile, BottomNav handles it */}
            <button
              onClick={() => navigate('/chat')}
              className="hidden sm:inline-flex px-3 py-1.5 rounded bg-emerald-950 border border-emerald-500/40 text-[11px] font-bold tracking-wider uppercase text-emerald-300 hover:bg-emerald-900 hover:border-emerald-400 transition-all duration-200 active:scale-95 shadow-[0_0_8px_rgba(16,185,129,0.1)]"
            >
              Chat
            </button>
            <button
              onClick={() => navigate('/tasks')}
              className="hidden sm:inline-flex px-3 py-1.5 rounded border border-slate-700/50 text-[11px] font-semibold tracking-wider uppercase text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-all duration-200 active:scale-95"
            >
              Tasks
            </button>
            <button
              onClick={() => navigate('/review')}
              className="hidden sm:inline-flex px-3 py-1.5 rounded border border-slate-700/50 text-[11px] font-semibold tracking-wider uppercase text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-all duration-200 active:scale-95"
            >
              Review
            </button>
            <button
              onClick={() => navigate('/artifacts')}
              className="hidden sm:inline-flex px-3 py-1.5 rounded border border-slate-700/50 text-[11px] font-semibold tracking-wider uppercase text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-all duration-200 active:scale-95"
            >
              Files
            </button>
            <button
              onClick={() => navigate('/settings')}
              className="hidden sm:inline-flex px-2 py-1.5 rounded border border-slate-700/50 text-[11px] text-slate-500 hover:text-slate-200 hover:border-slate-600 transition-all duration-200 active:scale-95"
              title="Settings"
            >
              ⚙
            </button>

            {/* Scan button */}
            <button
              onClick={() => setShowSpawn(true)}
              className="px-3 py-1.5 rounded border border-emerald-500/40 bg-emerald-950/50 text-[11px] font-bold tracking-wider uppercase text-emerald-300 hover:bg-emerald-900 hover:border-emerald-400 transition-all duration-200 active:scale-95"
            >
              Spawn
            </button>
            <button
              onClick={handleScan}
              disabled={scanning}
              className={`
                px-3 py-1.5 rounded border text-[11px] font-semibold tracking-wider uppercase
                transition-all duration-200
                ${
                  scanning
                    ? 'border-slate-700 text-slate-600 cursor-wait'
                    : 'border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 hover:border-emerald-500/50 active:scale-95'
                }
              `}
            >
              {scanning ? 'Scanning...' : 'Scan'}
            </button>
          </div>
        </div>
      </header>

      {/* Scan results panel */}
      {sessions && (
        <div className="max-w-5xl mx-auto px-4 pt-4">
          <div className="rounded-lg border border-slate-800/60 bg-slate-900/50 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-800/40 flex items-center justify-between">
              <span className="text-[10px] text-slate-500 tracking-[0.2em] uppercase font-semibold">
                tmux Sessions
              </span>
              <button
                onClick={() => setSessions(null)}
                className="text-[10px] text-slate-600 hover:text-slate-400 transition-colors"
              >
                CLOSE
              </button>
            </div>
            {sessions.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-slate-600">
                No tmux sessions found on this server.
              </div>
            ) : (
              <div className="divide-y divide-slate-800/30">
                {sessions.map((s) => (
                  <div
                    key={s.name}
                    className="px-4 py-2.5 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <p className="text-xs text-slate-300 font-mono truncate">
                        {s.name}
                      </p>
                      <p className="text-[10px] text-slate-600">
                        Active{' '}
                        {Math.floor((Date.now() / 1000 - s.lastActivity) / 60)}m
                        ago
                      </p>
                    </div>
                    {s.adopted ? (
                      <span className="text-[10px] text-slate-600 tracking-wider">
                        ADOPTED
                      </span>
                    ) : (
                      <button
                        onClick={() => handleAdopt(s)}
                        disabled={adoptingSession === s.name}
                        className={`
                          px-2.5 py-1 rounded border text-[10px] font-semibold tracking-wider
                          transition-all duration-200
                          ${
                            adoptingSession === s.name
                              ? 'border-slate-700 text-slate-600'
                              : 'border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10 hover:border-cyan-500/50'
                          }
                        `}
                      >
                        {adoptingSession === s.name ? 'Adopting...' : 'ADOPT'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Agent grid */}
      <main className="max-w-5xl mx-auto px-4 py-6 pb-24">
        {!loaded ? (
          <div className="flex items-center justify-center py-20">
            <div className="text-[10px] text-slate-600 tracking-[0.3em] uppercase animate-pulse">
              Loading agents...
            </div>
          </div>
        ) : agents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <div className="w-16 h-16 rounded-lg border border-dashed border-slate-800 flex items-center justify-center">
              <span className="text-2xl text-slate-700">~</span>
            </div>
            <div className="text-center">
              <p className="text-sm text-slate-500">No agents managed</p>
              <p className="text-[11px] text-slate-600 mt-1">
                Spawn a fresh agent or scan to adopt an existing tmux session
              </p>
              <div className="mt-4 flex items-center justify-center gap-2">
                <button
                  onClick={() => setShowSpawn(true)}
                  className="px-3 py-1.5 rounded border border-emerald-500/40 bg-emerald-950/50 text-[11px] font-bold tracking-wider uppercase text-emerald-300 hover:bg-emerald-900 hover:border-emerald-400 transition-all duration-200 active:scale-95"
                >
                  Spawn Agent
                </button>
                <button
                  onClick={handleScan}
                  disabled={scanning}
                  className="px-3 py-1.5 rounded border border-slate-700/50 text-[11px] font-semibold tracking-wider uppercase text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-all duration-200 active:scale-95"
                >
                  {scanning ? 'Scanning...' : 'Scan Sessions'}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {agents.map((agent, i) => (
              <AgentCard key={agent.id} agent={agent} index={i} />
            ))}
          </div>
        )}
      </main>

      {/* Command prompt footer */}
      <div className="fixed bottom-14 sm:bottom-0 left-0 right-0 z-30 border-t-2 border-slate-700/80 bg-slate-900 shadow-[0_-4px_20px_rgba(0,0,0,0.5)]">
        <div className="max-w-5xl mx-auto px-4 py-2.5">
          <div className="flex gap-2 items-center">
            <span className="text-emerald-500 text-lg flex-shrink-0">&#9656;</span>
            <input
              type="text"
              placeholder="What do you want to build today?"
              className="flex-1 px-3 py-2 rounded-lg border-2 border-slate-600/60 bg-slate-800/80 text-sm text-slate-100 font-mono placeholder:text-slate-500 focus:outline-none focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-400/15 transition-all"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const msg = (e.target as HTMLInputElement).value.trim();
                  navigate('/chat', { state: msg ? { initialMessage: msg } : undefined });
                }
              }}
              onClick={(e) => {
                // On mobile (touch), navigate to chat immediately
                // On desktop, let the user type first
                if ('ontouchstart' in window) {
                  e.preventDefault();
                  navigate('/chat');
                }
              }}
            />
          </div>
        </div>
      </div>

      {/* Card entrance animation */}
      {showSpawn && (
        <SpawnAgentModal
          onClose={() => setShowSpawn(false)}
          onSpawned={(agent) => {
            setAgents((prev) => [...prev, agent]);
            navigate(`/agent/${agent.id}`);
          }}
        />
      )}

      <style>{`
        @keyframes cardIn {
          from {
            opacity: 0;
            transform: translateY(12px) scale(0.97);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
      `}</style>
    </div>
  );
}
