# WaveCode

WaveCode is a server-side daemon + mobile-first PWA that orchestrates multiple CLI coding agents (Claude Code, Codex CLI, Aider) running in tmux sessions on a dedicated server. It provides a web UI for monitoring, task dispatch, artifact sharing, and code review — accessible from phone or desktop via Tailscale.

## Architecture

```
Phone/Desktop (PWA over Tailscale)
    │ HTTPS + SSE (live) + WS (terminal fallback)
    ▼
┌──────────────────────────────────────┐
│  WaveCode Orchestrator Daemon        │
│  - Hono web server + SSE + WS       │
│  - Session manager (adopt + spawn)   │
│  - Task dispatcher (DAG resolver)    │
│  - Artifact manager (immutable)      │
│  - Review queue                      │
│  - Event bus (SQLite → SSE)          │
│  - Health monitor + notifications    │
└──────────────────────────────────────┘
    │         │         │
 ADOPTED   SPAWNED   ADOPTED
 (capture) (runner)  (capture)
    │         │         │
 tmux-1    tmux-2    tmux-3
```

### Two operating modes:
- **Adopt mode**: Discovers existing tmux sessions, monitors via `tmux capture-pane` polling. Zero disruption to running agents.
- **Spawn mode**: Creates new tmux sessions with a runner wrapper that emits structured ndjson events. Full lifecycle management.

## Tech Stack

- **Runtime**: Node.js 22+ LTS, TypeScript (strict mode)
- **Web framework**: Hono (server) — lightweight, fast
- **Database**: SQLite via `better-sqlite3` (synchronous API, WAL mode)
- **Frontend**: React 19 + Tailwind CSS — built as static PWA
- **Live updates**: SSE (EventSource) for dashboard/tasks/review. WebSocket (`ws`) ONLY for terminal fallback.
- **Push notifications**: `web-push` npm package + ntfy.sh + Telegram Bot API
- **Runner wrapper**: Node.js `child_process` + ndjson event emitter
- **Terminal**: tmux (via `child_process.exec`)
- **Git**: `simple-git`
- **Config**: `js-yaml`
- **Process management**: systemd

## Project Structure

```
wavecode/
  CLAUDE.md
  package.json
  tsconfig.json
  src/
    server/
      index.ts              # Hono app, SSE endpoints, WS setup
      db.ts                 # Schema init, query helpers
      session-manager.ts    # tmux scan/adopt/spawn/kill
      output-watcher.ts     # capture-pane polling + regex matching
      runner.ts             # Runner wrapper for spawn mode
      task-dispatcher.ts    # DAG resolver, auto-chain
      artifact-manager.ts   # Copy, hash (sha256), store, index, thumbnails
      review-queue.ts       # Review state: pending → approved/rejected
      event-bus.ts          # Insert events, SSE broadcast
      health-monitor.ts     # Heartbeat/hang detection, auto-restart
      notifications.ts      # Web Push + ntfy + Telegram
    cli/
      index.ts              # CLI entry: scan, adopt, spawn, status, queue, send
    ui/
      src/
        App.tsx
        views/
          Dashboard.tsx     # Agent cards grid, SSE-driven
          TaskBoard.tsx     # Kanban: pending/running/done/failed
          ReviewQueue.tsx   # Completed runs, diff preview, promote/retry/reject
          AgentView.tsx     # Output tail, manual input, swipe between agents
          Artifacts.tsx     # Grid, upload/paste/photo, drag to agent/task
        hooks/
          useSSE.ts         # EventSource hook for live updates
          useApi.ts         # Fetch wrapper with auth
        components/
          AgentCard.tsx
          TaskCard.tsx
          ReviewItem.tsx
          ArtifactThumbnail.tsx
          StatusBadge.tsx
  scripts/
    install.sh
    wavecode.service        # systemd unit file
  docs/
    api.md                  # REST API reference
    release-hardening-spec.md  # Release checklist / hardening notes
```

## SQLite Schema

All state in one file (`wavecode.db`), WAL mode enabled on init.

```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  runtime TEXT NOT NULL,          -- 'claude-code' | 'codex' | 'aider'
  tmux_session TEXT NOT NULL,
  workspace TEXT,                 -- git worktree path (null for adopted without worktree)
  mode TEXT NOT NULL DEFAULT 'adopted',  -- 'adopted' | 'spawned'
  status TEXT NOT NULL DEFAULT 'idle',   -- 'idle' | 'working' | 'error'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES agents(id),
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'running' | 'done' | 'failed' | 'blocked'
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  depends_on_id TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on_id)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'running',  -- 'running' | 'done' | 'failed'
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  exit_code INTEGER,
  transcript_path TEXT,
  review_status TEXT NOT NULL DEFAULT 'pending'  -- 'pending' | 'approved' | 'rejected'
);

CREATE TABLE artifacts (
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

CREATE TABLE artifact_targets (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  target_type TEXT NOT NULL,  -- 'agent' | 'task' | 'broadcast'
  target_id TEXT
);

CREATE TABLE run_artifacts (
  run_id TEXT NOT NULL REFERENCES runs(id),
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  role TEXT NOT NULL  -- 'input' | 'output' | 'reference'
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,           -- 'run.started' | 'run.finished' | 'run.failed' | 'artifact.created' | ...
  entity_type TEXT NOT NULL,    -- 'agent' | 'task' | 'run' | 'artifact'
  entity_id TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## Key tmux Commands

```bash
# Scan existing sessions
tmux list-sessions -F "#{session_name}:#{session_created}:#{session_activity}"

# Adopt: start monitoring existing session
tmux capture-pane -t <session> -p -S -50  # last 50 lines

# Spawn: create new session with runner
tmux new-session -d -s wc-<agent-name> -c <worktree-path> "<runner-command>"

# Send prompt to agent
tmux send-keys -t <session> "<prompt-text>" Enter

# Kill session
tmux kill-session -t <session>

# Check if session exists
tmux has-session -t <session> 2>/dev/null
```

## Runner Events (ndjson via Unix socket)

Spawned agents emit these events. Adopted agents use capture-pane fallback.

```jsonl
{"type":"run.started","run_id":"...","task_id":"...","agent_id":"...","timestamp":"..."}
{"type":"heartbeat","run_id":"...","agent_id":"...","timestamp":"..."}
{"type":"run.finished","run_id":"...","exit_code":0,"duration_s":120,"changed_files":["src/auth.ts"]}
{"type":"run.failed","run_id":"...","error":"...","last_lines":["..."]}
{"type":"artifact.created","artifact_id":"...","filename":"...","sha256":"..."}
```

## Conventions

- **IDs**: Use `ulid` for all entity IDs (sortable, URL-safe).
- **Error handling**: Never throw from async handlers. Return typed result objects: `{ ok: true, data } | { ok: false, error }`.
- **Logging**: Use `pino` with structured JSON. Include entity IDs in log context.
- **File paths**: Always use `path.join()`. Never string concatenation for paths.
- **Config**: Load once at startup from `config.yaml` in the install root. Validate with a schema.
- **Tests**: Vitest. Test files co-located: `foo.ts` → `foo.test.ts`. Run with `npm test`.
- **Frontend state**: React `useState` + `useReducer` for local. SSE events drive updates — no polling.
- **CSS**: Tailwind utility classes only. No custom CSS files. Mobile-first responsive.
- **Naming**: camelCase for variables/functions, PascalCase for components/types, kebab-case for files.

## What NOT to Do

- Do NOT use external databases (Redis, Postgres, MongoDB). SQLite only.
- Do NOT use WebSocket for live data updates. Use SSE (EventSource). WebSocket is ONLY for optional terminal fallback.
- Do NOT manage agent context windows, prompt engineering, or conversation history. That is the CLI's job.
- Do NOT add API key authentication for the Anthropic/OpenAI APIs. Agents use CLI subscriptions.
- Do NOT use `localStorage` or `sessionStorage` in the PWA. Use React state.
- Do NOT create separate CSS files. Tailwind only.
- Do NOT implement git push functionality. The sandbox explicitly prevents it.
- Do NOT build a full terminal emulator (xterm.js) in v0.1. Captured output + manual send-keys is sufficient.

## Build Order (M0 first)

### M0: Adopt + Dashboard
1. `db.ts` — schema init, WAL mode, basic CRUD helpers
2. `session-manager.ts` — `scan()`, `adopt()`, `list()`, `kill()`
3. `output-watcher.ts` — capture-pane polling, regex status detection
4. `event-bus.ts` — insert events, SSE stream
5. `index.ts` — Hono server, REST API routes, SSE endpoint
6. `cli/index.ts` — `wavecode scan`, `wavecode adopt`, `wavecode status`
7. `ui/` — Dashboard with agent cards, SSE-driven live updates
8. PWA basics: manifest.json, responsive layout

### M1: Spawn + Tasks
9. `runner.ts` — runner wrapper, ndjson events
10. `task-dispatcher.ts` — DAG resolver, auto-chain
11. Task Board UI, Agent View UI

### M2: Artifacts + Review
12. `artifact-manager.ts` — copy-on-share, sha256, thumbnails
13. `review-queue.ts` — state machine
14. Review Queue UI, Artifacts browser UI

### M3: Mobile + Notifications
15. Service worker, Web Push
16. Swipe navigation, mobile artifact input
17. ntfy + Telegram integration

### M4: Hardening
18. `health-monitor.ts` — heartbeat timeouts, auto-restart
19. Sandbox enforcement scripts
20. Auth, systemd service, install script
