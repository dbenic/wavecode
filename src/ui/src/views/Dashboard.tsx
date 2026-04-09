import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost } from '../hooks/useApi';
import { useSSE, type SSEEvent } from '../hooks/useSSE';
import type { Agent, TmuxSession } from '../types';
import { shouldReloadAgentList } from '../sse-events';
import AgentCard from '../components/AgentCard';

function SpawnAgentModal({
  onClose,
  onSpawned,
}: {
  onClose: () => void;
  onSpawned: (agent: Agent) => void;
}) {
  const [name, setName] = useState('co-builder');
  const [runtime, setRuntime] = useState<Agent['runtime']>('codex');
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) return;

    setSubmitting(true);
    setError(null);
    try {
      const agent = await apiPost<Agent>('/agents/spawn', {
        name: name.trim(),
        runtime,
        repo: repo.trim() || undefined,
        branch: branch.trim() || undefined,
      });
      onSpawned(agent);
      onClose();
    } catch (e) {
      setError((e as Error).message || 'Spawn failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Spawn Agent"
        className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-lg p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-bold text-slate-100 mb-4 tracking-wide">Spawn Agent</h3>

        <label className="block mb-3">
          <span className="text-[10px] text-slate-500 uppercase tracking-wider">Agent Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Agent Name"
            className="w-full mt-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded text-xs text-slate-200 font-mono focus:border-emerald-500 focus:outline-none"
            autoFocus
          />
        </label>

        <label className="block mb-3">
          <span className="text-[10px] text-slate-500 uppercase tracking-wider">Runtime</span>
          <select
            value={runtime}
            onChange={(e) => setRuntime(e.target.value as Agent['runtime'])}
            aria-label="Runtime"
            className="w-full mt-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded text-xs text-slate-200 focus:border-emerald-500 focus:outline-none"
          >
            <option value="claude-code">claude-code</option>
            <option value="codex">codex</option>
            <option value="aider">aider</option>
          </select>
        </label>

        <label className="block mb-3">
          <span className="text-[10px] text-slate-500 uppercase tracking-wider">Repo Path</span>
          <input
            type="text"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            aria-label="Repo Path"
            placeholder="/path/to/repo"
            className="w-full mt-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded text-xs text-slate-200 font-mono focus:border-emerald-500 focus:outline-none"
          />
        </label>

        <label className="block">
          <span className="text-[10px] text-slate-500 uppercase tracking-wider">Branch</span>
          <input
            type="text"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            aria-label="Branch"
            placeholder="optional"
            className="w-full mt-1 px-3 py-2 bg-slate-950 border border-slate-700 rounded text-xs text-slate-200 font-mono focus:border-emerald-500 focus:outline-none"
          />
        </label>

        <div className="text-[10px] text-slate-600 mt-2 leading-relaxed">
          Leave repo empty to create or reuse <span className="font-mono text-slate-500">projects_root/&lt;agent-name&gt;</span>.
        </div>

        {error && <div className="text-[11px] text-red-400 mt-3">{error}</div>}

        <div className="flex gap-2 mt-5">
          <button onClick={onClose} className="flex-1 px-3 py-2 text-[11px] text-slate-400 border border-slate-700 rounded">Cancel</button>
          <button
            onClick={submit}
            disabled={submitting || !name.trim()}
            className="flex-1 px-3 py-2 text-[11px] text-emerald-300 bg-emerald-950/50 border border-emerald-500/40 rounded hover:bg-emerald-950 disabled:opacity-50"
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

    if (event.type === 'agent.detached') {
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
