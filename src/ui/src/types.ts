export interface Agent {
  id: string;
  name: string;
  runtime: string;
  tmux_session: string;
  workspace: string | null;
  mode: 'adopted' | 'spawned';
  status: 'idle' | 'working' | 'error';
  created_at: string;
  lastOutputLine?: string;
  outputVersion?: number;
  watching?: boolean;
}

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked';

export interface Task {
  id: string;
  agent_id: string | null;
  prompt: string;
  status: TaskStatus;
  priority: number;
  created_at: string;
  dependencies?: string[];
  dependents?: string[];
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
  created_at: string;
}

export interface ReviewItem {
  run: Run;
  task: Task;
  agentName: string;
  artifacts: Artifact[];
  duration: number | null;
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
  created_at: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  tool_calls: string | null;
  created_at: string;
}
