import Database from 'better-sqlite3';
import path from 'node:path';
import { ulid } from 'ulid';
import { resolveRunResultPath } from './run-result.js';

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/** Reasoning-effort levels an agent can be pinned to. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value);
}

export interface Agent {
  id: string;
  name: string;
  runtime: string;  // 'claude-code' | 'codex' | 'aider' | 'aider-qwen' | 'aider-deepseek' | any runtime from config
  tmux_session: string;
  workspace: string | null;
  mode: 'adopted' | 'spawned';
  status: 'idle' | 'working' | 'error';
  model: string | null;       // pinned LLM model (e.g. 'claude-opus-5', 'grok-4.6'); null = runtime default
  effort: EffortLevel | null; // pinned reasoning effort; null = runtime default
  created_at: string;
}

export interface Task {
  id: string;
  agent_id: string | null;
  prompt: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'blocked';
  priority: number;
  created_at: string;
  goal_id: string | null;
}

export const GOAL_STATUSES = ['active', 'done', 'failed', 'cancelled'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export interface Goal {
  id: string;
  title: string;
  status: GoalStatus;
  workspace: string | null;
  external_id: string | null;
  created_at: string;
}

export interface GoalRollup {
  pending: number;
  running: number;
  done: number;
  failed: number;
  blocked: number;
  total: number;
}

export interface GoalWithRollup extends Goal {
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
  changed_files: string | null;  // JSON array of file paths
  result_path: string | null;
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

export interface WaveEvent {
  id: number;
  type: string;
  entity_type: string;
  entity_id: string;
  payload_json: string | null;
  created_at: string;
}

export interface GuideSource {
  id: string;
  name: string;
  kind: 'git' | 'local';
  url: string | null;
  path: string;
  glob: string;
  last_synced_at: string | null;
  created_at: string;
}

export interface Guide {
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

export interface AgentGuide {
  agent_id: string;
  guide_id: string;
  attached_at: string;
}

export interface Template {
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
  manifest_json: string | null;
  trusted: number;
  last_synced_at: string | null;
  created_at: string;
}

export interface PushSubscriptionRecord {
  id: string;
  endpoint: string;
  keys_json: string;
  user_agent: string | null;
  created_at: string;
}

export interface Decision {
  id: string;
  workspace: string;
  summary: string;
  detail: string | null;
  source_agent_id: string | null;
  source_run_id: string | null;
  created_at: string;
}

export interface AgentMessage {
  id: string;
  from_agent_id: string | null;    // null = system/user
  to_agent_id: string | null;      // null = broadcast to workspace
  workspace: string | null;
  message: string;
  message_type: 'info' | 'request' | 'handoff' | 'result' | 'error';
  ref_task_id: string | null;      // optional link to a task
  ref_run_id: string | null;       // optional link to a run
  created_at: string;
}

export interface ResearchRun {
  id: string;
  title: string;
  prompt: string;
  provider: string;             // 'anthropic' | 'openai' | 'gemini'
  model: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  output_md: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  error: string | null;
  target_agent_id: string | null;
  artifact_id: string | null;
  parent_run_id: string | null;
  created_at: string;
  finished_at: string | null;
}

export const SCHEMA_VERSION = 11;

/**
 * Base schema — applied via CREATE IF NOT EXISTS (safe for existing DBs).
 */
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    runtime TEXT NOT NULL,
    tmux_session TEXT NOT NULL,
    workspace TEXT,
    mode TEXT NOT NULL DEFAULT 'adopted',
    status TEXT NOT NULL DEFAULT 'idle',
    model TEXT,
    effort TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    workspace TEXT,
    external_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_goals_external ON goals(external_id);
  CREATE INDEX IF NOT EXISTS idx_goals_created ON goals(created_at DESC);

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    agent_id TEXT REFERENCES agents(id),
    prompt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    goal_id TEXT REFERENCES goals(id)
  );

  CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id TEXT NOT NULL REFERENCES tasks(id),
    depends_on_id TEXT NOT NULL REFERENCES tasks(id),
    PRIMARY KEY (task_id, depends_on_id)
  );

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    agent_id TEXT NOT NULL REFERENCES agents(id),
    attempt INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'running',
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    exit_code INTEGER,
    transcript_path TEXT,
    review_status TEXT NOT NULL DEFAULT 'pending',
    changed_files TEXT,
    result_path TEXT
  );

  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    storage_path TEXT NOT NULL,
    preview_path TEXT,
    source_agent_id TEXT,
    source_run_id TEXT,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS artifact_targets (
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    target_type TEXT NOT NULL,
    target_id TEXT
  );

  CREATE TABLE IF NOT EXISTS run_artifacts (
    run_id TEXT NOT NULL REFERENCES runs(id),
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    role TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    payload_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_events_entity
    ON events(entity_type, entity_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_tasks_status_agent
    ON tasks(status, agent_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_goal
    ON tasks(goal_id);
  CREATE INDEX IF NOT EXISTS idx_runs_task_status
    ON runs(task_id, status);
  CREATE INDEX IF NOT EXISTS idx_artifacts_source_run
    ON artifacts(source_run_id);

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL UNIQUE,
    keys_json TEXT NOT NULL,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS kv_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS guide_sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    url TEXT,
    path TEXT NOT NULL,
    glob TEXT NOT NULL DEFAULT '**/*.md',
    last_synced_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS guides (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES guide_sources(id) ON DELETE CASCADE,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    file_path TEXT NOT NULL,
    description TEXT,
    tags TEXT,
    size_bytes INTEGER NOT NULL,
    modified_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_guides_source ON guides(source_id);
  CREATE INDEX IF NOT EXISTS idx_guides_slug ON guides(slug);

  CREATE TABLE IF NOT EXISTS agent_guides (
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    guide_id TEXT NOT NULL REFERENCES guides(id) ON DELETE CASCADE,
    attached_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (agent_id, guide_id)
  );

  CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    git_url TEXT,
    local_path TEXT NOT NULL,
    default_runtime TEXT,
    required_env TEXT,
    post_clone_cmd TEXT,
    attach_guide_slugs TEXT,
    manifest_json TEXT,
    trusted INTEGER NOT NULL DEFAULT 0,
    last_synced_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS template_spawns (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    env_keys TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS research_runs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    output_md TEXT NOT NULL DEFAULT '',
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    error TEXT,
    target_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
    parent_run_id TEXT REFERENCES research_runs(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_research_runs_created ON research_runs(created_at DESC);

  CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    summary TEXT NOT NULL,
    detail TEXT,
    source_agent_id TEXT,
    source_run_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_decisions_workspace ON decisions(workspace);

  CREATE TABLE IF NOT EXISTS agent_messages (
    id TEXT PRIMARY KEY,
    from_agent_id TEXT,
    to_agent_id TEXT,
    workspace TEXT,
    message TEXT NOT NULL,
    message_type TEXT NOT NULL DEFAULT 'info',
    ref_task_id TEXT,
    ref_run_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_agent_messages_workspace ON agent_messages(workspace, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_agent_messages_to ON agent_messages(to_agent_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS code_reviews (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    reviewer_type TEXT NOT NULL,
    reviewer_agent_id TEXT,
    reviewer_runtime TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    diff TEXT,
    feedback TEXT,
    issues_found INTEGER DEFAULT 0,
    verdict TEXT,
    fix_round INTEGER NOT NULL DEFAULT 0,
    fixes_sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_code_reviews_run ON code_reviews(run_id);
`;

/**
 * Incremental migrations keyed by version number.
 * Each migration runs when upgrading FROM that version.
 * E.g., MIGRATIONS[1] runs when upgrading from v1 to v2.
 */
const MIGRATIONS: Record<number, string> = {
  // v1 → v2: Add push_subscriptions table (handled by CREATE IF NOT EXISTS)
  1: `
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      endpoint TEXT NOT NULL UNIQUE,
      keys_json TEXT NOT NULL,
      user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `,
  // v2 → v3: Add kv_settings for VAPID key persistence
  2: `
    CREATE TABLE IF NOT EXISTS kv_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `,
  // v3 → v4: Add guide_sources, guides, agent_guides for Library feature
  3: `
    CREATE TABLE IF NOT EXISTS guide_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      url TEXT,
      path TEXT NOT NULL,
      glob TEXT NOT NULL DEFAULT '**/*.md',
      last_synced_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS guides (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES guide_sources(id) ON DELETE CASCADE,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      file_path TEXT NOT NULL,
      description TEXT,
      tags TEXT,
      size_bytes INTEGER NOT NULL,
      modified_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_guides_source ON guides(source_id);
    CREATE INDEX IF NOT EXISTS idx_guides_slug ON guides(slug);
    CREATE TABLE IF NOT EXISTS agent_guides (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      guide_id TEXT NOT NULL REFERENCES guides(id) ON DELETE CASCADE,
      attached_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (agent_id, guide_id)
    );
  `,
  // v4 → v5: Add templates, template_spawns
  4: `
    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      git_url TEXT,
      local_path TEXT NOT NULL,
      default_runtime TEXT,
      required_env TEXT,
      post_clone_cmd TEXT,
      attach_guide_slugs TEXT,
      manifest_json TEXT,
      trusted INTEGER NOT NULL DEFAULT 0,
      last_synced_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS template_spawns (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      env_keys TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `,
  // v5 → v6: Add research_runs for Specs (research pipeline)
  5: `
    CREATE TABLE IF NOT EXISTS research_runs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      output_md TEXT NOT NULL DEFAULT '',
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      error TEXT,
      target_agent_id TEXT,
      artifact_id TEXT,
      parent_run_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_research_runs_created ON research_runs(created_at DESC);
  `,
  // v6 → v7: Add decisions table + changed_files on runs
  6: `
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      summary TEXT NOT NULL,
      detail TEXT,
      source_agent_id TEXT,
      source_run_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_workspace ON decisions(workspace);
    ALTER TABLE runs ADD COLUMN changed_files TEXT;
  `,
  // v7 → v8: Add agent_messages for inter-agent messaging
  7: `
    CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY,
      from_agent_id TEXT,
      to_agent_id TEXT,
      workspace TEXT,
      message TEXT NOT NULL,
      message_type TEXT NOT NULL DEFAULT 'info',
      ref_task_id TEXT,
      ref_run_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_messages_workspace ON agent_messages(workspace, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_to ON agent_messages(to_agent_id, created_at DESC);
  `,
  // v8 → v9: Add model/effort pinning columns on agents
  8: `
    ALTER TABLE agents ADD COLUMN model TEXT;
    ALTER TABLE agents ADD COLUMN effort TEXT;
  `,
  // v9 → v10: Persist goals as first-class rows; tasks may point at a goal
  9: `
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      workspace TEXT,
      external_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_goals_external ON goals(external_id);
    CREATE INDEX IF NOT EXISTS idx_goals_created ON goals(created_at DESC);
    ALTER TABLE tasks ADD COLUMN goal_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks(goal_id);
  `,
  // v10 → v11: Per-run orchestrate result file path
  10: `
    ALTER TABLE runs ADD COLUMN result_path TEXT;
  `,
};

let db: Database.Database;

export function initDb(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? path.join(process.cwd(), 'wavecode.db');
  db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const currentVersion = db.pragma('user_version', { simple: true }) as number;

  if (currentVersion === 0) {
    // Fresh database — run full schema
    db.exec(SCHEMA_SQL);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  } else if (currentVersion < SCHEMA_VERSION) {
    // Existing database — run incremental migrations
    for (let v = currentVersion; v < SCHEMA_VERSION; v++) {
      const migration = MIGRATIONS[v];
      if (migration) {
        db.exec(migration);
      }
    }
    // Also run base schema for any new CREATE IF NOT EXISTS tables
    db.exec(SCHEMA_SQL);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

/** Reset the DB singleton (for tests only). */
export function resetDbForTest(): void {
  if (db) {
    db.close();
    db = undefined!;
  }
}

export function generateId(): string {
  return ulid();
}

// --- Agent helpers ---

export function insertAgent(
  agent: Omit<Agent, 'id' | 'created_at' | 'model' | 'effort'> & {
    model?: string | null;
    effort?: EffortLevel | null;
  },
): Result<Agent> {
  const id = generateId();
  try {
    getDb().prepare(`
      INSERT INTO agents (id, name, runtime, tmux_session, workspace, mode, status, model, effort)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, agent.name, agent.runtime, agent.tmux_session, agent.workspace,
      agent.mode, agent.status, agent.model ?? null, agent.effort ?? null,
    );
    const row = getDb().prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent;
    return { ok: true, data: row };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function getAgent(id: string): Result<Agent> {
  const row = getDb().prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent | undefined;
  if (!row) return { ok: false, error: `Agent ${id} not found` };
  return { ok: true, data: row };
}

export function getAgentByName(name: string): Result<Agent> {
  const row = getDb().prepare('SELECT * FROM agents WHERE name = ?').get(name) as Agent | undefined;
  if (!row) return { ok: false, error: `Agent '${name}' not found` };
  return { ok: true, data: row };
}

export function listAgents(): Agent[] {
  return getDb().prepare('SELECT * FROM agents ORDER BY created_at DESC').all() as Agent[];
}

export function updateAgentStatus(id: string, status: Agent['status']): Result<Agent> {
  const result = getDb().prepare('UPDATE agents SET status = ? WHERE id = ?').run(status, id);
  if (result.changes === 0) return { ok: false, error: `Agent ${id} not found` };
  return getAgent(id);
}

/**
 * Update an agent's model/effort pin. Passing `null` clears the pin;
 * omitting a field leaves it unchanged.
 */
export function updateAgentPin(
  id: string,
  pin: { model?: string | null; effort?: EffortLevel | null },
): Result<Agent> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (pin.model !== undefined) {
    sets.push('model = ?');
    params.push(pin.model);
  }
  if (pin.effort !== undefined) {
    sets.push('effort = ?');
    params.push(pin.effort);
  }
  if (sets.length === 0) return getAgent(id);

  params.push(id);
  const result = getDb().prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  if (result.changes === 0) return { ok: false, error: `Agent ${id} not found` };
  return getAgent(id);
}

export function updateAgentWorkspace(id: string, workspace: string): Result<Agent> {
  const result = getDb().prepare('UPDATE agents SET workspace = ? WHERE id = ?').run(workspace, id);
  if (result.changes === 0) return { ok: false, error: `Agent ${id} not found` };
  return getAgent(id);
}

export function deleteAgent(id: string): Result<void> {
  const result = getDb().prepare('DELETE FROM agents WHERE id = ?').run(id);
  if (result.changes === 0) return { ok: false, error: `Agent ${id} not found` };
  return { ok: true, data: undefined };
}

// --- Task helpers ---

export function insertTask(task: {
  agent_id?: string | null;
  prompt: string;
  priority?: number;
  goal_id?: string | null;
}): Result<Task> {
  const id = generateId();
  try {
    getDb().prepare(`
      INSERT INTO tasks (id, agent_id, prompt, priority, goal_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, task.agent_id ?? null, task.prompt, task.priority ?? 0, task.goal_id ?? null);
    const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task;
    return { ok: true, data: row };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function getTask(id: string): Result<Task> {
  const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
  if (!row) return { ok: false, error: `Task ${id} not found` };
  return { ok: true, data: row };
}

export function listTasks(filters?: { status?: string; agent_id?: string; goal_id?: string }): Task[] {
  let sql = 'SELECT * FROM tasks';
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.status) {
    conditions.push('status = ?');
    params.push(filters.status);
  }
  if (filters?.agent_id) {
    conditions.push('agent_id = ?');
    params.push(filters.agent_id);
  }
  if (filters?.goal_id) {
    conditions.push('goal_id = ?');
    params.push(filters.goal_id);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY priority DESC, created_at ASC';

  return getDb().prepare(sql).all(...params) as Task[];
}

export function insertGoal(goal: {
  title: string;
  status?: GoalStatus;
  workspace?: string | null;
  external_id?: string | null;
}): Result<Goal> {
  const id = generateId();
  try {
    getDb().prepare(`
      INSERT INTO goals (id, title, status, workspace, external_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      id,
      goal.title,
      goal.status ?? 'active',
      goal.workspace ?? null,
      goal.external_id ?? null,
    );
    const row = getDb().prepare('SELECT * FROM goals WHERE id = ?').get(id) as Goal;
    return { ok: true, data: row };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function getGoal(id: string): Result<Goal> {
  const row = getDb().prepare('SELECT * FROM goals WHERE id = ?').get(id) as Goal | undefined;
  if (!row) return { ok: false, error: `Goal ${id} not found` };
  return { ok: true, data: row };
}

export function getGoalByExternalId(externalId: string): Result<Goal> {
  const row = getDb().prepare(
    'SELECT * FROM goals WHERE external_id = ? ORDER BY created_at DESC LIMIT 1',
  ).get(externalId) as Goal | undefined;
  if (!row) return { ok: false, error: `Goal '${externalId}' not found` };
  return { ok: true, data: row };
}

/** Look up a goal by ULID or optional external_id (e.g. F-16). */
export function findGoal(idOrExternal: string): Result<Goal> {
  const byId = getGoal(idOrExternal);
  if (byId.ok) return byId;
  return getGoalByExternalId(idOrExternal);
}

export function listGoals(): Goal[] {
  return getDb().prepare('SELECT * FROM goals ORDER BY created_at DESC').all() as Goal[];
}

const GOAL_ROLLUP_SELECT = `
  SELECT
    g.*,
    COALESCE(SUM(CASE WHEN t.status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
    COALESCE(SUM(CASE WHEN t.status = 'running' THEN 1 ELSE 0 END), 0) AS running,
    COALESCE(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END), 0) AS done,
    COALESCE(SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
    COALESCE(SUM(CASE WHEN t.status = 'blocked' THEN 1 ELSE 0 END), 0) AS blocked,
    COALESCE(COUNT(t.id), 0) AS total
  FROM goals g
  LEFT JOIN tasks t ON t.goal_id = g.id
`;

interface GoalRollupRow extends Goal {
  pending: number;
  running: number;
  done: number;
  failed: number;
  blocked: number;
  total: number;
}

function toGoalWithRollup(row: GoalRollupRow): GoalWithRollup {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    workspace: row.workspace,
    external_id: row.external_id,
    created_at: row.created_at,
    rollup: {
      pending: Number(row.pending),
      running: Number(row.running),
      done: Number(row.done),
      failed: Number(row.failed),
      blocked: Number(row.blocked),
      total: Number(row.total),
    },
  };
}

export function listGoalsWithRollup(): GoalWithRollup[] {
  const rows = getDb().prepare(
    `${GOAL_ROLLUP_SELECT} GROUP BY g.id ORDER BY g.created_at DESC`,
  ).all() as GoalRollupRow[];
  return rows.map(toGoalWithRollup);
}

export function getGoalWithRollup(idOrExternal: string): Result<GoalWithRollup> {
  const found = findGoal(idOrExternal);
  if (!found.ok) return found;
  const row = getDb().prepare(
    `${GOAL_ROLLUP_SELECT} WHERE g.id = ? GROUP BY g.id`,
  ).get(found.data.id) as GoalRollupRow | undefined;
  if (!row) return { ok: false, error: `Goal ${idOrExternal} not found` };
  return { ok: true, data: toGoalWithRollup(row) };
}

export function updateTaskStatus(id: string, status: Task['status']): Result<Task> {
  const result = getDb().prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, id);
  if (result.changes === 0) return { ok: false, error: `Task ${id} not found` };
  return getTask(id);
}

// --- Run helpers ---

export function insertRun(run: { task_id: string; agent_id: string; attempt?: number }): Result<Run> {
  const id = generateId();
  try {
    const agent = getAgent(run.agent_id);
    const resultPath = resolveRunResultPath(id, agent.ok ? agent.data.workspace : null);
    getDb().prepare(`
      INSERT INTO runs (id, task_id, agent_id, attempt, result_path)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, run.task_id, run.agent_id, run.attempt ?? 1, resultPath);
    const row = getDb().prepare('SELECT * FROM runs WHERE id = ?').get(id) as Run;
    return { ok: true, data: row };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function updateRunResultPath(id: string, resultPath: string): Result<Run> {
  const result = getDb().prepare('UPDATE runs SET result_path = ? WHERE id = ?').run(resultPath, id);
  if (result.changes === 0) return { ok: false, error: `Run ${id} not found` };
  return getRun(id);
}

export function getRun(id: string): Result<Run> {
  const row = getDb().prepare('SELECT * FROM runs WHERE id = ?').get(id) as Run | undefined;
  if (!row) return { ok: false, error: `Run ${id} not found` };
  return { ok: true, data: row };
}

export function listRuns(filters?: { task_id?: string; agent_id?: string; status?: string }): Run[] {
  let sql = 'SELECT * FROM runs';
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.task_id) { conditions.push('task_id = ?'); params.push(filters.task_id); }
  if (filters?.agent_id) { conditions.push('agent_id = ?'); params.push(filters.agent_id); }
  if (filters?.status) { conditions.push('status = ?'); params.push(filters.status); }

  if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY started_at DESC';

  return getDb().prepare(sql).all(...params) as Run[];
}

export function updateRunReviewStatus(id: string, reviewStatus: Run['review_status']): Result<Run> {
  const result = getDb().prepare('UPDATE runs SET review_status = ? WHERE id = ?').run(reviewStatus, id);
  if (result.changes === 0) return { ok: false, error: `Run ${id} not found` };
  return getRun(id);
}

export function listReviewableRuns(): Run[] {
  return getDb().prepare(
    `SELECT * FROM runs WHERE status = 'done' AND review_status = 'pending' ORDER BY finished_at DESC`
  ).all() as Run[];
}

export function finishRun(id: string, exitCode: number): Result<Run> {
  const existing = getRun(id);
  if (!existing.ok) return existing;
  if (existing.data.finished_at && existing.data.status !== 'running') {
    return existing;
  }
  const status = exitCode === 0 ? 'done' : 'failed';
  const result = getDb().prepare(`
    UPDATE runs SET status = ?, exit_code = ?, finished_at = datetime('now')
    WHERE id = ?
  `).run(status, exitCode, id);
  if (result.changes === 0) return { ok: false, error: `Run ${id} not found` };
  return getRun(id);
}

/** Runs that still occupy the seat: status=running or finished_at IS NULL. */
export function listOpenRuns(agentId: string): Run[] {
  return listRuns({ agent_id: agentId }).filter(
    (run) => run.status === 'running' || run.finished_at == null,
  );
}

export function hasOpenRun(agentId: string): boolean {
  return listOpenRuns(agentId).length > 0;
}

// --- Event helpers ---

export function insertEvent(event: {
  type: string;
  entity_type: string;
  entity_id: string;
  payload?: Record<string, unknown>;
}): Result<WaveEvent> {
  try {
    const payloadJson = event.payload ? JSON.stringify(event.payload) : null;
    const info = getDb().prepare(`
      INSERT INTO events (type, entity_type, entity_id, payload_json)
      VALUES (?, ?, ?, ?)
    `).run(event.type, event.entity_type, event.entity_id, payloadJson);
    const row = getDb().prepare('SELECT * FROM events WHERE id = ?').get(info.lastInsertRowid) as WaveEvent;
    return { ok: true, data: row };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function listEvents(filters?: {
  since_id?: number;
  entity_type?: string;
  entity_id?: string;
  limit?: number;
}): WaveEvent[] {
  let sql = 'SELECT * FROM events';
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.since_id) { conditions.push('id > ?'); params.push(filters.since_id); }
  if (filters?.entity_type) { conditions.push('entity_type = ?'); params.push(filters.entity_type); }
  if (filters?.entity_id) { conditions.push('entity_id = ?'); params.push(filters.entity_id); }

  if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY id ASC';
  if (filters?.limit) { sql += ' LIMIT ?'; params.push(filters.limit); }

  return getDb().prepare(sql).all(...params) as WaveEvent[];
}

// --- Artifact helpers ---

export function insertArtifact(artifact: Omit<Artifact, 'id' | 'created_at'>): Result<Artifact> {
  const id = generateId();
  try {
    getDb().prepare(`
      INSERT INTO artifacts (id, filename, mime_type, sha256, size_bytes, storage_path, preview_path, source_agent_id, source_run_id, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, artifact.filename, artifact.mime_type, artifact.sha256, artifact.size_bytes,
           artifact.storage_path, artifact.preview_path, artifact.source_agent_id,
           artifact.source_run_id, artifact.note);
    const row = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as Artifact;
    return { ok: true, data: row };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function getArtifact(id: string): Result<Artifact> {
  const row = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as Artifact | undefined;
  if (!row) return { ok: false, error: `Artifact ${id} not found` };
  return { ok: true, data: row };
}

export function listArtifacts(filters?: {
  source_agent_id?: string;
  source_run_id?: string;
}): Artifact[] {
  let sql = 'SELECT * FROM artifacts';
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.source_agent_id) { conditions.push('source_agent_id = ?'); params.push(filters.source_agent_id); }
  if (filters?.source_run_id) { conditions.push('source_run_id = ?'); params.push(filters.source_run_id); }

  if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY created_at DESC';

  return getDb().prepare(sql).all(...params) as Artifact[];
}

export function findArtifactByHash(sha256: string): Artifact | null {
  return getDb().prepare('SELECT * FROM artifacts WHERE sha256 = ?').get(sha256) as Artifact | null;
}

export function insertArtifactTarget(artifactId: string, targetType: string, targetId: string | null): void {
  getDb().prepare(
    'INSERT INTO artifact_targets (artifact_id, target_type, target_id) VALUES (?, ?, ?)'
  ).run(artifactId, targetType, targetId);
}

export function insertRunArtifact(runId: string, artifactId: string, role: string): void {
  getDb().prepare(
    'INSERT INTO run_artifacts (run_id, artifact_id, role) VALUES (?, ?, ?)'
  ).run(runId, artifactId, role);
}

export function getRunArtifacts(runId: string): Artifact[] {
  return getDb().prepare(`
    SELECT a.* FROM artifacts a
    JOIN run_artifacts ra ON ra.artifact_id = a.id
    WHERE ra.run_id = ?
    ORDER BY a.created_at DESC
  `).all(runId) as Artifact[];
}

export function deleteArtifactTargets(artifactId: string): void {
  getDb().prepare('DELETE FROM artifact_targets WHERE artifact_id = ?').run(artifactId);
}

export function deleteArtifactTarget(artifactId: string, targetType: string, targetId: string): void {
  getDb().prepare(
    'DELETE FROM artifact_targets WHERE artifact_id = ? AND target_type = ? AND target_id = ?'
  ).run(artifactId, targetType, targetId);
}

export function deleteRunArtifacts(artifactId: string): void {
  getDb().prepare('DELETE FROM run_artifacts WHERE artifact_id = ?').run(artifactId);
}

export function deleteArtifact(artifactId: string): void {
  getDb().prepare('DELETE FROM artifacts WHERE id = ?').run(artifactId);
}

export function listArtifactsForAgent(agentId: string): Artifact[] {
  return getDb().prepare(`
    SELECT DISTINCT a.* FROM artifacts a
    LEFT JOIN artifact_targets at ON at.artifact_id = a.id AND at.target_type = 'agent' AND at.target_id = ?
    WHERE a.source_agent_id = ? OR at.target_id = ?
    ORDER BY a.created_at DESC
  `).all(agentId, agentId, agentId) as Artifact[];
}

export function countArtifactRefsForHash(sha256: string, excludeId: string): number {
  const row = getDb().prepare(
    'SELECT COUNT(*) as cnt FROM artifacts WHERE sha256 = ? AND id != ?'
  ).get(sha256, excludeId) as { cnt: number };
  return row.cnt;
}

// --- Push Subscription helpers ---

export function insertPushSubscription(sub: {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
}): Result<PushSubscriptionRecord> {
  const id = generateId();
  const keysJson = JSON.stringify(sub.keys);
  try {
    getDb().prepare(`
      INSERT OR REPLACE INTO push_subscriptions (id, endpoint, keys_json, user_agent)
      VALUES (?, ?, ?, ?)
    `).run(id, sub.endpoint, keysJson, sub.userAgent ?? null);
    const row = getDb().prepare('SELECT * FROM push_subscriptions WHERE id = ?').get(id) as PushSubscriptionRecord;
    return { ok: true, data: row };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function listPushSubscriptions(): PushSubscriptionRecord[] {
  return getDb().prepare('SELECT * FROM push_subscriptions ORDER BY created_at DESC').all() as PushSubscriptionRecord[];
}

export function deletePushSubscription(endpoint: string): boolean {
  const result = getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  return result.changes > 0;
}

// --- Guide sources ---

export function insertGuideSource(
  src: Omit<GuideSource, 'id' | 'created_at' | 'last_synced_at'>,
): Result<GuideSource> {
  const id = generateId();
  try {
    getDb().prepare(`
      INSERT INTO guide_sources (id, name, kind, url, path, glob)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, src.name, src.kind, src.url, src.path, src.glob);
    const row = getDb().prepare('SELECT * FROM guide_sources WHERE id = ?').get(id) as GuideSource;
    return { ok: true, data: row };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function listGuideSources(): GuideSource[] {
  return getDb().prepare('SELECT * FROM guide_sources ORDER BY created_at DESC').all() as GuideSource[];
}

export function getGuideSource(id: string): Result<GuideSource> {
  const row = getDb().prepare('SELECT * FROM guide_sources WHERE id = ?').get(id) as GuideSource | undefined;
  if (!row) return { ok: false, error: `Guide source ${id} not found` };
  return { ok: true, data: row };
}

export function updateGuideSourceSynced(id: string): void {
  getDb().prepare('UPDATE guide_sources SET last_synced_at = datetime(\'now\') WHERE id = ?').run(id);
}

export function deleteGuideSource(id: string): boolean {
  const result = getDb().prepare('DELETE FROM guide_sources WHERE id = ?').run(id);
  return result.changes > 0;
}

// --- Guides ---

export function upsertGuide(
  g: Omit<Guide, 'id'>,
): Result<Guide> {
  try {
    const existing = getDb().prepare('SELECT id FROM guides WHERE slug = ?').get(g.slug) as { id: string } | undefined;
    if (existing) {
      getDb().prepare(`
        UPDATE guides SET source_id = ?, title = ?, file_path = ?, description = ?, tags = ?, size_bytes = ?, modified_at = ?
        WHERE id = ?
      `).run(g.source_id, g.title, g.file_path, g.description, g.tags, g.size_bytes, g.modified_at, existing.id);
      const row = getDb().prepare('SELECT * FROM guides WHERE id = ?').get(existing.id) as Guide;
      return { ok: true, data: row };
    }
    const id = generateId();
    getDb().prepare(`
      INSERT INTO guides (id, source_id, slug, title, file_path, description, tags, size_bytes, modified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, g.source_id, g.slug, g.title, g.file_path, g.description, g.tags, g.size_bytes, g.modified_at);
    const row = getDb().prepare('SELECT * FROM guides WHERE id = ?').get(id) as Guide;
    return { ok: true, data: row };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function listGuides(filters?: { sourceId?: string; search?: string }): Guide[] {
  let sql = 'SELECT * FROM guides';
  const params: unknown[] = [];
  const wheres: string[] = [];
  if (filters?.sourceId) { wheres.push('source_id = ?'); params.push(filters.sourceId); }
  if (filters?.search) {
    wheres.push('(title LIKE ? OR description LIKE ? OR tags LIKE ?)');
    const q = `%${filters.search}%`;
    params.push(q, q, q);
  }
  if (wheres.length) sql += ' WHERE ' + wheres.join(' AND ');
  sql += ' ORDER BY title';
  return getDb().prepare(sql).all(...params) as Guide[];
}

export function getGuide(id: string): Result<Guide> {
  const row = getDb().prepare('SELECT * FROM guides WHERE id = ?').get(id) as Guide | undefined;
  if (!row) return { ok: false, error: `Guide ${id} not found` };
  return { ok: true, data: row };
}

export function getGuideBySlug(slug: string): Result<Guide> {
  const row = getDb().prepare('SELECT * FROM guides WHERE slug = ?').get(slug) as Guide | undefined;
  if (!row) return { ok: false, error: `Guide '${slug}' not found` };
  return { ok: true, data: row };
}

export function deleteGuidesBySource(sourceId: string): number {
  const result = getDb().prepare('DELETE FROM guides WHERE source_id = ?').run(sourceId);
  return result.changes;
}

export function deleteGuidesNotIn(sourceId: string, slugsToKeep: string[]): number {
  if (slugsToKeep.length === 0) {
    return getDb().prepare('DELETE FROM guides WHERE source_id = ?').run(sourceId).changes;
  }
  const placeholders = slugsToKeep.map(() => '?').join(',');
  const result = getDb().prepare(
    `DELETE FROM guides WHERE source_id = ? AND slug NOT IN (${placeholders})`
  ).run(sourceId, ...slugsToKeep);
  return result.changes;
}

// --- Agent-guide attachments ---

export function attachGuide(agentId: string, guideId: string): Result<void> {
  try {
    getDb().prepare(
      'INSERT OR IGNORE INTO agent_guides (agent_id, guide_id) VALUES (?, ?)'
    ).run(agentId, guideId);
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function detachGuide(agentId: string, guideId: string): boolean {
  const result = getDb().prepare(
    'DELETE FROM agent_guides WHERE agent_id = ? AND guide_id = ?'
  ).run(agentId, guideId);
  return result.changes > 0;
}

export function listGuidesForAgent(agentId: string): Guide[] {
  return getDb().prepare(`
    SELECT g.* FROM guides g
    INNER JOIN agent_guides ag ON ag.guide_id = g.id
    WHERE ag.agent_id = ?
    ORDER BY ag.attached_at DESC
  `).all(agentId) as Guide[];
}

// --- Templates ---

export function insertTemplate(
  t: Omit<Template, 'id' | 'created_at' | 'last_synced_at'>,
): Result<Template> {
  const id = generateId();
  try {
    getDb().prepare(`
      INSERT INTO templates
        (id, slug, name, description, git_url, local_path, default_runtime,
         required_env, post_clone_cmd, attach_guide_slugs, manifest_json, trusted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, t.slug, t.name, t.description, t.git_url, t.local_path, t.default_runtime,
           t.required_env, t.post_clone_cmd, t.attach_guide_slugs, t.manifest_json, t.trusted);
    const row = getDb().prepare('SELECT * FROM templates WHERE id = ?').get(id) as Template;
    return { ok: true, data: row };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function updateTemplateFromManifest(
  id: string,
  fields: Partial<Pick<Template, 'name' | 'description' | 'default_runtime' | 'required_env' | 'post_clone_cmd' | 'attach_guide_slugs' | 'manifest_json'>>,
): Result<Template> {
  const keys = Object.keys(fields);
  if (keys.length === 0) return getTemplate(id);
  const setClause = keys.map((k) => `${k} = ?`).join(', ');
  const values = Object.values(fields);
  getDb().prepare(
    `UPDATE templates SET ${setClause}, last_synced_at = datetime('now') WHERE id = ?`
  ).run(...values, id);
  return getTemplate(id);
}

export function setTemplateTrusted(id: string, trusted: boolean): Result<Template> {
  const result = getDb().prepare('UPDATE templates SET trusted = ? WHERE id = ?').run(trusted ? 1 : 0, id);
  if (result.changes === 0) return { ok: false, error: `Template ${id} not found` };
  return getTemplate(id);
}

export function listTemplates(): Template[] {
  return getDb().prepare('SELECT * FROM templates ORDER BY name').all() as Template[];
}

export function getTemplate(id: string): Result<Template> {
  const row = getDb().prepare('SELECT * FROM templates WHERE id = ?').get(id) as Template | undefined;
  if (!row) return { ok: false, error: `Template ${id} not found` };
  return { ok: true, data: row };
}

export function getTemplateBySlug(slug: string): Result<Template> {
  const row = getDb().prepare('SELECT * FROM templates WHERE slug = ?').get(slug) as Template | undefined;
  if (!row) return { ok: false, error: `Template '${slug}' not found` };
  return { ok: true, data: row };
}

export function deleteTemplate(id: string): boolean {
  const result = getDb().prepare('DELETE FROM templates WHERE id = ?').run(id);
  return result.changes > 0;
}

export function insertTemplateSpawn(templateId: string, agentId: string, envKeys: string[]): void {
  const id = generateId();
  getDb().prepare(
    'INSERT INTO template_spawns (id, template_id, agent_id, env_keys) VALUES (?, ?, ?, ?)'
  ).run(id, templateId, agentId, JSON.stringify(envKeys));
}

// --- Research Runs ---

export function insertResearchRun(row: {
  title: string;
  prompt: string;
  provider: string;
  model: string;
  target_agent_id?: string | null;
  parent_run_id?: string | null;
}): ResearchRun {
  const id = generateId();
  getDb().prepare(`
    INSERT INTO research_runs (id, title, prompt, provider, model, target_agent_id, parent_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, row.title, row.prompt, row.provider, row.model, row.target_agent_id ?? null, row.parent_run_id ?? null);
  const run = getResearchRun(id);
  if (!run.ok) throw new Error('Failed to re-read research run after insert');
  return run.data;
}

export function getResearchRun(id: string): Result<ResearchRun> {
  const row = getDb().prepare('SELECT * FROM research_runs WHERE id = ?').get(id) as ResearchRun | undefined;
  if (!row) return { ok: false, error: `Research run '${id}' not found` };
  return { ok: true, data: row };
}

export function listResearchRuns(limit = 100): ResearchRun[] {
  return getDb().prepare('SELECT * FROM research_runs ORDER BY created_at DESC LIMIT ?').all(limit) as ResearchRun[];
}

export function appendResearchOutput(id: string, chunk: string): void {
  getDb().prepare('UPDATE research_runs SET output_md = output_md || ? WHERE id = ?').run(chunk, id);
}

export function finishResearchRun(id: string, fields: {
  status: 'done' | 'failed' | 'cancelled';
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  error?: string | null;
  output_md?: string;
}): void {
  const cols: string[] = ['status = ?', 'finished_at = datetime(\'now\')'];
  const vals: unknown[] = [fields.status];
  if (fields.tokens_in !== undefined) { cols.push('tokens_in = ?'); vals.push(fields.tokens_in); }
  if (fields.tokens_out !== undefined) { cols.push('tokens_out = ?'); vals.push(fields.tokens_out); }
  if (fields.cost_usd !== undefined) { cols.push('cost_usd = ?'); vals.push(fields.cost_usd); }
  if (fields.error !== undefined) { cols.push('error = ?'); vals.push(fields.error); }
  if (fields.output_md !== undefined) { cols.push('output_md = ?'); vals.push(fields.output_md); }
  vals.push(id);
  getDb().prepare(`UPDATE research_runs SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
}

export function setResearchArtifact(id: string, artifactId: string, targetAgentId: string | null): void {
  getDb().prepare('UPDATE research_runs SET artifact_id = ?, target_agent_id = COALESCE(?, target_agent_id) WHERE id = ?')
    .run(artifactId, targetAgentId, id);
}

export function deleteResearchRun(id: string): boolean {
  const result = getDb().prepare('DELETE FROM research_runs WHERE id = ?').run(id);
  return result.changes > 0;
}

// --- Decision helpers ---

export function insertDecision(d: {
  workspace: string;
  summary: string;
  detail?: string | null;
  source_agent_id?: string | null;
  source_run_id?: string | null;
}): Result<Decision> {
  const id = generateId();
  try {
    getDb().prepare(`
      INSERT INTO decisions (id, workspace, summary, detail, source_agent_id, source_run_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, d.workspace, d.summary, d.detail ?? null, d.source_agent_id ?? null, d.source_run_id ?? null);
    const row = getDb().prepare('SELECT * FROM decisions WHERE id = ?').get(id) as Decision;
    return { ok: true, data: row };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function listDecisions(workspace: string): Decision[] {
  return getDb().prepare(
    'SELECT * FROM decisions WHERE workspace = ? ORDER BY created_at DESC'
  ).all(workspace) as Decision[];
}

export function listAllDecisions(): Decision[] {
  return getDb().prepare(
    'SELECT * FROM decisions ORDER BY created_at DESC'
  ).all() as Decision[];
}

export function deleteDecision(id: string): boolean {
  const result = getDb().prepare('DELETE FROM decisions WHERE id = ?').run(id);
  return result.changes > 0;
}

export function updateRunChangedFiles(runId: string, changedFiles: string[]): void {
  getDb().prepare('UPDATE runs SET changed_files = ? WHERE id = ?')
    .run(JSON.stringify(changedFiles), runId);
}

/**
 * Get recent runs for a workspace, with agent and task info.
 */
export function getRecentRunsForWorkspace(workspace: string, limit = 10): Array<Run & { agent_name: string; task_prompt: string }> {
  return getDb().prepare(`
    SELECT r.*, a.name as agent_name, t.prompt as task_prompt
    FROM runs r
    JOIN agents a ON a.id = r.agent_id
    JOIN tasks t ON t.id = r.task_id
    WHERE a.workspace = ?
    ORDER BY r.started_at DESC
    LIMIT ?
  `).all(workspace, limit) as Array<Run & { agent_name: string; task_prompt: string }>;
}

/**
 * Get agents sharing the same workspace.
 */
export function getAgentsByWorkspace(workspace: string): Agent[] {
  return getDb().prepare(
    'SELECT * FROM agents WHERE workspace = ? ORDER BY created_at ASC'
  ).all(workspace) as Agent[];
}

// --- Agent Message helpers ---

export function insertAgentMessage(msg: {
  from_agent_id?: string | null;
  to_agent_id?: string | null;
  workspace?: string | null;
  message: string;
  message_type?: AgentMessage['message_type'];
  ref_task_id?: string | null;
  ref_run_id?: string | null;
}): Result<AgentMessage> {
  const id = generateId();
  try {
    getDb().prepare(`
      INSERT INTO agent_messages (id, from_agent_id, to_agent_id, workspace, message, message_type, ref_task_id, ref_run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      msg.from_agent_id ?? null,
      msg.to_agent_id ?? null,
      msg.workspace ?? null,
      msg.message,
      msg.message_type ?? 'info',
      msg.ref_task_id ?? null,
      msg.ref_run_id ?? null,
    );
    const row = getDb().prepare('SELECT * FROM agent_messages WHERE id = ?').get(id) as AgentMessage;
    return { ok: true, data: row };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function listAgentMessages(filters?: {
  workspace?: string;
  to_agent_id?: string;
  from_agent_id?: string;
  limit?: number;
}): AgentMessage[] {
  let sql = 'SELECT * FROM agent_messages';
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.workspace) { conditions.push('workspace = ?'); params.push(filters.workspace); }
  if (filters?.to_agent_id) { conditions.push('(to_agent_id = ? OR to_agent_id IS NULL)'); params.push(filters.to_agent_id); }
  if (filters?.from_agent_id) { conditions.push('from_agent_id = ?'); params.push(filters.from_agent_id); }

  if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY created_at DESC';

  const limit = filters?.limit ?? 100;
  sql += ' LIMIT ?';
  params.push(limit);

  return getDb().prepare(sql).all(...params) as AgentMessage[];
}
