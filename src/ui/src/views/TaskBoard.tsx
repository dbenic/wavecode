import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost } from '../hooks/useApi';
import { useSSE, type SSEEvent } from '../hooks/useSSE';
import type { Agent, Task, TaskStatus } from '../types';
import { isTaskEventType } from '../sse-events';
import TaskCard from '../components/TaskCard';

interface Column {
  key: TaskStatus;
  label: string;
  accentColor: string;
  headerBorder: string;
}

const COLUMNS: Column[] = [
  { key: 'pending', label: 'Pending', accentColor: 'bg-slate-500', headerBorder: 'border-slate-600/40' },
  { key: 'running', label: 'Running', accentColor: 'bg-emerald-500', headerBorder: 'border-emerald-500/30' },
  { key: 'done', label: 'Done', accentColor: 'bg-cyan-500', headerBorder: 'border-cyan-500/30' },
  { key: 'failed', label: 'Failed', accentColor: 'bg-red-500', headerBorder: 'border-red-500/30' },
];

interface GoalTask {
  title: string;
  prompt: string;
  agent_hint?: string;
  depends_on_indices?: number[];
  priority?: number;
}

interface AgentMessage {
  id: string;
  from_agent_id: string | null;
  to_agent_id: string | null;
  workspace: string | null;
  message: string;
  message_type: string;
  ref_task_id: string | null;
  created_at: string;
}

export default function TaskBoard() {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Mode: 'goal' | 'manual' | null
  const [mode, setMode] = useState<'goal' | 'manual' | null>(null);

  // Goal state
  const [goalText, setGoalText] = useState('');
  const [goalPlan, setGoalPlan] = useState<GoalTask[] | null>(null);
  const [goalLoading, setGoalLoading] = useState(false);
  const [goalError, setGoalError] = useState<string | null>(null);
  const [goalCreating, setGoalCreating] = useState(false);

  // Manual form state
  const [formPrompt, setFormPrompt] = useState('');
  const [formAgentId, setFormAgentId] = useState('');
  const [formPriority, setFormPriority] = useState(0);
  const [formDeps, setFormDeps] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [briefingPreview, setBriefingPreview] = useState<string | null>(null);
  const [showBriefing, setShowBriefing] = useState(false);
  const [loadingBriefing, setLoadingBriefing] = useState(false);

  // Messages panel
  const [showMessages, setShowMessages] = useState(false);

  useEffect(() => {
    let active = true;

    const loadBoard = async () => {
      const [taskResult, agentResult, messageResult] = await Promise.allSettled([
        apiGet<Task[]>('/tasks'),
        apiGet<Agent[]>('/agents'),
        apiGet<AgentMessage[]>('/messages?limit=30'),
      ]);

      if (!active) return;

      if (taskResult.status === 'fulfilled') {
        setTasks(taskResult.value);
        setLoadError(null);
      } else {
        setLoadError((taskResult.reason as Error)?.message || 'Failed to load tasks');
      }

      setAgents(agentResult.status === 'fulfilled' ? agentResult.value : []);
      setMessages(messageResult.status === 'fulfilled' ? messageResult.value : []);
      setLoaded(true);
    };

    void loadBoard();

    return () => {
      active = false;
    };
  }, []);

  // SSE live updates
  const refreshTasks = useCallback(() => {
    apiGet<Task[]>('/tasks').then((nextTasks) => {
      setTasks(nextTasks);
      setLoadError(null);
    }).catch((e) => {
      setLoadError((e as Error).message || 'Failed to refresh tasks');
    });
  }, []);

  const handleSSE = useCallback((event: SSEEvent) => {
    if (isTaskEventType(event.type) || event.type === 'goal.created') {
      refreshTasks();
    }
    if (event.type === 'message.created') {
      apiGet<AgentMessage[]>('/messages?limit=30').then(setMessages).catch(() => {});
    }
  }, [refreshTasks]);

  useSSE(handleSSE);

  const agentMap = new Map(agents.map((a) => [a.id, a]));

  // ─── Goal handlers ────────────────────────────────────────────────
  const handlePreviewGoal = async () => {
    if (!goalText.trim() || goalLoading) return;
    setGoalLoading(true);
    setGoalError(null);
    setGoalPlan(null);
    try {
      const res = await apiPost<{ tasks: GoalTask[] }>('/goals/preview', { goal: goalText });
      setGoalPlan(res.tasks);
    } catch (e) {
      setGoalError((e as Error).message || 'Failed to decompose goal');
    } finally {
      setGoalLoading(false);
    }
  };

  const handleExecuteGoal = async () => {
    if (!goalText.trim() || goalCreating) return;
    setGoalCreating(true);
    setGoalError(null);
    try {
      await apiPost('/goals', { goal: goalText });
      const updated = await apiGet<Task[]>('/tasks');
      setTasks(updated);
      setGoalText('');
      setGoalPlan(null);
      setMode(null);
    } catch (e) {
      setGoalError((e as Error).message || 'Failed to create tasks');
    } finally {
      setGoalCreating(false);
    }
  };

  // ─── Manual task handler ──────────────────────────────────────────
  const handleCreateTask = async () => {
    if (!formPrompt.trim() || submitting) return;
    setFormError(null);
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        prompt: formPrompt,
        priority: formPriority,
      };
      if (formAgentId) body.agent_id = formAgentId;
      if (formDeps.trim()) {
        body.depends_on = formDeps.split(',').map((s) => s.trim()).filter(Boolean);
      }
      await apiPost('/tasks', body);
      const updated = await apiGet<Task[]>('/tasks');
      setTasks(updated);
      setFormPrompt('');
      setFormAgentId('');
      setFormPriority(0);
      setFormDeps('');
      setMode(null);
    } catch (e) {
      setFormError((e as Error).message || 'Failed to create task');
    } finally {
      setSubmitting(false);
    }
  };

  const getColumnTasks = (status: TaskStatus): Task[] => {
    if (status === 'pending') {
      return tasks.filter((t) => t.status === 'pending' || t.status === 'blocked');
    }
    return tasks.filter((t) => t.status === status);
  };

  const timeAgo = (iso: string) => {
    const ms = Date.now() - new Date(iso + 'Z').getTime();
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'now';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  };

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col relative">
      {/* Scan-line overlay */}
      <div
        className="pointer-events-none fixed inset-0 z-50 opacity-[0.015]"
        style={{
          backgroundImage:
            'repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(255,255,255,0.03) 3px, rgba(255,255,255,0.03) 6px)',
        }}
      />

      {/* Header */}
      <header className="sticky top-0 sm:top-10 z-40 border-b border-slate-800/60 bg-slate-950/90 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/')}
              className="text-slate-500 hover:text-slate-300 transition-colors text-sm"
            >
              &larr;
            </button>
            <div>
              <h1 className="text-sm font-bold tracking-[0.15em] text-slate-100 uppercase">
                Task Board
              </h1>
              <p className="text-[9px] text-slate-600 tracking-[0.3em] uppercase">
                {tasks.length} task{tasks.length !== 1 ? 's' : ''} &middot; DAG Pipeline
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Messages toggle */}
            <button
              onClick={() => setShowMessages(!showMessages)}
              className={`relative px-2 py-1.5 rounded border text-[11px] font-semibold tracking-wider uppercase transition-all duration-200 active:scale-95 ${
                showMessages
                  ? 'border-violet-500/40 text-violet-300 bg-violet-950'
                  : 'border-slate-700/50 text-slate-400 hover:text-slate-200 hover:border-slate-600'
              }`}
            >
              Msgs
              {messages.length > 0 && (
                <span className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-violet-500 text-[8px] text-white flex items-center justify-center font-bold">
                  {messages.length > 9 ? '9+' : messages.length}
                </span>
              )}
            </button>

            {/* Goal button */}
            <button
              onClick={() => setMode(mode === 'goal' ? null : 'goal')}
              className={`px-3 py-1.5 rounded border text-[11px] font-bold tracking-wider uppercase transition-all duration-200 active:scale-95 ${
                mode === 'goal'
                  ? 'border-amber-500/40 text-amber-300 bg-amber-950 shadow-[0_0_8px_rgba(245,158,11,0.1)]'
                  : 'border-amber-500/30 text-amber-400 hover:bg-amber-950 hover:border-amber-400'
              }`}
            >
              {mode === 'goal' ? 'Cancel' : '+ Goal'}
            </button>

            {/* Manual button */}
            <button
              onClick={() => {
                setFormError(null);
                setMode(mode === 'manual' ? null : 'manual');
              }}
              className={`px-3 py-1.5 rounded border text-[11px] font-semibold tracking-wider uppercase transition-all duration-200 active:scale-95 ${
                mode === 'manual'
                  ? 'border-slate-600 text-slate-300'
                  : 'border-slate-700/50 text-slate-400 hover:text-slate-200 hover:border-slate-600'
              }`}
            >
              {mode === 'manual' ? 'Cancel' : '+ Manual'}
            </button>
          </div>
        </div>
      </header>

      {/* ─── Goal Input Panel ────────────────────────────────────────── */}
      {mode === 'goal' && (
        <div className="border-b border-amber-500/20 bg-gradient-to-b from-amber-950/20 to-slate-950/0">
          <div className="max-w-7xl mx-auto px-4 py-4 space-y-3">
            <div className="flex items-start gap-2">
              <div className="mt-1 w-5 h-5 rounded bg-amber-500/10 border border-amber-500/30 flex items-center justify-center flex-shrink-0">
                <span className="text-amber-400 text-[10px]">AI</span>
              </div>
              <div className="flex-1">
                <p className="text-[10px] font-bold tracking-[0.2em] text-amber-400/70 uppercase mb-1.5">
                  Describe your goal
                </p>
                <p className="text-[10px] text-slate-600 mb-2">
                  The AI orchestrator will decompose this into sub-tasks, assign agents, and set up dependencies automatically.
                </p>
              </div>
            </div>

            <textarea
              value={goalText}
              onChange={(e) => setGoalText(e.target.value)}
              placeholder="e.g., Add user authentication with JWT tokens, email/password signup, login, password reset, and role-based access control"
              rows={3}
              className="w-full px-3 py-2 rounded border border-amber-500/20 bg-slate-950/50 text-sm text-slate-200 placeholder:text-slate-700 resize-none focus:outline-none focus:border-amber-500/40 focus:ring-1 focus:ring-amber-500/20"
            />

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button
                  onClick={handlePreviewGoal}
                  disabled={!goalText.trim() || goalLoading}
                  className={`px-3 py-1.5 rounded border text-[11px] font-semibold tracking-wider uppercase transition-all ${
                    !goalText.trim() || goalLoading
                      ? 'border-slate-800 text-slate-700 cursor-not-allowed'
                      : 'border-amber-500/30 text-amber-400 hover:bg-amber-500/10 active:scale-95'
                  }`}
                >
                  {goalLoading ? 'Analyzing...' : 'Preview Plan'}
                </button>

                {goalPlan && (
                  <button
                    onClick={handleExecuteGoal}
                    disabled={goalCreating}
                    className="px-4 py-1.5 rounded border border-emerald-500/40 text-[11px] font-bold tracking-wider uppercase text-emerald-300 hover:bg-emerald-500/10 active:scale-95 transition-all shadow-[0_0_8px_rgba(16,185,129,0.1)]"
                  >
                    {goalCreating ? 'Creating...' : `Create ${goalPlan.length} Tasks`}
                  </button>
                )}
              </div>

              {goalPlan && (
                <span className="text-[10px] text-amber-400/50">
                  {goalPlan.length} tasks &middot; {goalPlan.filter(t => t.depends_on_indices?.length).length} with deps
                </span>
              )}
            </div>

            {goalError && (
              <div className="p-2 rounded border border-red-500/30 bg-red-950/20 text-[11px] text-red-400">
                {goalError}
              </div>
            )}

            {/* Goal Plan Preview */}
            {goalPlan && (
              <div className="space-y-2 mt-1">
                <p className="text-[10px] font-bold tracking-[0.2em] text-amber-400/60 uppercase">
                  Decomposed Plan
                </p>
                {goalPlan.map((task, i) => (
                  <div
                    key={i}
                    className="rounded border border-amber-500/15 bg-slate-900/40 p-2.5 space-y-1"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="w-5 h-5 rounded bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-[9px] font-bold text-amber-400/60">
                          {i + 1}
                        </span>
                        <span className="text-[11px] font-semibold text-slate-200">
                          {task.title}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {task.agent_hint && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700/50">
                            {task.agent_hint}
                          </span>
                        )}
                        {task.priority !== undefined && task.priority > 0 && (
                          <span className="text-[9px] font-bold text-amber-500">
                            P{task.priority}
                          </span>
                        )}
                      </div>
                    </div>
                    <p className="text-[10px] text-slate-400 leading-relaxed line-clamp-2 pl-7">
                      {task.prompt}
                    </p>
                    {task.depends_on_indices && task.depends_on_indices.length > 0 && (
                      <div className="pl-7 flex items-center gap-1">
                        <span className="text-[9px] text-slate-600">depends on:</span>
                        {task.depends_on_indices.map((dep) => (
                          <span
                            key={dep}
                            className="text-[9px] px-1 rounded bg-slate-800/80 text-amber-400/60 border border-amber-500/10"
                          >
                            #{dep + 1}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── Manual Task Form ────────────────────────────────────────── */}
      {mode === 'manual' && (
        <div className="border-b border-slate-800/40 bg-slate-900/40">
          <div className="max-w-7xl mx-auto px-4 py-4 space-y-3">
            <textarea
              value={formPrompt}
              onChange={(e) => setFormPrompt(e.target.value)}
              placeholder="Task prompt — what should the agent do?"
              rows={2}
              className="w-full px-3 py-2 rounded border border-slate-800/60 bg-slate-950/50 text-sm text-slate-200 font-mono placeholder:text-slate-700 resize-none focus:outline-none focus:border-emerald-500/40 focus:ring-1 focus:ring-emerald-500/20"
            />
            <div className="flex flex-wrap gap-3">
              <div className="flex items-center gap-2">
                <label className="text-[10px] text-slate-600 tracking-wider uppercase">Agent</label>
                <select
                  value={formAgentId}
                  onChange={(e) => setFormAgentId(e.target.value)}
                  className="px-2 py-1 rounded border border-slate-800/60 bg-slate-950/50 text-xs text-slate-300 font-mono focus:outline-none focus:border-emerald-500/40"
                >
                  <option value="">Auto (any idle)</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-2">
                <label className="text-[10px] text-slate-600 tracking-wider uppercase">Priority</label>
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={formPriority}
                  onChange={(e) => setFormPriority(parseInt(e.target.value, 10) || 0)}
                  className="w-16 px-2 py-1 rounded border border-slate-800/60 bg-slate-950/50 text-xs text-slate-300 font-mono text-center focus:outline-none focus:border-emerald-500/40"
                />
              </div>

              <div className="flex items-center gap-2">
                <label className="text-[10px] text-slate-600 tracking-wider uppercase">Deps</label>
                <input
                  type="text"
                  value={formDeps}
                  onChange={(e) => setFormDeps(e.target.value)}
                  placeholder="task-id-1, task-id-2"
                  className="w-48 px-2 py-1 rounded border border-slate-800/60 bg-slate-950/50 text-xs text-slate-300 font-mono placeholder:text-slate-700 focus:outline-none focus:border-emerald-500/40"
                />
              </div>

              {formAgentId && (
                <button
                  onClick={async () => {
                    if (showBriefing) { setShowBriefing(false); return; }
                    setLoadingBriefing(true);
                    try {
                      const res = await apiGet<{ briefing: string | null }>(
                        `/briefing/preview?agent_id=${formAgentId}&prompt=${encodeURIComponent(formPrompt || '(task)')}`
                      );
                      setBriefingPreview(res.briefing);
                      setShowBriefing(true);
                    } catch { setBriefingPreview(null); }
                    finally { setLoadingBriefing(false); }
                  }}
                  className="px-2 py-1 rounded border border-amber-500/30 text-[10px] font-semibold tracking-wider uppercase text-amber-400/70 hover:text-amber-300 hover:bg-amber-500/10 transition-all"
                >
                  {loadingBriefing ? '...' : showBriefing ? 'Hide Briefing' : 'Preview Briefing'}
                </button>
              )}

              <button
                onClick={handleCreateTask}
                disabled={!formPrompt.trim() || submitting}
                className={`px-4 py-1 rounded border text-[11px] font-semibold tracking-wider uppercase ml-auto transition-all duration-200 ${
                  !formPrompt.trim() || submitting
                    ? 'border-slate-800 text-slate-700 cursor-not-allowed'
                    : 'border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 active:scale-95'
                }`}
              >
                {submitting ? 'Creating...' : 'Create'}
              </button>
            </div>

            {showBriefing && (
              <div className="mt-2 p-3 rounded border border-amber-500/20 bg-amber-950/20">
                <p className="text-[10px] font-bold tracking-wider text-amber-400/60 uppercase mb-1.5">
                  Context Briefing Preview
                </p>
                {briefingPreview ? (
                  <pre className="text-[11px] font-mono text-amber-200/70 whitespace-pre-wrap max-h-40 overflow-y-auto">
                    {briefingPreview}
                  </pre>
                ) : (
                  <p className="text-[10px] text-amber-500/40 italic">
                    No briefing — agent has no sibling agents, recent changes, or decisions.
                  </p>
                )}
              </div>
            )}

            {formError && (
              <div className="rounded border border-red-500/30 bg-red-950/20 px-3 py-2 text-[11px] text-red-300">
                {formError}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── Agent Messages Panel ────────────────────────────────────── */}
      {showMessages && messages.length > 0 && (
        <div className="border-b border-violet-500/20 bg-gradient-to-b from-violet-950/15 to-transparent">
          <div className="max-w-7xl mx-auto px-4 py-3">
            <p className="text-[10px] font-bold tracking-[0.2em] text-violet-400/60 uppercase mb-2">
              Agent Messages
            </p>
            <div className="space-y-1.5 max-h-40 overflow-y-auto">
              {messages.map((msg) => {
                const fromAgent = msg.from_agent_id ? agentMap.get(msg.from_agent_id) : null;
                const toAgent = msg.to_agent_id ? agentMap.get(msg.to_agent_id) : null;
                const typeColors: Record<string, string> = {
                  result: 'text-emerald-400 border-emerald-500/20',
                  error: 'text-red-400 border-red-500/20',
                  request: 'text-amber-400 border-amber-500/20',
                  handoff: 'text-cyan-400 border-cyan-500/20',
                  info: 'text-slate-400 border-slate-700/30',
                };
                const color = typeColors[msg.message_type] ?? typeColors.info;

                return (
                  <div
                    key={msg.id}
                    className={`flex items-start gap-2 px-2 py-1.5 rounded border bg-slate-900/30 ${color}`}
                  >
                    <div className="flex-shrink-0 flex items-center gap-1 min-w-[80px]">
                      <span className="text-[9px] font-semibold truncate max-w-[60px]">
                        {fromAgent?.name ?? 'system'}
                      </span>
                      <span className="text-[9px] text-slate-700">&rarr;</span>
                      <span className="text-[9px] truncate max-w-[60px] text-slate-500">
                        {toAgent?.name ?? 'all'}
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-300 line-clamp-1 flex-1 min-w-0">
                      {msg.message}
                    </p>
                    <span className="text-[9px] text-slate-700 flex-shrink-0">
                      {timeAgo(msg.created_at)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ─── Kanban columns ──────────────────────────────────────────── */}
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-4">
        {loadError && (
          <div className="mb-4 rounded border border-red-500/30 bg-red-950/20 px-3 py-2 text-[11px] text-red-300">
            {loadError}
          </div>
        )}

        {!loaded ? (
          <div className="flex items-center justify-center py-20">
            <div className="text-[10px] text-slate-600 tracking-[0.3em] uppercase animate-pulse">
              Loading tasks...
            </div>
          </div>
        ) : tasks.length === 0 && !mode ? (
          /* Empty state */
          <div className="flex flex-col items-center justify-center py-20 space-y-4">
            <div className="w-12 h-12 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
              <span className="text-amber-400 text-lg">AI</span>
            </div>
            <div className="text-center space-y-1">
              <p className="text-sm text-slate-300 font-semibold">No tasks yet</p>
              <p className="text-[11px] text-slate-600 max-w-sm">
                Describe a goal and the AI orchestrator will decompose it into tasks, assign agents, and manage the pipeline automatically.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setMode('goal')}
                className="px-4 py-2 rounded border border-amber-500/30 text-[11px] font-bold tracking-wider uppercase text-amber-400 hover:bg-amber-950 transition-all active:scale-95"
              >
                + New Goal
              </button>
              <button
                onClick={() => {
                  setFormError(null);
                  setMode('manual');
                }}
                className="px-4 py-2 rounded border border-slate-700/50 text-[11px] font-semibold tracking-wider uppercase text-slate-300 hover:border-slate-600 hover:bg-slate-900 transition-all active:scale-95"
              >
                + Manual Task
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-3 overflow-x-auto pb-4 snap-x snap-mandatory sm:snap-none min-h-[calc(100vh-180px)]">
            {COLUMNS.map((col) => {
              const colTasks = getColumnTasks(col.key);
              return (
                <div
                  key={col.key}
                  className="flex-shrink-0 w-[280px] sm:flex-1 sm:min-w-[200px] snap-start flex flex-col"
                >
                  <div className={`rounded-t border-t-2 ${col.headerBorder} border-x border-b border-slate-800/30 bg-slate-900/30 px-3 py-2 flex items-center justify-between`}>
                    <div className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full ${col.accentColor}`} />
                      <span className="text-[10px] font-bold tracking-[0.2em] text-slate-400 uppercase">
                        {col.label}
                      </span>
                    </div>
                    <span className="text-[10px] text-slate-600 font-mono">
                      {colTasks.length}
                    </span>
                  </div>

                  <div className="flex-1 border-x border-b border-slate-800/20 rounded-b bg-slate-950/30 p-2 space-y-2 overflow-y-auto">
                    {colTasks.length === 0 ? (
                      <div className="flex items-center justify-center py-8">
                        <span className="text-[10px] text-slate-800 tracking-wider">
                          EMPTY
                        </span>
                      </div>
                    ) : (
                      colTasks.map((task, i) => (
                        <TaskCard
                          key={task.id}
                          task={task}
                          agentName={task.agent_id ? agentMap.get(task.agent_id)?.name : undefined}
                          index={i}
                          onRefresh={refreshTasks}
                        />
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      <style>{`
        @keyframes taskIn {
          from {
            opacity: 0;
            transform: translateY(8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>
  );
}
