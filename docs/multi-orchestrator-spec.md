# Multi-orchestrator spec — users, tokens, and agent leases

**Goal:** several developers (and their MCP orchestrator seats) share one
WaveCode control plane. Each can take any *free* agent, assign it work, or
*reserve* it; nobody can interfere with an agent another person is using;
every action is attributed to a person. The review loop, kill switch, and
MCP tools are unchanged — they gain an actor.

Status: approved for implementation. Build order and acceptance are at the
bottom; each build task maps to one section.

## 1. Identity

### Schema (migration v10)

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,                 -- ulid
  name TEXT NOT NULL UNIQUE,           -- 'denis', 'ana', ...
  role TEXT NOT NULL DEFAULT 'developer',  -- 'admin' | 'developer' | 'observer'
  color TEXT NOT NULL,                 -- hex, shown in the UI
  token_hash TEXT NOT NULL UNIQUE,     -- sha256 of the bearer token; never store plaintext
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- `auth.fallback_token` keeps working and maps to a synthetic `admin` user
  named `owner` (so existing installs and the installer do not break).
- `createAuthMiddleware` resolves the bearer token to a user and sets
  `c.set('user', user)`. Unknown token → 401 as today.
- Roles: `admin` = everything incl. force-release and override-promote;
  `developer` = act on free agents and own agents, approve own lane;
  `observer` = read-only (GET + `await_events` + `list_*` MCP tools).

### API

| Route | Role | Purpose |
|---|---|---|
| `GET /api/me` | any | current user (id, name, role, color) |
| `GET /api/users` | any | list users (no token hashes) |
| `POST /api/users` `{name, role, color?}` | admin | create user; response includes the plaintext token **once** |
| `DELETE /api/users/:id` | admin | revoke (deletes row; its leases are released) |
| CLI `wavecode user add <name> [--role]` | local | same as POST, for bootstrap without a browser |

### Attribution

- `events` rows gain `actor_id TEXT` (nullable; null = system). `emit()`
  takes an optional actor and every route/MCP handler passes the current
  user. The existing `/api/events/log` and `await_events` include it.
- `tasks.created_by`, `goals.created_by`, `runs` are attributed through
  their task.

## 2. Agent leases

### Schema

```sql
ALTER TABLE agents ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE agents ADD COLUMN lease_expires_at TEXT;   -- null = no expiry while owned
ALTER TABLE agents ADD COLUMN lease_reason TEXT;       -- 'reserved' | 'task' | null
```

### Rules (enforced server-side, not advised)

1. **Free** (`owner_id IS NULL`): anyone may send prompts, assign tasks,
   reserve, kill.
2. **Owned**: only the owner or an admin may send prompts, assign/dispatch
   tasks to it, review-handoff to it, or kill it. Others get 403 with the
   owner's name in the error. Everyone may still *read* it (output,
   scrollback, docs) — transparency is the point.
3. **Auto-lease on dispatch**: when the dispatcher assigns a task to a free
   agent it sets `owner_id = task.created_by`, `lease_reason = 'task'`.
   The lease is released when the task reaches `done`/`failed` AND the
   agent is idle, unless the owner also holds an explicit reservation.
4. **Explicit reservation**: `POST /api/agents/:id/reserve {hours?}` sets
   `lease_reason = 'reserved'` and `lease_expires_at = now + hours`
   (default 4h, max 24h). `POST /api/agents/:id/release` clears it (owner
   or admin). `reserve` on an agent owned by someone else → 409.
5. **Expiry**: the health monitor's 30s tick releases leases whose
   `lease_expires_at` has passed *and* the agent is idle with no running
   task. Working agents are never yanked; the lease extends until idle.
6. **Dispatcher**: `findTaskForAgent` only matches a task to an agent that is
   free or owned by `task.created_by`. Tasks explicitly assigned to an agent
   someone else owns stay `pending` and surface a `task.waiting_for_agent`
   event with the owner's name.
7. **Stop-all** stays admin-only (it is the emergency brake for everyone).
   `kill` follows rule 2.

### Events

`agent.reserved {owner, until}`, `agent.released {by, reason}`,
`agent.lease_expired`, `task.waiting_for_agent {owner}`. All carry `actor_id`.

## 3. MCP

- The MCP server already takes a bearer token; it now acts as that user.
  No new tools needed for identity: `list_agents` returns `owner`, `lease`
  fields; `spawn_agent` leaves the new agent owned by the caller
  (`lease_reason='reserved'`, 4h) so a seat's freshly spawned agent is not
  grabbed by a teammate.
- New tools: `reserve_agent {agent, hours?}`, `release_agent {agent}`,
  `whoami`.
- `stop_all` and `promote_run` with `override_reason` are refused for
  non-admin tokens with a clear error.

## 4. UI — the Command Center

Design principle: **the message is the one primitive.** Everything an agent
produces that a person must see is normalized into one typed feed, and one
composer sends to anyone. No separate chat / terminal / task / review
screens to hop between — those become *filters* on the same feed.

### 4.1 Interpretation layer (server): `GET /api/thread`

A new read endpoint merges the existing tables into one ordered feed so the
UI never stitches five endpoints:

```
GET /api/thread?agent=<id|all>&owner=<id>&kinds=...&since=<cursor>&wait_ms=
→ { items: ThreadItem[], cursor }
```

`ThreadItem { id, at, kind, agent_id, actor_id, title, body, refs:{task_id?, run_id?, review_id?, artifact_id?}, needs_attention: bool, actions: Action[] }`

Kinds and their deterministic sources (no LLM involved):

| kind | source | needs_attention | actions |
|---|---|---|---|
| `prompt` | agent.prompt_sent (what a person sent) | no | — |
| `report` | `wavecode msg` / POST /api/messages type `result`/`info` | no | reply |
| `request` | messages type `request`, or agent output matching a question prompt (`?` + idle) | **yes** | reply, send file |
| `run` | run.started/phase/finished/failed + per-run RESULT line | failed/incomplete | retry, hand off, open log |
| `verdict` | review.ai_completed (verdict, issues, fix_round) | not pass | promote, override-promote (reason), send fixes, reject |
| `task` | task.created/dispatched/completed/blocked/waiting_for_agent | blocked/waiting | reassign, release agent |
| `alert` | agent.crashed/hung/lease_expired, system.stop_all | **yes** | restart, kill |
| `artifact` | artifact.created/shared | no | open, forward |

`actions` are the exact REST calls the UI may offer for that item (method,
path, body template) — the server decides what the current user is allowed
to do (owner/admin rules of §2), so the UI has zero permission logic.

Optional later: a cheap summarizer (Haiku/local) that adds a one-line
`summary` to long `report`/`run` bodies and sets `needs_attention` on
ambiguous output. Deterministic rules above ship first and remain the
source of truth.

### 4.2 Composer (one form, every destination)

```
[@target ▾] [mode: Prompt | Task | Reply | File] [model/effort ▾ when Task] [ text … ]  ⏎
```

- **Target**: an agent, `all`, a person, or a task thread. Resolved from the
  roster; shows the owner lock if you may not send (§2 rule 2).
- **Prompt** → `POST /api/agents/:id/send` (goes into the tmux session).
- **Task** → `POST /api/tasks` with `agent_id` (or unassigned = first free
  agent), optional `depends_on` picked from the board, model/effort pin if
  the agent has none.
- **Reply** → `POST /api/messages` with `to`, `ref_task_id` of the item
  being replied to — the message lands in the agent's thread *and* is
  injected into its tmux as `[from <user>] …` so adopted/CLI agents see it.
- **File** → artifact upload + share to the target (`handoff_file`).
- Slash commands in the text box map to the same actions: `/reserve 4h`,
  `/release`, `/kill`, `/review`, `/promote`, `/retry`.
- Enter sends; the composed item appears in the feed immediately as kind
  `prompt`/`task`/… with the actor's color.

### 4.3 Layout (desktop 3-pane; mobile = tabs over the same state)

```
┌ Presence: ● denis(3) ● ana(1) ○ marko ─────────────────────── [Stop all] ┐
│ ROSTER            │ THREAD  (agent: grok-fe ▾ | all)   [Attention ●4]  │ BOARD      │
│ Mine              │ 10:41 verdict  NEEDS FIXES (2 HIGH) [promote][fixes]│ swimlanes  │
│  ● grok-fe  work  │ 10:40 run      finished exit 0 · RESULT: PASS       │ by owner   │
│  ● claude-be idle │ 10:33 report   "auth middleware done, 14 tests"      │ ┌denis──┐  │
│ Free              │ 10:20 request  "which DB file for tokens?" [reply]   │ │T1 ✓   │  │
│  ○ codex-rev idle │ 10:02 prompt   you: "start T1 from the spec"         │ │T2 ▶   │  │
│ Team              │ ▸ terminal tail (folded, live)                       │ └───────┘  │
│  🔒 opus-fe (ana) │                                                      │ reviews: 2 │
│                   ├──────────────────────────────────────────────────────┤            │
│ [+ spawn]         │ [@grok-fe ▾][Prompt ▾][ type a message…         ] ⏎  │            │
└───────────────────┴──────────────────────────────────────────────────────┴────────────┘
```

- **Roster** (left): agents grouped *Mine · Free · Team*, owner color dot,
  status, current task title, lease countdown; `RESERVE`/`RELEASE` inline;
  click focuses the thread. Others' agents are readable, never writable.
- **Thread** (center): the merged feed for the focused agent or `all`,
  newest at the bottom, SSE-live via `/api/thread` cursor. Each item is a
  card with its `actions` as buttons. The **Attention** toggle filters to
  `needs_attention` items across all agents — this is the inbox.
  The terminal tail is a folded card at the bottom of the thread, not a
  separate screen.
- **Board** (right): task swimlanes by owner with dependency arrows,
  review-queue count, goal rollups. Drag a task onto a roster agent =
  assign (server validates ownership).
- **Mobile**: three tabs (Roster · Thread · Board) over the same state;
  the composer is sticky at the bottom of Thread. Attention count is a
  badge on the tab bar.
- **Settings → Users** (admin): list, add (shows the token once), revoke.

Implementation constraints: React state + SSE only (no polling, no browser
storage), Tailwind only, existing `useSSE`/`useApi` hooks, keep the current
views reachable until the Command Center replaces them as the default
route.

## 5. Build order (one task each; each lands with tests)

| # | Task | Depends on |
|---|---|---|
| T1 | §1 identity: `users` table + migration v10, token hashing, auth middleware resolves user, `/api/me`, `/api/users`, CLI `user add`, `actor_id` on events | — |
| T2 | §2 leases: columns, reserve/release routes, rule 2 guards on send/kill/handoff/assign, auto-lease + release in dispatcher, expiry in health monitor, events | T1 |
| T3 | §3 MCP: user-aware tool results, `reserve_agent`/`release_agent`/`whoami`, admin-only guards | T2 |
| T4 | §4.1 `GET /api/thread`: merged, typed, cursor-paged feed with per-user `actions`; `needs_attention` rules; reply injection into tmux | T2 |
| T5 | §4.2–4.3 Command Center UI: roster, thread, composer, board, presence, attention filter, mobile tabs, users settings page | T4 |

## 6. Acceptance

- Two tokens, two users: user B gets 403 sending a prompt to an agent
  dispatched for user A's task; B can still read its output.
- A reserves `grok-fe` for 1h; B's task assigned to `grok-fe` stays pending
  with `task.waiting_for_agent`; after A releases, B's task dispatches
  within one dispatcher cycle.
- An expired reservation on an idle agent is released by the monitor
  within 60s; on a working agent it is not.
- Every event in `/api/events/log` written through a route or MCP call has
  the correct `actor_id`.
- Observer tokens get 403 on every mutating route and MCP tool.
- `auth.fallback_token` still authenticates as admin `owner`; all existing
  tests pass unchanged except where they assert the old anonymous shape.
