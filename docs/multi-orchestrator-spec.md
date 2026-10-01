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

## 4. UI

- **Presence strip** (Dashboard header): one chip per user with their color,
  online dot (an SSE connection authenticated as them within 60s), and
  count of agents they own.
- **Agent card**: owner badge in the owner's color; `RESERVE` on free
  agents, `RELEASE` on your own, lock icon with owner name on others'.
  Cards of others' agents remain clickable (read-only terminal; send box
  disabled with "reserved by Ana").
- **Filter bar**: *Mine · Free · Team* (persisted in React state only).
- **Task board**: swimlanes by owner; "delegate" picker lists only agents
  the current user may dispatch to (free or own).
- **Review queue**: shows owner; a developer sees promote enabled only on
  their own lane's runs; admin sees all.
- **Settings → Users** (admin): list, add (shows the token once), revoke.

## 5. Build order (one task each; each lands with tests)

| # | Task | Depends on |
|---|---|---|
| T1 | §1 identity: `users` table + migration v10, token hashing, auth middleware resolves user, `/api/me`, `/api/users`, CLI `user add`, `actor_id` on events | — |
| T2 | §2 leases: columns, reserve/release routes, rule 2 guards on send/kill/handoff/assign, auto-lease + release in dispatcher, expiry in health monitor, events | T1 |
| T3 | §3 MCP: user-aware tool results, `reserve_agent`/`release_agent`/`whoami`, admin-only guards | T2 |
| T4 | §4 UI: presence strip, owner badges, reserve/release, filter bar, swimlanes, users settings page | T2 |

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
