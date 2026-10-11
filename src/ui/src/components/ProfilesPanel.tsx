import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from '../hooks/useApi';
import { useSSE, type SSEEvent } from '../hooks/useSSE';
import type { ProfileInfo } from '../types';

const RUNTIME_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', grok: 'Grok', aider: 'Aider' };

function planLabel(s: { account: string | null; plan: string | null } | null): string {
  if (!s) return '';
  return [s.account, s.plan].filter(Boolean).join(' · ');
}

/**
 * Settings → Profiles: one row per credential profile (a subscription), one cell per CLI:
 * logged in or not, which account and plan, how many agents run on it, and a Log in button
 * that opens a login seat and shows its pane here so the device code or URL is visible.
 */
export default function ProfilesPanel() {
  const [profiles, setProfiles] = useState<ProfileInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [seat, setSeat] = useState<{ profile: string; runtime: string; agentId: string; expires_at: string | null } | null>(null);
  const [pane, setPane] = useState<string>('');
  const [done, setDone] = useState<{ logged_in: boolean; reason: string } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(() => {
    apiGet<ProfileInfo[]>('/profiles').then(setProfiles).catch((e) => setError((e as Error).message || 'profiles unavailable'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const stopPolling = () => { if (timer.current) { clearInterval(timer.current); timer.current = null; } };

  const pollPane = useCallback((agentId: string) => {
    stopPolling();
    const tick = () => {
      apiGet<{ output: string }>(`/agents/${agentId}/output?lines=30`)
        .then((r) => setPane(r.output))
        .catch(() => { /* the seat may have exited */ });
    };
    tick();
    timer.current = setInterval(tick, 3000);
  }, []);

  useEffect(() => () => stopPolling(), []);

  const handleSSE = useCallback((event: SSEEvent) => {
    if (event.type === 'profile.login_finished') {
      const p = event.payload as { profile?: string; runtime?: string; logged_in?: boolean; reason?: string };
      if (seat && p.profile === seat.profile && p.runtime === seat.runtime) {
        setDone({ logged_in: !!p.logged_in, reason: p.reason ?? 'exited' });
        stopPolling();
      }
      load();
    }
    if (event.type === 'profile.login_started' || event.type === 'agent.spawned' || event.type === 'agent.killed') load();
  }, [seat, load]);
  useSSE(handleSSE);

  const login = async (profile: string, runtime: string) => {
    setError(null);
    setDone(null);
    setPane('');
    setOpening(`${profile}:${runtime}`);
    try {
      const r = await apiPost<{ agent: { id: string }; session: string; expires_at: string }>(`/profiles/${encodeURIComponent(profile)}/login`, { runtime });
      setSeat({ profile, runtime, agentId: r.agent.id, expires_at: r.expires_at });
      pollPane(r.agent.id);
      load();
    } catch (e) {
      setError((e as Error).message || 'could not open the login');
    } finally {
      setOpening(null);
    }
  };

  const attach = (profile: string, runtime: string, agentId: string) => {
    setDone(null);
    setSeat({ profile, runtime, agentId, expires_at: null });
    pollPane(agentId);
  };

  return (
    <section className="rounded-lg border border-slate-800/50 bg-slate-900/50 overflow-hidden" data-testid="profiles-panel">
      <div className="px-4 py-3 border-b border-slate-800/50 flex items-center justify-between">
        <h2 className="text-xs font-bold tracking-[0.2em] text-slate-300 uppercase">Profiles · subscriptions</h2>
        <span className="text-[10px] text-slate-500">one profile per developer; each CLI logs in once</span>
      </div>
      <div className="p-4 space-y-3">
        {error && <p className="text-[11px] text-red-400">{error}</p>}
        {!profiles ? (
          <p className="text-[10px] text-slate-600 animate-pulse">Loading…</p>
        ) : profiles.length === 0 ? (
          <p className="text-[11px] text-slate-600">No profiles configured (profiles: in config.yaml).</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]" data-testid="profiles-table">
              <thead className="text-[9px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="text-left px-2 py-1.5">Profile</th>
                  {Object.keys(profiles[0].runtimes).map((rt) => <th key={rt} className="text-left px-2 py-1.5">{RUNTIME_LABEL[rt] ?? rt}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {profiles.map((p) => (
                  <tr key={p.name} className="align-top" data-testid={`profile-${p.name}`}>
                    <td className="px-2 py-2">
                      <span className="font-mono text-slate-200">{p.name}</span>
                      {p.mine && <span className="ml-1.5 text-[9px] text-cyan-300">you</span>}
                      {p.public && <span className="ml-1.5 text-[9px] text-violet-300">pool</span>}
                      {p.shared && <span className="ml-1.5 text-[9px] text-amber-300">shared</span>}
                    </td>
                    {Object.entries(p.runtimes).map(([rt, st]) => (
                      <td key={rt} className="px-2 py-2">
                        {st.logged_in ? (
                          <div>
                            <span className="text-emerald-300">logged in</span>
                            {st.subscription && <div className="text-[10px] text-slate-400">{planLabel(st.subscription)}</div>}
                            <div className="text-[9px] text-slate-600">{st.agents} agent{st.agents === 1 ? '' : 's'}</div>
                          </div>
                        ) : (
                          <div className="space-y-1">
                            <span className="text-slate-500">not logged in</span>
                            {st.login_seat ? (
                              <button onClick={() => attach(p.name, rt, st.login_seat!.agent_id)} className="block text-[10px] text-amber-300 underline underline-offset-2">login in progress — show</button>
                            ) : p.can_login ? (
                              <button
                                onClick={() => void login(p.name, rt)}
                                disabled={opening !== null}
                                className="block px-2 py-0.5 rounded border border-cyan-500/40 text-[10px] font-semibold tracking-wider text-cyan-200 hover:bg-cyan-500/10 disabled:opacity-40"
                              >
                                {opening === `${p.name}:${rt}` ? '...' : 'LOG IN'}
                              </button>
                            ) : null}
                          </div>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {seat && (
          <div className="rounded border border-cyan-500/30 bg-slate-950/70 p-3 space-y-2" data-testid="login-wizard">
            <div className="flex items-center justify-between text-[10px]">
              <span className="font-semibold tracking-wider text-cyan-300">LOGGING IN · {seat.profile} · {RUNTIME_LABEL[seat.runtime] ?? seat.runtime}</span>
              <button onClick={() => { stopPolling(); setSeat(null); }} className="text-slate-500 hover:text-slate-300">close</button>
            </div>
            {done ? (
              <p className={`text-[11px] ${done.logged_in ? 'text-emerald-300' : 'text-amber-300'}`}>
                {done.logged_in ? 'Logged in. Agents on this profile can start now.' : `The login ended (${done.reason}) without a credential. Press LOG IN again.`}
              </p>
            ) : (
              <>
                <p className="text-[11px] text-slate-400">Follow the link or type the device code below in your browser, signed in to the subscription this profile should use. The pane updates every few seconds; the window closes itself when the CLI is logged in (15 minutes at most).</p>
                <pre className="max-h-64 overflow-auto rounded bg-black/60 p-2 text-[10px] leading-snug text-slate-200 whitespace-pre-wrap">{pane || 'waiting for the CLI…'}</pre>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
