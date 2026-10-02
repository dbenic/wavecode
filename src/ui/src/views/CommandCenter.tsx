/**
 * Command Center (multi-orchestrator spec §4.2–4.3): one typed feed, one
 * composer. Roster · Thread · Board on desktop; three tabs over the same
 * state on mobile. Data arrives from REST on load and is kept live by SSE —
 * every event pulls `/api/thread?since=<cursor>` (no polling). All
 * permission decisions come from the server (`actions`, `can_act`,
 * `profile_compatible`); this view only renders them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPatch, apiPost, apiPut, apiUpload } from '../hooks/useApi';
import { useSSE, type SSEEvent } from '../hooks/useSSE';
import Board from '../components/command-center/Board';
import BoardRail from '../components/command-center/BoardRail';
import RosterAvatars from '../components/command-center/RosterAvatars';
import Composer, { type ComposerSend } from '../components/command-center/Composer';
import PresenceStrip from '../components/command-center/PresenceStrip';
import Roster from '../components/command-center/Roster';
import ThreadFeed from '../components/command-center/ThreadFeed';
import type { Agent, Task, ThreadAction, ThreadItem, ThreadPage, User } from '../types';
import { handleOf, STATUS_PROMPT, type Plan } from '../utils/composer-grammar';
import {
  actionPlaceholders,
  apiRelativePath,
  fillAction,
  boardDefaultCollapsed,
  invalidatesThreadActions,
  openTaskCount,
  mergeThreadItems,
  orderThread,
  type ComposerMode,
  type SlashCommand, itemsForAgent } from '../utils/command-center';

type Tab = 'roster' | 'thread' | 'board';

const THREAD_PAGE = 200;
// Keep the in-memory feed bounded on long sessions.
const MAX_ITEMS = 1000;

export default function CommandCenter() {
  const [me, setMe] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [reviewCount, setReviewCount] = useState(0);
  const [items, setItems] = useState<ThreadItem[]>([]);
  const [focused, setFocused] = useState<string | null>(null);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [tab, setTab] = useState<Tab>('thread');
  const [target, setTarget] = useState('');
  const [mode, setMode] = useState<ComposerMode>('ask');
  const [replyTaskId, setReplyTaskId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, string>>({});
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalOutput, setTerminalOutput] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** null = follow the default rule (spec §4.4) until the viewer toggles; session-only React state. */
  const [boardCollapsedChoice, setBoardCollapsedChoice] = useState<boolean | null>(null);

  const [meError, setMeError] = useState(false);

  /** Until the user picks a target, the composer follows the orchestrator seat (spec §5b). */
  const targetTouchedRef = useRef(false);
  const cursorRef = useRef<number | null>(null);
  const threadBusyRef = useRef(false);
  const threadPendingRef = useRef(false);
  const threadPendingFullRef = useRef(false);

  // --- loaders ---------------------------------------------------------------

  const loadAgents = useCallback(() => apiGet<Agent[]>('/agents').then(setAgents).catch(() => {}), []);
  const loadTasks = useCallback(() => apiGet<Task[]>('/tasks').then(setTasks).catch(() => {}), []);
  const loadUsers = useCallback(() => apiGet<User[]>('/users').then(setUsers).catch(() => {}), []);
  const loadReviews = useCallback(
    () => apiGet<unknown[]>('/reviews').then((r) => setReviewCount(Array.isArray(r) ? r.length : 0)).catch(() => {}),
    [],
  );

  /**
   * Pull new feed items after the cursor. `full` re-reads the newest page
   * (first load, or after ownership changed) so the server recomputes
   * `actions` for items already on screen; those replace the stale copies.
   * Bursts of events are coalesced into one follow-up fetch.
   */
  const refreshThread = useCallback(async (opts: { full?: boolean } = {}) => {
    if (opts.full) threadPendingFullRef.current = true;
    if (threadBusyRef.current) {
      threadPendingRef.current = true;
      return;
    }
    threadBusyRef.current = true;
    try {
      do {
        threadPendingRef.current = false;
        const full = threadPendingFullRef.current || cursorRef.current === null;
        threadPendingFullRef.current = false;
        const page = await apiGet<ThreadPage>(
          full ? `/thread?limit=${THREAD_PAGE}` : `/thread?since=${cursorRef.current}&limit=${THREAD_PAGE}`,
        );
        cursorRef.current = Math.max(cursorRef.current ?? 0, page.cursor);
        setItems((prev) => mergeThreadItems(prev, page.items, MAX_ITEMS));
      } while (threadPendingRef.current);
    } catch {
      // ErrorBanner already shows API failures
    } finally {
      threadBusyRef.current = false;
    }
  }, []);

  const loadTerminal = useCallback(async (agentId: string) => {
    try {
      const res = await apiGet<{ output: string }>(`/agents/${agentId}/output?lines=40`);
      setTerminalOutput(res.output);
    } catch {
      setTerminalOutput(null);
    }
  }, []);

  useEffect(() => {
    apiGet<User>('/me').then(setMe).catch(() => setMeError(true));
    void loadUsers();
    void loadAgents();
    void loadTasks();
    void loadReviews();
    void refreshThread();
  }, [loadUsers, loadAgents, loadTasks, loadReviews, refreshThread]);

  // Lease countdowns are a display clock, not data polling.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    setTerminalOutput(null);
    if (terminalOpen && focused) void loadTerminal(focused);
  }, [terminalOpen, focused, loadTerminal]);

  // --- live updates -----------------------------------------------------------

  useSSE((event: SSEEvent) => {
    if (event.type === 'heartbeat') return;
    void refreshThread({ full: invalidatesThreadActions(event.type) });
    if (event.type.startsWith('agent.') || event.type === 'system.stop_all' || event.type === 'profile.login_started') {
      if (event.type !== 'agent.output_updated') void loadAgents();
    }
    if (event.type.startsWith('task.')) void loadTasks();
    if (event.type.startsWith('review.') || event.type.startsWith('run.')) void loadReviews();
    if (event.type.startsWith('user.')) void loadUsers();
    if (
      terminalOpen && focused && event.entityId === focused
      && (event.type === 'agent.output_updated' || event.type === 'agent.prompt_sent' || event.type === 'agent.status_changed')
    ) {
      void loadTerminal(focused);
    }
  });

  // Default target: the orchestrator seat, so you can just type a question.
  const seatId = agents.find((a) => a.orchestrator)?.id ?? null;
  useEffect(() => {
    if (!targetTouchedRef.current && seatId) setTarget(seatId);
  }, [seatId]);

  function chooseTarget(agentId: string) {
    targetTouchedRef.current = true;
    setTarget(agentId);
  }

  // --- derived ------------------------------------------------------------------

  const userMap = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  // Agents are shown by alias when they have one (spec §5c)
  const agentNames = useMemo(() => new Map(agents.map((a) => [a.id, handleOf(a)])), [agents]);
  const personas = useMemo(() => new Map(agents.filter((a) => a.persona).map((a) => [a.id, a.persona!])), [agents]);
  // Replies sit directly under the prompt they answer.
  const visibleItems = useMemo(() => {
    if (!focused) return orderThread(items);
    const focusedHandle = agentNames.get(focused) ?? focused;
    return orderThread(itemsForAgent(items, focused, focusedHandle));
  }, [items, focused, agentNames]);
  // The inbox spans every agent, whatever is focused.
  const attentionCount = useMemo(() => items.filter((i) => i.needs_attention).length, [items]);
  const focusedAgent = agents.find((a) => a.id === focused) ?? null;
  const boardCollapsed = boardCollapsedChoice ?? boardDefaultCollapsed(tasks, me?.id ?? null);
  const canMutate = !!me && me.role !== 'observer';

  function focus(agentId: string | null) {
    setFocused(agentId);
    if (agentId) chooseTarget(agentId);
    setTab('thread');
  }

  function refreshAll() {
    void refreshThread();
    void loadAgents();
    void loadTasks();
  }

  // --- actions --------------------------------------------------------------------

  async function runAction(item: ThreadItem, action: ThreadAction) {
    if (action.id === 'reply') {
      setMode('reply');
      chooseTarget(String(action.body?.to ?? item.agent_id ?? ''));
      setReplyTaskId(typeof action.body?.ref_task_id === 'string' ? action.body.ref_task_id : null);
      setTab('thread');
      return;
    }
    if (action.id === 'send_file') {
      setMode('file');
      chooseTarget(item.agent_id ?? '');
      setTab('thread');
      return;
    }
    if (action.id === 'kill' && !window.confirm(`Kill ${agentNames.get(item.agent_id ?? '') ?? 'this agent'}? Its session is terminated.`)) {
      return;
    }
    try {
      if (action.method === 'GET') {
        const data = await apiGet<Record<string, unknown>>(apiRelativePath(action.path));
        const text = typeof data?.log === 'string' ? data.log : JSON.stringify(data, null, 2);
        setExpanded((e) => ({ ...e, [item.id]: text || '(empty)' }));
        return;
      }

      const values: Record<string, string> = {};
      for (const placeholder of actionPlaceholders(action)) {
        if (placeholder === 'reason') {
          const reason = window.prompt('Override reason (stored in the audit log)')?.trim();
          if (!reason) return;
          values.reason = reason;
        } else if (placeholder === 'agent_id') {
          const name = window.prompt('Target agent name')?.trim();
          const agent = agents.find((a) => a.name === name || a.id === name);
          if (!agent) return;
          values.agent_id = agent.id;
        } else {
          return; // a placeholder this UI does not know how to fill
        }
      }
      const filled = fillAction(action, values);
      const path = apiRelativePath(filled.path);
      if (filled.method === 'PUT') await apiPut(path, filled.body);
      else await apiPost(path, filled.body);
      refreshAll();
    } catch {
      // ErrorBanner shows the server's message
    }
  }

  function latestRunFor(agentId: string): string | null {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.agent_id === agentId && it.refs.run_id) return it.refs.run_id;
    }
    return null;
  }

  async function runSlash(agentId: string, command: SlashCommand): Promise<void> {
    switch (command.cmd) {
      case 'reserve': await apiPost(`/agents/${agentId}/reserve`, { hours: command.hours }); return;
      case 'release': await apiPost(`/agents/${agentId}/release`); return;
      case 'kill':
        if (!window.confirm(`Kill ${agentNames.get(agentId) ?? 'this agent'}? Its session is terminated.`)) {
          throw new Error('Kill cancelled');
        }
        await apiPost(`/agents/${agentId}/kill`);
        return;
      default: {
        const runId = latestRunFor(agentId);
        if (!runId) throw new Error(`No run for ${agentNames.get(agentId) ?? 'this agent'} in the thread yet`);
        if (command.cmd === 'review') await apiPost(`/reviews/${runId}/ai-review`, { type: 'cross-model' });
        else if (command.cmd === 'promote') await apiPost(`/reviews/${runId}/promote`);
        else await apiPost(`/reviews/${runId}/retry`);
      }
    }
  }

  async function send(s: ComposerSend): Promise<true | string> {
    try {
      switch (s.kind) {
        case 'prompt':
          await apiPost(`/agents/${s.agentId}/send`, { text: s.text });
          break;
        case 'task':
          if (s.agentId && (s.model || s.effort)) {
            await apiPatch(`/agents/${s.agentId}`, { ...(s.model ? { model: s.model } : {}), ...(s.effort ? { effort: s.effort } : {}) });
          }
          await apiPost('/tasks', { prompt: s.prompt, ...(s.agentId ? { agent_id: s.agentId } : {}) });
          break;
        case 'reply':
          await apiPost('/messages', { to: s.agentId, message: s.text, ...(s.refTaskId ? { ref_task_id: s.refTaskId } : {}) });
          setReplyTaskId(null);
          break;
        case 'file': {
          const form = new FormData();
          form.append('file', s.file);
          const artifact = await apiUpload<{ id: string }>('/artifacts/upload', form);
          await apiPost(`/artifacts/${artifact.id}/share`, { targetAgentId: s.agentId });
          break;
        }
        case 'slash':
          await runSlash(s.agentId, s.command);
          break;
        case 'plan':
          await runPlan(s.plan);
          break;
      }
      refreshAll();
      return true;
    } catch (e) {
      return (e as Error).message || 'Failed to send';
    }
  }

  /**
   * Execute a §5c grammar plan through the existing routes. Each step's
   * server event is what shows in the thread as the user's item.
   */
  async function runPlan(plan: Plan): Promise<void> {
    switch (plan.kind) {
      case 'prompt':
        for (const a of plan.agents) await apiPost(`/agents/${a.id}/send`, { text: plan.text });
        return;
      case 'broadcast':
        await apiPost('/messages', { message: plan.text, message_type: 'info' });
        return;
      case 'message':
        for (const u of plan.users) await apiPost('/messages', { to_user: u.name, message: plan.text });
        return;
      case 'reserve':
        await apiPost(`/agents/${plan.agent.id}/reserve`, { hours: plan.hours });
        return;
      case 'release':
        await apiPost(`/agents/${plan.agent.id}/release`);
        return;
      case 'kill':
        if (!window.confirm(`Kill ${handleOf(plan.agent)}? Its session is terminated.`)) throw new Error('Kill cancelled');
        await apiPost(`/agents/${plan.agent.id}/kill`);
        return;
      case 'tag':
        await apiPost(`/agents/${plan.agent.id}/tags`, { tag: plan.tag });
        return;
      case 'task':
        await apiPost('/tasks', {
          prompt: plan.text,
          ...(plan.agent ? { agent_id: plan.agent.id } : {}),
          ...(plan.deps.length > 0 ? { depends_on: plan.deps.map((t) => t.id) } : {}),
        });
        return;
      case 'promote': {
        const runId = plan.task.latest_run?.id;
        if (!runId) throw new Error(`Task #${plan.task.num} has no run to promote yet`);
        if (!window.confirm(`Promote task #${plan.task.num}? This approves its latest run.`)) throw new Error('Promote cancelled');
        await apiPost(`/reviews/${runId}/promote`);
        return;
      }
      case 'file': {
        const files = await apiGet<Array<{ id: string; filename: string }>>('/artifacts');
        const match = files.find((f) => f.id === plan.name) ?? [...files].reverse().find((f) => f.filename === plan.name);
        if (!match) throw new Error(`No uploaded file named "${plan.name}" — use File mode to upload it first`);
        await apiPost(`/artifacts/${match.id}/share`, { targetAgentId: plan.agent.id });
        return;
      }
      case 'status':
        await apiPost(`/agents/${plan.seat.id}/send`, { text: STATUS_PROMPT });
        return;
      default:
        throw new Error(plan.reason);
    }
  }

  /** Roster "rename": alias + one-line persona (spec §5c). Cancel keeps the current value. */
  async function renameAgent(agent: Agent) {
    const alias = window.prompt(`Alias for ${agent.name} (2–24 chars, a-z 0-9 _ -; empty clears)`, agent.alias ?? '');
    if (alias === null) return;
    const persona = window.prompt(`One-line persona for @${alias.trim() || agent.name} (e.g. "frontend lead"; empty clears)`, agent.persona ?? '');
    if (persona === null) return;
    await quiet(() => apiPatch(`/agents/${agent.id}`, { alias: alias.trim() || null, persona: persona.trim() || null }));
  }

  async function stopAll() {
    if (!window.confirm('Emergency stop: kill spawned agents, interrupt adopted ones, and disable auto-dispatch?')) return;
    try {
      await apiPost('/system/stop-all');
      refreshAll();
    } catch {
      // ErrorBanner
    }
  }

  async function quiet(fn: () => Promise<unknown>) {
    try {
      await fn();
      refreshAll();
    } catch {
      // ErrorBanner
    }
  }

  // --- layout -----------------------------------------------------------------------

  const tabs: { id: Tab; label: string }[] = [
    { id: 'roster', label: 'Roster' },
    { id: 'thread', label: 'Thread' },
    { id: 'board', label: 'Board' },
  ];

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col sm:h-[calc(100dvh-2.5rem)]">
      <div className="flex items-center">
        <div className="min-w-0 flex-1">
          <PresenceStrip users={users} agents={agents} me={me} onStopAll={() => void stopAll()} />
        </div>
        {me?.role === 'admin' && (
          <Link to="/settings/users" className="shrink-0 border-b border-slate-800/60 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500 hover:text-slate-300">
            Users
          </Link>
        )}
      </div>

      <div role="tablist" aria-label="Command Center sections" className="flex border-b border-slate-800/60 sm:hidden">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 py-2 text-[11px] font-semibold uppercase tracking-[0.2em] ${tab === t.id ? 'border-b-2 border-emerald-400 text-emerald-400' : 'text-slate-500'}`}
          >
            {t.label}
            {t.id === 'thread' && attentionCount > 0 && (
              <span data-testid="attention-badge" className="ml-1 rounded-full bg-amber-500 px-1.5 text-[10px] text-slate-950">{attentionCount}</span>
            )}
          </button>
        ))}
      </div>

      {/* Spec §4.4: the Board collapses to a 40px rail and the Roster to avatars at ≤1100px — the thread takes the width. */}
      <div
        data-testid="command-center-grid"
        className={`grid min-h-0 flex-1 ${boardCollapsed
          ? 'sm:grid-cols-[3.5rem_minmax(0,1fr)_40px] min-[900px]:grid-cols-[16rem_minmax(0,1fr)_40px]'
          : 'sm:grid-cols-[3.5rem_minmax(0,1fr)_18rem] min-[900px]:grid-cols-[16rem_minmax(0,1fr)_18rem]'}`}
      >
        <aside className={`${tab === 'roster' ? 'block' : 'hidden'} min-h-0 overflow-y-auto border-slate-800/60 sm:block sm:border-r`}>
          <div className="hidden sm:block min-[900px]:hidden" data-testid="roster-avatars">
            <RosterAvatars agents={agents} users={userMap} focusedAgentId={focused} onFocus={focus} />
          </div>
          <div className="sm:hidden min-[900px]:block" data-testid="roster-full">
          <Roster
            agents={agents}
            tasks={tasks}
            me={me}
            users={userMap}
            focusedAgentId={focused}
            now={now}
            onFocus={focus}
            onReserve={(a) => void quiet(() => apiPost(`/agents/${a.id}/reserve`, {}))}
            onRelease={(a) => void quiet(() => apiPost(`/agents/${a.id}/release`))}
            onAssign={(taskId, a) => void quiet(() => apiPut(`/tasks/${taskId}`, { agent_id: a.id }))}
            onRename={canMutate ? (a) => void renameAgent(a) : undefined}
          />
          </div>
        </aside>

        <main className={`${tab === 'thread' ? 'flex' : 'hidden'} min-h-0 flex-col sm:flex`}>
          <ThreadFeed
            items={visibleItems}
            users={userMap}
            agentNames={agentNames}
            personas={personas}
            attentionOnly={attentionOnly}
            onToggleAttention={() => setAttentionOnly((v) => !v)}
            attentionCount={attentionCount}
            focusLabel={focusedAgent?.name ?? 'all'}
            onAction={(item, action) => void runAction(item, action)}
            expanded={expanded}
            terminal={focusedAgent && focusedAgent.mode !== 'file'
              ? { open: terminalOpen, output: terminalOutput, onToggle: () => setTerminalOpen((v) => !v) }
              : null}
          />
          {meError && (
            <p role="alert" className="border-t border-slate-800/60 px-3 py-2 text-xs text-amber-400">
              Couldn't load your identity (/api/me) — sending is disabled. Reload to retry.
            </p>
          )}
          {canMutate && (
            <Composer
              agents={agents}
              target={target}
              onTargetChange={chooseTarget}
              mode={mode}
              onModeChange={(m) => {
                setMode(m);
                if (m !== 'reply') setReplyTaskId(null);
              }}
              replyTaskId={replyTaskId}
              users={users}
              tasks={tasks}
              onSend={send}
            />
          )}
        </main>

        <aside className={`${tab === 'board' ? 'block' : 'hidden'} min-h-0 overflow-y-auto border-slate-800/60 sm:block sm:border-l`}>
          {/* Phones always get the full board in their Board tab; the rail is a desktop affordance. */}
          <div className={boardCollapsed ? 'sm:hidden' : ''} data-testid="board-full">
            <Board tasks={tasks} users={userMap} reviewCount={reviewCount} canAssign={canMutate} onCollapse={() => setBoardCollapsedChoice(true)} />
          </div>
          {boardCollapsed && (
            <div className="hidden h-full sm:block" data-testid="board-rail">
              <BoardRail
                openTasks={openTaskCount(tasks)}
                pendingReviews={reviewCount}
                attention={attentionCount}
                onExpand={() => setBoardCollapsedChoice(false)}
              />
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
