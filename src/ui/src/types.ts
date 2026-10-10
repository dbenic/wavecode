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

/** The board (src/server/overview.ts) and the overlord's report (src/server/overlord.ts). */
export interface AgentBoardRow {
  id: string;
  name: string;
  alias: string | null;
  runtime: string;
  model: string | null;
  status: 'idle' | 'working' | 'error';
  status_since: string | null;
  for_min: number | null;
  current: { task_id: string; num: number | null; prompt: string; run_id: string; started_at: string } | null;
  last_reply: { at: string; text: string } | null;
  blocked_on: string | null;
  usage: string | null;
  budget: { weekly_left: number | null; five_h_left: number | null; resets: string | null };
  open_freezes: number;
}

export interface FixRow {
  sha: string;
  run_id: string;
  project: string | null;
  desk: number | null;
  lane: string | null;
  author: string | null;
  author_agent_id: string | null;
  reviewer: string | null;
  reason: 'needs fixes' | 'release failed' | 'rejected';
  detail: string | null;
  since: string;
  assigned: { task_id: string; num: number | null; status: string; agent_id: string | null; agent_name: string | null } | null;
}

export interface ChatTurn { id: string; created_at: string; role: 'user' | 'assistant'; user_id: string | null; user_name: string | null; text: string }

export interface LaneBoardRow {
  sha: string;
  run_id: string | null;
  project: string | null;
  desk: number | null;
  lane: string | null;
  author: string | null;
  reviewer: string | null;
  verdict: string | null;
  gate: string | null;
  status: 'open' | 'promoted' | 'rejected' | 'stale' | 'merged';
  superseded_by: string | null;
  promotable: boolean;
  candidate: string | null;
  summary: string | null;
  staging: { status: string; version: string | null; at: string; by: string | null; verified_by: string | null; verified_at: string | null } | null;
  production: { status: string; version: string | null; at: string; by: string | null; verified_by: string | null; verified_at: string | null } | null;
  next: string;
  updated_at: string;
}

export interface AttentionRow {
  kind: string;
  text: string;
  agent_id?: string;
  run_id?: string;
  sha?: string;
}

export interface CandidateRow {
  project: string;
  name: string;
  tip: string;
  committed_at: string | null;
  lanes: Array<{ sha: string; desk: number | null; lane: string | null; verdict: string | null; author: string | null }>;
  staging: LaneBoardRow['staging'];
  production: LaneBoardRow['production'];
  verified: { by: string; at: string; note: string | null } | null;
  next: string;
}

export interface Board {
  at: string;
  host: string;
  agents: AgentBoardRow[];
  lanes: LaneBoardRow[];
  candidates: CandidateRow[];
  fixes: FixRow[];
  attention: AttentionRow[];
  counts: { working: number; idle: number; error: number; open_lanes: number; promotable: number; releases_open: number; open_fixes: number; unassigned_fixes: number };
}

export interface Recommendation {
  kind: 'promote' | 'stage' | 'reject' | 'nudge' | 'reassign' | 'refreeze' | 'fix' | 'info';
  run_id?: string | null;
  agent_id?: string | null;
  sha?: string | null;
  text: string;
}

export interface ReleaseGroup {
  title: string;
  shas: string[];
  target: 'staging' | 'production' | 'hold';
  why: string;
}

export interface OverlordReport {
  id: string;
  created_at: string;
  trigger: string;
  model: string;
  agents: Array<{ id: string; note: string }>;
  recommendations: Recommendation[];
  plan: ReleaseGroup[];
  digest: string | null;
  board_at: string;
}

export interface OverviewResponse {
  board: Board;
  report: OverlordReport | null;
  overlord: { enabled: boolean; model: string; heartbeat_min: number; max_wakes_per_hour: number };
}

/** A release request record (src/server/releases.ts). */
export interface ReleaseRequest {
  id: string;
  project: string | null;
  sha: string;
  lane: string | null;
  target: 'staging' | 'production';
  desk: string | null;
  reviewer: string | null;
  requested_by: string | null;
  origin: 'local' | 'peer';
  peer: string | null;
  peer_request_id: string | null;
  run_id: string | null;
  deploy_agent_id: string | null;
  status: 'requested' | 'sent' | 'deployed' | 'failed' | 'rejected';
  version: string | null;
  deployed_sha: string | null;
  report: string | null;
  error: string | null;
  verified_by: string | null;
  verified_at: string | null;
  verification_note: string | null;
  created_at: string;
  updated_at: string;
  reported_at: string | null;
}

export interface AuditEntry {
  at: string;
  who: string;
  action: 'stage' | 'promote' | 'verify' | 'reject' | 'deployed' | 'failed' | 'auto-stage';
  target: 'staging' | 'production' | null;
  sha: string | null;
  project: string | null;
  desk: string | null;
  detail: string | null;
  release_id: string | null;
  run_id: string | null;
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
  status: 'open' | 'promoted' | 'rejected' | 'stale' | 'merged';
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
