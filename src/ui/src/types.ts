export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh';

export interface Agent {
  id: string;
  name: string;
  runtime: string;
  tmux_session: string;
  workspace: string | null;
  mode: 'adopted' | 'spawned' | 'file';
  status: 'idle' | 'working' | 'error';
  model: string | null;
  effort: EffortLevel | null;
  created_at: string;
  lastOutputLine?: string;
  outputVersion?: number;
  watching?: boolean;
  // Leases (spec §2/§3)
  owner_id?: string | null;
  owner?: string | null;
  lease_reason?: 'reserved' | 'task' | 'seat' | null;
  lease_expires_at?: string | null;
  lease?: { owner: string | null; owner_id: string; reason: 'reserved' | 'task' | null; expires_at: string | null } | null;
  /** Whether the current user may prompt/assign/kill this agent. */
  can_act?: boolean;
  /** Credential profile (spec §5) and whether it is the current user's subscription. */
  profile?: string | null;
  profile_compatible?: boolean;
  /** Account label and plan of the login the agent runs on (null = unknown). */
  subscription?: { account: string | null; plan: string | null };
  /** Model/effort from the CLI's own settings on that profile, shown when nothing is pinned. */
  runtime_defaults?: { model: string | null; effort: string | null };
  /** Plan usage from the CLI's status screen, probed every ~15 min; null until known. */
  usage?: { summary: string; metrics: Array<{ label: string; left_pct: number | null; used_pct: number | null; resets: string | null; extra?: string }>; probed_at: string } | null;
  /** 'orchestrator' = the PM seat (spec §5b). */
  role?: 'orchestrator' | null;
  /** True for the one agent the composer targets by default. */
  orchestrator?: boolean;
  /** Short handle (`@toni`), one-line persona and group tags (spec §5c). */
  alias?: string | null;
  persona?: string | null;
  tags?: string[];
}

export type UserRole = 'admin' | 'developer' | 'observer';

export interface User {
  id: string;
  name: string;
  role: UserRole;
  color: string;
  profile?: string | null;
  created_at?: string;
  /** /api/me only: the caller's own orchestrator seat (spec §5d). */
  seat?: { status: 'none' } | { status: 'ok'; agent_id: string } | { status: 'missing'; agent_id: string };
}

export const THREAD_KINDS = ['prompt', 'reply', 'command', 'report', 'request', 'run', 'verdict', 'task', 'alert', 'artifact'] as const;
export type ThreadKind = (typeof THREAD_KINDS)[number];

export interface ThreadAction {
  id: string;
  label: string;
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  body?: Record<string, unknown>;
}

export interface ThreadItem {
  id: string;
  event_id: number;
  at: string;
  kind: ThreadKind;
  type: string;
  agent_id: string | null;
  actor_id: string | null;
  title: string;
  body: string | null;
  refs: { task_id?: string; run_id?: string; review_id?: string; artifact_id?: string; message_id?: string; prompt_event_id?: number };
  needs_attention: boolean;
  actions: ThreadAction[];
  /** reply only (spec §5f) */
  feedback?: { up: number; down: number; mine: number | null; mine_note: string | null; can_vote: boolean };
}

/** Per-template metrics for a room (spec §5f). */
export interface TemplateMetrics {
  template: 'build' | 'review' | 'verify' | 'spec';
  tasks: number;
  reviewed: number;
  first_pass_rate: number | null;
  mean_fix_rounds: number | null;
  questions_rate: number | null;
  mean_time_to_result_s: number | null;
}

/** A proposed room-file change awaiting promote (spec §5f). */
export interface RoomProposal {
  id: string;
  room: string;
  path: string;
  diff: string;
  evidence: string;
  status: 'pending' | 'approved' | 'rejected' | 'stale';
  proposed_by: string | null;
  created_at: string;
}

export interface ThreadPage {
  items: ThreadItem[];
  cursor: number;
}

export type FileRunnerPhase = 'queued' | 'starting' | 'running' | 'done' | 'failed' | 'incomplete';

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked';

export interface Task {
  id: string;
  agent_id: string | null;
  prompt: string;
  status: TaskStatus;
  priority: number;
  created_at: string;
  goal_id?: string | null;
  created_by?: string | null;
  /** `#12` in the composer (spec §5c) */
  num?: number | null;
  latest_run?: { id: string } | null;
  dependencies?: string[];
  dependents?: string[];
  run_phase?: FileRunnerPhase | null;
  result?: 'PASS' | 'FAIL' | null;
  result_reason?: string | null;
}

export interface GoalRollup {
  pending: number;
  running: number;
  done: number;
  failed: number;
  blocked: number;
  total: number;
}

export interface Goal {
  id: string;
  title: string;
  status: 'active' | 'done' | 'failed' | 'cancelled';
  workspace: string | null;
  external_id: string | null;
  created_at: string;
  rollup: GoalRollup;
}

export interface Run {
  id: string;
  task_id: string;
  agent_id: string;
  attempt: number;
  status: 'running' | 'done' | 'failed';
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  transcript_path: string | null;
  review_status: 'pending' | 'approved' | 'rejected';
  result_path?: string | null;
  result?: 'PASS' | 'FAIL' | null;
  result_reason?: string | null;
  result_last_line?: string | null;
  phase?: FileRunnerPhase | null;
  pid?: number | null;
  log_path?: string | null;
  log?: string | null;
  last_line?: string | null;
}

export interface Artifact {
  id: string;
  filename: string;
  mime_type: string;
  sha256: string;
  size_bytes: number;
  storage_path: string;
  preview_path: string | null;
  source_agent_id: string | null;
  source_run_id: string | null;
  note: string | null;
  /** 'fixture' = kept in the development library (never pruned); 'transient' = pruned after retention */
  kind: 'fixture' | 'document' | 'transient';
  /** Product Desk / request number ('108', '91') */
  desk: string | null;
  room: string | null;
  /** where the bytes came from and how they were sanitized */
  provenance: string | null;
  uploaded_by: string | null;
  created_at: string;
}

export type ReviewVerdict = 'pass' | 'needs-fixes' | 'reject';

export interface ReviewItem {
  run: Run;
  task: Task;
  agentName: string;
  artifacts: Artifact[];
  duration: number | null;
  latestReview: {
    id: string;
    verdict: ReviewVerdict | null;
    issues_found: number;
    fix_round: number;
    created_at: string;
  } | null;
  /** Set when the card stands for a release freeze reviewed by files (exact SHA + reviewer verdict). */
  freeze: ReleaseFreezeCard | null;
}

export interface ReleaseFreezeCard {
  sha: string;
  project: string | null;
  desk: number | null;
  lane: string | null;
  author_name: string | null;
  reviewer_name: string | null;
  verdict: ReviewVerdict | null;
  freeze_path: string | null;
  verdict_path: string | null;
  gate: string | null;
  status: 'open' | 'promoted' | 'rejected' | 'stale';
  superseded_by: string | null;
}

export interface TmuxSession {
  name: string;
  created: number;
  lastActivity: number;
  adopted: boolean;
}

export interface CodeReview {
  id: string;
  run_id: string;
  reviewer_type: 'self' | 'cross-model';
  reviewer_agent_id: string | null;
  reviewer_runtime: string | null;
  status: 'pending' | 'reviewing' | 'done' | 'failed';
  diff: string | null;
  feedback: string | null;
  issues_found: number;
  verdict: ReviewVerdict | null;
  fix_round: number;
  fixes_sent_at: string | null;
  created_at: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  tool_calls: string | null;
  created_at: string;
}
