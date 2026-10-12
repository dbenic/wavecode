import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from '../hooks/useApi';
import { useSSE, type SSEEvent } from '../hooks/useSSE';
import type { LoginHint, ProfileInfo } from '../types';

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
  const [hint, setHint] = useState<LoginHint | null>(null);
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [done, setDone] = useState<{ logged_in: boolean; reason: string } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(() => {
    apiGet<ProfileInfo[]>('/profiles').then(setProfiles).catch((e) => setError((e as Error).message || 'profiles unavailable'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const stopPolling = () => { if (timer.current) { clearInterval(timer.current); timer.current = null; } };

  const pollPane = useCallback((profile: string, runtime: string) => {
    stopPolling();
    const tick = () => {
      apiGet<LoginHint>(`/profiles/${encodeURIComponent(profile)}/login/${encodeURIComponent(runtime)}`)
        .then(setHint)
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
    setHint(null);
    setCode('');
    setOpening(`${profile}:${runtime}`);
    try {
      const r = await apiPost<{ agent: { id: string }; session: string; expires_at: string }>(`/profiles/${encodeURIComponent(profile)}/login`, { runtime });
      setSeat({ profile, runtime, agentId: r.agent.id, expires_at: r.expires_at });
      pollPane(profile, runtime);
      load();
    } catch (e) {
      setError((e as Error).message || 'could not open the login');
    } finally {
      setOpening(null);
    }
  };

  const attach = (profile: string, runtime: string, agentId: string) => {
    setDone(null);
    setHint(null);
    setSeat({ profile, runtime, agentId, expires_at: null });
    pollPane(profile, runtime);
  };

  const sendCode = async () => {
    if (!seat || !code.trim()) return;
    setSending(true);
    setError(null);
    try {
      await apiPost(`/profiles/${encodeURIComponent(seat.profile)}/login/${encodeURIComponent(seat.runtime)}/code`, { code: code.trim() });
      setCode('');
    } catch (e) {
      setError((e as Error).message || 'code not accepted');
    } finally {
      setSending(false);
    }
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
                {!hint?.open ? (
                  <p className="text-[11px] text-slate-500 animate-pulse">waiting for the CLI…</p>
                ) : (
                  <div className="space-y-2">
                    <ol className="list-decimal list-inside space-y-1.5 text-[11px] text-slate-300">
                      <li>
                        {hint.url ? (
                          <>
                            <a href={hint.url} target="_blank" rel="noopener" className="inline-block px-2.5 py-1 rounded border border-cyan-400/60 bg-cyan-500/10 text-cyan-100 font-semibold tracking-wider text-[10px]">OPEN SIGN-IN LINK</a>
                            <button onClick={() => { void navigator.clipboard?.writeText(hint.url!); }} className="ml-2 text-[10px] text-slate-400 underline underline-offset-2">copy link</button>
                            <span className="ml-2 text-slate-500">sign in with the account this profile should use</span>
                          </>
                        ) : <span className="text-slate-500">the CLI has not printed a link yet</span>}
                      </li>
                      {hint.code && (
                        <li>Enter this code on that page: <span className="font-mono text-base text-emerald-300 tracking-widest select-all">{hint.code}</span></li>
                      )}
                      {hint.awaiting_code && (
                        <li>
                          Paste the code the browser shows here:
                          <span className="ml-2 inline-flex items-center gap-1.5">
                            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="code from the browser" className="px-2 py-1 rounded border border-slate-700 bg-slate-950/60 text-[11px] text-slate-200 font-mono w-56" aria-label="Login code" />
                            <button onClick={() => void sendCode()} disabled={sending || !code.trim()} className="px-2 py-1 rounded border border-emerald-500/40 text-[10px] font-semibold tracking-wider text-emerald-200 hover:bg-emerald-500/10 disabled:opacity-40">{sending ? '...' : 'SEND'}</button>
                          </span>
                        </li>
                      )}
                    </ol>
                    <p className="text-[10px] text-slate-500">The window closes itself once the CLI is logged in (15 minutes at most). <button onClick={() => setShowRaw((v) => !v)} className="underline underline-offset-2">{showRaw ? 'hide' : 'show'} the CLI output</button></p>
                    {showRaw && <pre className="max-h-48 overflow-auto rounded bg-black/60 p-2 text-[10px] leading-snug text-slate-300 whitespace-pre-wrap">{hint.tail.join('\n')}</pre>}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
