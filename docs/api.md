# WaveCode API Reference

Base URL: `http://<host>:3777/api`

## Authentication

### `GET /api/auth/status`
Public endpoint that returns the configured auth mode and whether token auth is properly configured.

### `GET /api/auth/verify`
Protected endpoint that returns `{ ok: true }` when the current request is authenticated.

### Auth modes

- `tailscale`: requests are allowed only from private or tailnet IPs. Forwarded headers are used only when the direct peer is in `auth.trusted_proxies`.
- `token`: requests must provide `Authorization: Bearer <token>`.
- `fallback_token`: when configured, the bearer token also works in `tailscale` mode.

### Users and roles

Every authenticated request resolves to a user (see `docs/multi-orchestrator-spec.md` §1):

- `auth.fallback_token` → the synthetic admin `owner` (not stored in `users`).
- A token created via `POST /api/users` or `wavecode user add` → that user. Only the sha256 of the token is stored.
- In `tailscale` mode, a tailnet client without a user token is `owner`.
- Unknown token in `token` mode → `401`.

Roles: `admin` (everything), `developer` (act on agents), `observer` (read-only: any non-GET `/api/*` request → `403`).

Events written while a request is in flight record the caller as `actor_id` (null = system); `/api/events/log` and SSE payloads (`actorId`) include it.

### `GET /api/me`
Current user: `{ id, name, role, color }`.

### `GET /api/users`
All users (synthetic `owner` first) as `{ id, name, role, color, created_at }`. Token hashes are never returned.

### `POST /api/users` (admin)
Body `{ name, role?, color? }` — `name` is `[a-z0-9_-]{1,32}` (`owner`, `system`, `all` are reserved), `role` defaults to `developer`, `color` is `#rrggbb` (derived from the name if omitted). Returns `201` with the user plus `token` — the plaintext bearer token, shown **once**. `409` on a duplicate name.

CLI equivalent (local, no daemon needed): `wavecode user add <name> [--role admin|developer|observer] [--color #rrggbb]`.

### `DELETE /api/users/:id` (admin)
Revokes the user (deletes the row; its token stops working). `owner` and your own user cannot be revoked.

## Agents

### `GET /api/agents`
List managed agents with watch status and the last captured output line.

### `GET /api/agents/:id`
Get one agent by ID or name.

### `POST /api/agents/scan`
Discover tmux sessions on the server. Optional body `{ socket?: string }` lists
that tmux server (`-L`). Omitted uses the default server.

### `POST /api/agents/adopt`
Adopt an existing tmux session.

Body:
`{ sessionName: string, runtime: "claude-code" | "codex" | "aider", name?: string, tmux_socket?: string }`

`tmux_socket` is the tmux server (`-L`) that session runs on. `PATCH /api/agents/:id`
accepts `tmux_socket` (null clears it). Every later tmux call for that agent uses
`-L`. Unset stays the default server. CLI: `wavecode scan --socket <name>`,
`wavecode adopt <session> --socket <name>`.

### `POST /api/agents/spawn`
Spawn a managed agent and optional git worktree. `model`/`effort` pin the
agent's LLM: recorded on the agent, injected into the runtime command via the
runtime's `model_flag`/`effort_flag`. Effort is one of `low|medium|high|xhigh`.

`runner: "file"` (Claude only) creates a file-runner seat (`mode: file`):
no tmux session, no send-keys, no capture-pane. Tasks on that seat start
`claude -p` in the worktree, wait for leftover work (process-group
descendants, worktree npm/vitest/node/docker/postgres children, or
`cli.log` / `last_line` saying tests are still running), then read
`result.txt` (source of truth when present) or an exact RESULT line from
`cli.log`. The run stays `running` (`waiting for tests`) while that work
is in flight. A clean Claude exit with no leftover work and no parseable
RESULT is `incomplete`, not a synthesized product `RESULT: FAIL`.
Default is the existing tmux seat.

Body:
`{ name: string, runtime: string, repo?: string, branch?: string, model?: string, effort?: string, runner?: "tmux" | "file" }`

### `PATCH /api/agents/:id`
Update an agent's model/effort pin. `null` clears a pin; omitted fields are
unchanged. Applies on the agent's next (re)launch. Emits `agent.updated`.

Body:
`{ model?: string | null, effort?: string | null }`

### `POST /api/agents/:id/kill`
Kill a spawned agent: stop its runner, terminate the tmux session, remove the
record. Returns 400 for adopted agents (detach those instead). Emits
`agent.killed`.

### Agent leases (spec §2)

An agent is **free** (`owner_id: null`) or **owned** by one user. `GET /api/agents` rows include `owner` (name), `owner_id`, `lease_reason` (`reserved` | `task`), `lease_expires_at`.

- Owned agents: only the owner or an admin may `send`, `kill`, detach (`DELETE`), or be a review `handoff` target. Others get `403 {"error":"Agent <name> is owned by <owner>"}`. Reads stay open to everyone.
- Dispatch only matches a task to a free agent or one owned by the task's creator (`tasks.created_by`). Dispatching to a free agent leases it to the creator (`lease_reason: task`) until the run ends and the agent is idle.
- A task queued with `agent_id` of an agent someone else owns is accepted (`201`, response includes `waiting_for_agent: {owner}`), stays `pending`, and emits `task.waiting_for_agent` once per owner.
- The health monitor (30s) releases expired reservations on idle agents (`agent.lease_expired`); working agents keep the lease until idle.
- Revoking a user releases their leases.

`GET /api/agents` and `/api/agents/:id` also return `lease` (`{owner, owner_id, reason, expires_at}` or null) and `can_act` — whether the *caller* may act on the agent. `POST /api/agents/spawn` accepts `reserve_hours` (MCP `spawn_agent` sends 4) to reserve the new agent for the caller.

`POST /api/reviews/:runId/promote` with `overrideReason` is admin-only (`403` otherwise).

### `POST /api/agents/:id/reserve`
Body `{ hours? }` — default 4, max 24. Reserving your own agent extends it; an agent owned by someone else → `409`. Emits `agent.reserved {owner, until}`.

### `POST /api/agents/:id/release`
Owner or admin (`403` otherwise). Emits `agent.released {by, reason}`.

### `POST /api/agents/:id/send`
Send text or a raw tmux key sequence to an agent. This is prompt-only —
it does **not** create a task or run. CLI `wavecode send` instead POSTs
`/api/tasks` with `agent_id` so the daemon records and dispatches a run.

Body:
`{ text: string, raw?: boolean }`

### `GET /api/agents/:id/output`
Get recent output for an agent.

Query:
`lines`, `ansi`

### `GET /api/agents/:id/terminal`
The live terminal view. As a plain GET: `{ enabled, session, cols, rows, history_size, cursor_x, cursor_y, viewers }`
(`enabled: false` when `terminal_stream.enabled` is off). As a WebSocket upgrade of the same URL
(token in `access_token` like `/api/events`): text frames are JSON control messages
(`{ t: 'init', session, cols, rows, history_size }`, `{ t: 'error', message }`), binary frames are the
pane's bytes — first the current pane (history + screen with escapes, cursor restored), then live output from
`tmux pipe-pane`. Alternate-screen and mouse-tracking switches are removed so the viewer keeps scrollback and
its own scrolling. Read-only: client frames are ignored; prompts go through `POST /api/agents/:id/send`.
This is WaveCode's only WebSocket; everything else is SSE. The PWA shows it on the agent page (Live terminal tab)
and as the whole viewport at `/agent/:id/terminal` (fit: screen or width, with a one-line composer that posts to `/send`).

### `GET /api/agents/:id/scrollback`
Get a scrollback window and total buffer size.

Query:
`start`, `end`

### `DELETE /api/agents/:id`
Detach an agent: stop its runner and remove the record, leaving the tmux
session running.

## System

### `POST /api/system/stop-all` (admin)
Emergency stop: kill every spawned agent, send Ctrl+C to adopted ones, and
disable `autonomy.auto_dispatch`. Returns
`{ ok, killed: string[], interrupted: string[], errors, auto_dispatch_disabled: true }`.
Emits `system.stop_all`.

## Prompt enhancement

### `GET /api/enhance/status`
Returns `{ available: boolean }`.

### `POST /api/enhance`
Enhance a prompt before sending it to an agent.

Body:
`{ prompt: string, agentId: string }`

## Settings

### `GET /api/settings`
Return server, auth, runtime, notification, artifact, and LLM settings safe for UI display.

### `PUT /api/settings`
Update a safe subset of settings. Auth, sandbox, and runtime definitions are not writable through this route.

### `PUT /api/settings/api-key`
Update the configured LLM API key for the selected provider.

Body:
`{ key: string, provider?: "anthropic" | "openai-compatible" }`

## Command chat

### `POST /api/chat/send`
Send a message through the command chat orchestrator.

Body:
`{ message: string }`

### `GET /api/chat/history`
Return recent chat messages in chronological order.

### `DELETE /api/chat/history`
Clear chat history.

## Teams

### `GET /api/teams`
List teams and their members.

### `POST /api/teams`
Create a team.

Body:
`{ name: string, description?: string }`

### `POST /api/teams/:id/members`
Add or update a team member.

Body:
`{ agent_id: string, role?: string }`

### `GET /api/teams/:id/messages`
List persisted team messages.

## Tasks

### `GET /api/health`
Authenticated. Event-loop delay from `perf_hooks.monitorEventLoopDelay`, sampled every 5 s:

- `event_loop.p99_ms`
- `event_loop.max_ms`

A sample whose max exceeds 200 ms logs `Event loop lag`. Settings → Health shows the same numbers. Static `/` and `index.html` do not wait on this.

### `GET /api/agents/:id/models` · `POST /api/agents/:id/model`
Change the model an agent runs on from the UI (the MODEL button on the agent page).

`GET …/models` lists what that agent's CLI can use: Codex reads its own
`models_cache.json` on the agent's profile (id, label, efforts); Claude Code
lists the configured `runtimes.claude-code.models` or the built-in Claude ids.
`free_text: true` means no list is known and the UI offers a text box.

`POST …/model` `{ model, effort }` (owner or admin) stores the pin and makes it
take effect: Claude Code receives `/model <id>` live; Codex is asked to `/quit`
and relaunched with `-m` and the effort, resuming its conversation; an agent
that is working gets the change when it next goes idle (`agent.model_applied`
reports the outcome); a dead runtime gets it on relaunch. Response:
`{ agent, applied: live | relaunched | when_idle | on_relaunch | pin_only, note }`.

Every agent row also carries `live_model` (what the CLI's own footer says it
runs — Codex prints `GPT-6-Astra high`; Claude Code prints nothing, so null)
and `model_mismatch` (a pin exists and the footer disagrees). A guard runs
every minute: an idle agent with a mismatch gets its pin reapplied (someone
typed `/model`, or the daemon restarted while a change was pending), once per
ten minutes per agent; `agent.model_applied` with `reason: guard` records it.
An agent with no pin follows the CLI's own settings on its profile, which
`/model` in the pane rewrites — pin the ones that must stay put.

### `GET /api/agents/:id/output?mode=split&lines=N`
The agent page's terminal buffer. Returns `{ history, screen, history_size, rows }`:
`history` is the last `N` lines of the frozen scrollback above the visible
screen (tmux lines `-N..-1`), `screen` the visible screen (`0..rows-1`), each
as `{ t: text, h: html }` per line. The page keeps an append-only copy of the
history (merging each capture by overlap, marking gaps when more scrolled by
than one capture holds, capped at 4,000 lines), renders the screen separately
below it, follows the live end only while the reader is at the bottom and
shows "↓ N new lines" otherwise. `GET …/scrollback?start=&end=` now also
returns `lines` per line for loading older history with the viewport kept in place.

### `GET /api/tests/status` · `POST /api/tests/status/refresh`
The Tests page: the daemon's copy of the countix-testing status portal
(`GET /api/status`, schema 1; tailnet-only, no CORS, so the daemon fetches it).
Configure `test_portal: { url: http://countix-testing.tailf32df0.ts.net:8088, poll_s: 20 }`
in config.yaml; unset hides the page's content.

Response: `{ enabled, host, doc, fetched_at, error, next_in_s, schema_ok }` where
`doc` is the portal document (queue, runs, runners, results, scaler, alerts)
with unknown fields dropped. The poller runs every `poll_s` (default 20 s) and
backs off 20 → 60 → 120 s while the portal is unreachable, keeping the last
document and the error. `tests.portal` is emitted only on a material change
(queue, active runs, runner health or state, alerts, newest results, scaler),
never for elapsed time ticking; the page animates elapsed time from
`started_at`. Submitter labels `wave.<box>.<agent>` link to the WaveCode agent.
`POST …/refresh` polls once now (any signed-in user).

Portal commit 5093352 (additive, schema still 1) is understood: a run's
`median_s` (typical duration of that kind) is the bar's scale and `pace`
(`amber` past 1.5×, `red` past 2.5×) its colour, falling back to the fixed
`expected_s` budget; runners show `server_type` (the real Hetzner type) and
`role`, `not probed` health, and the main server's slot rows with the agent
and SHA they carry; the `countix-testing` gateway summary row is not listed
as a runner. A pace change counts as a material change for `tests.portal`.

### `GET /api/health/perf`
Admin only. What the daemon spends its time on, for Settings → Health:

- `loop_ms` — event-loop delay over the last minute (`p50`, `p99`, `max`, `mean`); `lag_threshold_ms` (500) is where the board calls it lagging and `perf.lag` is emitted (at most every 5 minutes).
- `last_minute` / `last_15_min` — child processes forked, by command (`git merge-base`, `tmux capture-pane`, …), how many ran synchronously and how long they blocked the loop (`sync_blocked_ms`).
- `jobs` — last and max duration of the background passes: `deploy_reconcile`, `overview_reconcile`, `lane_board`, `event_prune`.
- `storage` — row counts (`events`, `events_short_lived`, `freezes`, `tasks`, `runs`) and `db_bytes`.
- `cpu_pct`, `rss_mb`, `uptime_s`.

Event retention (`events:` in config.yaml, event-retention.ts): `short_lived_types` (default `agent.output_updated`, `queue.empty`) are kept `short_hours` (24); everything else `retention_days` (90). One pass 30 s after start, then every 6 hours; `events.pruned` reports what was dropped.

### `GET /api/tasks`
List tasks.

Query:
`status`, `agent_id`, and optionally `limit` (≤ 500) with `offset`. With
`limit` the list is newest first (a page of the Done or Failed column);
without it the order is priority, then oldest first (the queue).

Each task carries `dependencies`, `dependents`, `run_phase`, `result`,
`result_reason` and a slim `latest_run` (`id`, `status`, `attempt`,
`agent_id`, `started_at`, `finished_at`, `exit_code`, `review_status`,
`result`, `result_reason`, `phase`, `last_line`). The run's `summary`, log
and paths are on `GET /api/runs/:id` and `GET /api/tasks/:id`, not in the list.

### `GET /api/tasks/board`
The Tasks page in one round trip:

```json
{
  "counts": { "pending": 2, "running": 1, "done": 181, "failed": 3, "blocked": 0 },
  "active": [ "…every pending, blocked and running task…" ],
  "done":   [ "…newest 25 (query done=N for more)…" ],
  "failed": [ "…newest 25 (query failed=N for more)…" ],
  "page_size": 25,
  "has_more": { "done": true, "failed": false }
}
```

The page shows the real totals from `counts` and asks for a bigger page
with `?done=50` as the person presses "show more"; the whole history is
never shipped to the browser.

**Local status CLI (no LLM poll):** on the daemon host, `wavecode status`
GETs this list plus `GET /api/agents` and `GET /api/runs/:id` (same
`presentFileRun` fields, same config.yaml token as `wavecode queue`)
and prints a compact JSON snapshot of file-runner work: running tasks,
in-flight or just-finished runs (`phase`, `last_line`, `result.txt`
last line `RESULT: PASS|FAIL` or missing), and seats such as
`wavepulse-fable-file` / `wavepulse-opus-file` (`idle`/`working`).
It does not scrape tmux. Missing `result.txt` is reported as missing —
WaveCode does not invent `RESULT: FAIL`.

Orchestrators (Grok Bot / CountixDev) should run this locally instead
of waking an LLM to poll `/api/tasks` and `result.txt`. Cron every
minute on the VPS:

```bash
wavecode status --notify-if-changed
```

That command always exits 0. It writes
`<data-dir>/status-stamp.json` (sibling of `transcripts_root`, typically
`~/.wavecode/.wavecode-data/status-stamp.json`) and prints **nothing**
when the snapshot is unchanged, so cron stays quiet. On a material
change only it prints a delta JSON and, if ntfy/Telegram/Web Push are
already configured, emits the same one-line notify. Material changes:

- a parseable `RESULT: PASS` or `RESULT: FAIL` last line appearing
- phase becoming `done`, `failed`, or `incomplete`
- in-flight with no `result.txt` for 40 minutes (`STALE`)

Grok Bot should wake only when that stamp reports a RESULT or STALE
line. `wavecode status --watch` is the same loop in the foreground.
Use `wavecode agents` for the human-readable seat table.

### `GET /api/tasks/:id`
Get one task with dependency and run context. Each run includes
`result_path`, `result` (`PASS` | `FAIL` | `null`), `result_reason`, and
`result_last_line` from the parseable per-run result file. File-runner runs
also include `phase` (`queued` | `starting` | `running` | `done` | `failed` | `incomplete`),
`log_path`, `last_line`, and `prompt_path`. `GET /api/tasks` includes
`run_phase` / `result` from the latest run so the board can show those
phases without a screenshot. `null` result means missing or unparseable —
that is not PASS, and for a file-runner clean exit with no leftover
work it is `incomplete` (wrapper state) rather than a product
`RESULT: FAIL`. File-runner stays `running` (`waiting for tests`)
while leftover work is in flight. Do not infer success from idle,
pane scrape, or duration.

### `GET /api/runs/:id`
One run plus file-runner card fields: `phase`, `result`, `log` (`cli.log`),
`prompt_path`, `status_path`. Tmux runs still return the result-file fields;
`phase` is null when there is no `status.json`.

### `GET /api/runs/:id/log`
Return `{ run_id, path, log }` for `runs/<run_id>/cli.log`.

### `GET /api/runs/:id/result`
Read the orchestrate result file for a run.

Response:
`{ run_id, path, exists, result, reason, last_line, phase, log_path, prompt_path }`

`result` is `PASS`, `FAIL`, or `null`. The file is
`<data-dir>/runs/<run_id>/result.txt` (overwrite once, capped) and the
source of truth; this endpoint is a convenience. Last line must be
exactly `RESULT: PASS` or `RESULT: FAIL`. Missing or unparseable is not
PASS. This is the run/orchestrate signal, not the promote gate (referee
/ wavepulse-gate RESULT stays the promote evidence).

### `POST /api/tasks`
Create a task. When `autonomy.auto_dispatch` is on, the daemon dispatches
the next run unless `hold` is true. CLI `wavecode queue` / `wavecode send`
and MCP `create_task` all use this endpoint so the daemon owns the runner
lifecycle.

Body:
`{ prompt: string, agent_id?: string, priority?: number, depends_on?: string[], goal_id?: string, hold?: boolean }`

`agent_id` is an agent ULID or the name `GET /api/agents` / `list_agents`
exposes (same lookup as `GET /api/agents/:id`). The name is resolved to
that existing seat before the task is queued — this does not spawn a
new agent. Unknown names return 400.

`goal_id` is a parent goal ULID or `external_id` (e.g. `W0`, `G1`).
Persist-only goals create no tasks — attach children yourself with this
field. If `auto_dispatch` is on and you omit both `hold` and `agent_id`,
an idle agent may pick up the unassigned pending task.

### `POST /api/tasks/:id/retry`
Reset a failed or done task to `pending`.

### `GET /api/tasks/:id/runs`
List runs for a task.

### `POST /api/dispatch`
Manually dispatch queued work, even when `autonomy.auto_dispatch` is disabled.

## Goals

A goal is a persisted parent row for an LLM-decomposed task DAG. Child
tasks store `goal_id`. Standalone tasks (no goal) still work.

### `GET /api/goals`
List goals with child-task rollup counts
(`pending` / `running` / `done` / `failed` / `blocked` / `total`).

### `GET /api/goals/:id`
Get one goal by ULID or `external_id` (e.g. `F-16`), plus child tasks
and the same rollup.

### `POST /api/goals`
Persist a goal and emit `goal.created`.

Default: LLM-decompose into child tasks with `depends_on`, then
`dispatchNext`.

`decompose: false` or `persist_only: true`: insert the goal row only
(title, workspace, `external_id`). No LLM call, no child tasks, no
dispatch. Use this to seed a board (`W0`, `G1`) before assigning work.

Body:
`{ goal?: string, title?: string, workspace?: string, external_id?: string, decompose?: boolean, persist_only?: boolean }`

`goal` is required unless persist-only (then `title` or `goal` is required).
`external_id` is an optional outside label (`F-16`, `G1`) — not an import
from another tracker.

### `POST /api/goals/preview`
Decompose a goal without writing rows.

Body:
`{ goal: string }`

## Decisions And Briefings

### `GET /api/decisions`
List decisions, optionally filtered by workspace.

### `POST /api/decisions`
Persist a decision for a workspace.

Body:
`{ workspace: string, summary: string, detail?: string, source_agent_id?: string, source_run_id?: string }`

### `DELETE /api/decisions/:id`
Delete a decision by ID.

### `GET /api/briefing/preview`
Preview the auto-generated workspace briefing for an agent.

Query:
`agent_id`

## Product Desk

The Countix request board (docs/PRODUCT_DESK_AGENT_PROTOCOL.md in wavepulse) read into WaveCode
with the per-server dev-lane token — a curl config owned by the service user, read per call,
never logged. Off unless configured:

```yaml
product_desk:
  enabled: true
  url: https://countix.ai/api/product-desk
  token_file: ~/.config/countix-desk/curl.conf   # header = "Authorization: Bearer …"
  poll_min: 5
  project: wavepulse                             # room for tasks created from requests
```

- `GET /api/desk?all=1&refresh=1` → `{ enabled, items, state }`. Open statuses by default
  (`new`, `accepted`, `implementing`, `waiting_on_requester`, `in_review`); each item carries
  `links`: the lanes frozen for that desk number and the WaveCode tasks that carry `[desk <id>]`,
  `PD-<id>` or `Desk #<id>`. Cached `poll_min` minutes and refreshed in the background; a desk
  error keeps the last good read and reports it in `state.error`.
- `GET /api/desk/:id` — the card: request (with `candidate_sha`, staff `note`), messages, events,
  file metadata, links.
- `GET /api/desk/files/:fileId` — one retained original streamed to a person, stored nowhere,
  recorded as `desk.file_viewed` with the viewer. Restricted (peer) tokens get 403 on every desk route.
- `POST /api/desk/:id/task` `{ agent_id, note?, reviewer? }` — hand the request to an agent: a
  WaveCode task whose prompt starts with `[desk <id>] <title>` and carries the request text, the
  staff note and the attachment list (the agent fetches originals itself per the protocol; nothing
  is copied into WaveCode). 409 while a task for that desk is open.
- The Tasks page shows the desk above the kanban (open requests, what WaveCode has for each, hand-to-agent);
  the board carries the open requests for the overlord, which proposes unstarted ones when asked what to pick up.

## Profiles and self-service agents

- `GET /api/profiles` → per profile: `name`, `shared`, `public`, `mine`, `can_login`, and per runtime
  `{ logged_in, subscription: { account, plan } | null, login_seat: { agent_id, session } | null, agents }`.
  Credential contents and paths are never returned.
- `POST /api/profiles/:name/login` `{ runtime }` — opens a login seat (an adopted agent running the
  CLI's login command on that profile, 15 minutes at most); Settings → Profiles shows its pane so the
  device code or URL is visible, and `profile.login_finished` reports whether a credential appeared.
- `POST /api/agents/spawn` — a developer spawns on their own profile (the subscription link); the
  dialog on the Agents page lists the configured CLIs, the projects (base clone → worktree and
  branch `wc-<name>`), the login state and account of the profile for that CLI, and refuses while
  the profile is not logged in. `spawn.max_per_user` (config) caps a non-admin profile's agents
  (429 beyond it). `GET /api/settings` now also returns `projects: [{ name, repo }]` and `spawn`.

## Overview and the overlord

The board (`src/server/overview.ts`) is computed from the database alone — nobody asks an
agent anything: per agent the status and how long, the running task, the last reply, what it is
blocked on (peer answer, review pending, needs reviewer, hung, crashed), plan usage; per reviewed
lane the exact SHA, verdict, gate, what is on staging and in production, whether it is promotable
and the deterministic next step; plus an attention list.

The overlord (`src/server/overlord.ts`) is a coordinator on a token-based model (default
`claude-sonnet-5-5`, the one deliberate API-key exception to the "agents use CLI subscriptions"
rule). It wakes on board-changing events (`run.finished`, `review.ai_completed`,
`review.superseded`, `release.reported`, `agent.hung`, …) and on a heartbeat; wakes are debounced
and capped per hour. Each wake it writes a report — one line per agent, recommendations
(`promote | stage | reject | nudge | reassign | refreeze | info`), a release plan (groups of lanes
that go out together, in order, with target `staging | production | hold` and why — lanes that
touch the same area or depend on each other ship together, independent ones separately, risky
ones last and alone) and a digest — stored, emitted as
`overlord.report`, posted as a thread item whose recommendations are buttons, and sent as a
notification when the digest changed. It never promotes, stages or types into an agent by itself.

It is off unless `overlord.enabled: true`, and nothing waits on it: a lane, a review or a merge
queue step goes on exactly the same without it (the seat agents do the reviews; the overlord
only writes reports). With `enabled: false` events and the heartbeat do not wake it; a manual
`POST /api/overview/wake` with `force: true` still does. Since 26 Oct 2026 it is off on
countix-dev (its model calls were hitting the key's usage limit).

```yaml
llm:
  anthropic_api_key: sk-ant-…        # or ANTHROPIC_API_KEY in the service environment
  anthropic_workspace_id: wrkspc_…   # only for a key that is not scoped to a workspace (the API then demands the header)
overlord:
  enabled: false                     # default; true only when the key has headroom
  model: claude-sonnet-5-5
  heartbeat_min: 30
  max_wakes_per_hour: 12
  debounce_s: 45
  notify: true
  auto_stage: false   # true = the overlord stages every reviewed PASS lane itself (in its own name); production never
```

The board also carries **open fixes** (a lane whose latest verdict is NEEDS FIXES, a failed
release, a recent rejection) with the task queued for it, if any — a fix task carries
`[fix <sha8>]` in its prompt, so nothing stays open without a name next to it — and each agent's
**budget** (weekly and 5-hour % left from the usage probe), which the overlord uses when it
proposes who takes a fix (author first if idle with budget, else the idle agent on the same
runtime with the most weekly budget; never below 10%).

- `GET /api/overview` → `{ board, report, overlord: { enabled, model, heartbeat_min, max_wakes_per_hour } }`
- `GET /api/overview/chat`, `POST /api/overview/chat` `{ message }` — talk to the overlord; it answers
  from the board, history is kept and sent back to it. Not subject to the wake cap. An answer carries
  `actions` the person can press — `send` (the exact prompt for an agent, resolved to its id),
  `assign_fix`, `stage` / `promote` / `reject` (a run), `verify` (a sha) — rendered as buttons under
  the answer; nothing runs until pressed, and a send goes through `POST /api/agents/:id/send` like any
  prompt from that person.
- `POST /api/overview/fixes/assign` `{ run_id, agent_id, note? }` — queue a fix task
  (`[fix <sha8>] …` with the verdict and freeze note paths, reviewer preset to the lane's reviewer)
  for that agent; 409 while a fix task for the SHA is open. The thread's "Assign fix" button and
  the overlord's `fix` recommendations call this.
- `GET /api/overview/reports?limit=` — past reports, newest first.
- `POST /api/overview/wake` `{ force? }` — admin: ask now (the hourly cap still applies unless `force`).

## Releases

Releases are records, not chat (`src/server/releases.ts`). A person presses **Stage** (automated
staging deploy, no GO) or **Promote** (the production GO) on a freeze card or in the Release
view; the daemon posts a release request to the project's `release_peer` box. Production is
handed to the deploy agent (`releases.deploy_agent`) as one prompt. Staging does the same
unless `releases.staging_command` is set, in which case the deploy box runs that argv and
streams progress onto the release record. A hands-free pipeline
(`projects.<name>.pipeline`, every switch default off) can freeze, queue one full gate,
assign a reviewer, and request staging with `requested_by: auto`. It never sends a
production request. Staging is one lane at a time until Ready for prod or the pin expires.
The requester mirrors `release.*`, so `/release`
shows what is on staging and in production per lane. The STAGE control becomes a live phase
chip (queued → lock → fetch → build → verify → pin) and, on success, "On staging".
The dashboard shows `staging: <sha> v<version>` from the newest deployed staging record.

Staging never moves backwards. Every staging path (Stage, auto-stage, a candidate, and a
peer `POST /api/releases`) refuses unless the requested SHA contains the SHA now on staging
(`git merge-base --is-ancestor`) and contains current `origin/main`. The refusal is
`would roll staging back: <sha> is missing <N> commits now on staging (<version, lane>)`.
`force_rollback: true` plus a `force_reason` is admin-only, skips only the staging-ancestor
check, and is audited as `rollback` (ops are notified). The normal Stage button never sends
it. A requested or sent staging row that no longer contains the new staging SHA is marked
`rejected` with that reason. Optional `releases.staging_health_command` (argv, `{project}`)
prints the live SHA; on the box that serves the release, that SHA wins over the deployed record.
A box that forwards the project's releases (`projects.<p>.release_peer`, the same peer
`requestRelease` posts to) never treats its own row or health command as the tip: it proxies
the peer. Off unless set.

A freeze note may declare operational prerequisites in a fenced YAML block (not CURRENT.md
prose). A candidate's list is the union of the freeze notes whose SHAs it contains;
duplicate ids keep the earliest order. Promote refuses while a check fails, or when a
declared id has no command (`prereq <id> has no check`). Stage is not blocked; the card
shows the failing id and output. The production prompt lists the steps in order, operational
steps first and `code_deploy` last unless a `kind: code` step says otherwise, and tells the
deploy agent to stop on the first failure and leave the previous state live. `failed_step`
on the report is stored and shown in the audit (`prereq` when a check refuses the GO).

```yaml
prereqs:
  - id: db_roles_applied
    order: 10
  - id: prod_owner_count>=2
    order: 20
  - id: code_deploy
    order: 100
    kind: code
```

```yaml
projects:
  demo:
    prereq_checks:
      db_roles_applied:
        command: [check-roles, '{sha}']
      "prod_owner_count>=2":
        command: [preflight, '{sha}']
        type: ndjson
        field: prod_owner_count
        compare: '>='
        value: 2
releases:
  staging_health_command: [staging-health, '{project}']  # optional
```

`type: ndjson` reads the last JSON line that has `field` and compares it. A non-zero exit
fails even when the field is present. No `prereqs:` block means today's Promote.

When main moves, staging moves past a lane, or Stage is refused for being behind, the
lane's author gets one plain message (the seat inbox, on that agent's tmux socket when
`tmux_socket` is set): merge `origin/main`, fix conflicts, run the quick check, write the
freeze note. If `auto_merge_main` already merged it cleanly, the message says so and that
a quick check is running. One alert per lane per main SHA; it repeats after 30 minutes
only while the lane is still behind and has no PASS on a SHA that contains that main.

An agent may set `tmux_socket` (adopt, `PATCH /api/agents/:id`, scan, CLI `--socket`).
Every tmux call for that agent then uses `-L <socket>`. Unset stays the default server.

Record fields: `id, project, sha, lane, target ('staging'|'production'), desk, reviewer,
requested_by, origin ('local'|'peer'), peer, peer_request_id, origin_id, run_id,
deploy_agent_id, status ('requested'|'sent'|'deployed'|'failed'|'rejected'), version,
deployed_sha, report, error, deploy_id, progress_phase, progress_status, pin_until,
staging_url, rollback_status, rollback_to, created_at, updated_at, reported_at`.

- `GET /api/releases?project=&sha=&target=&status=&limit=` — newest first.
- `GET /api/releases/staging-tip?project=` — `{ sha, version, lane, source }` where `source` is `peer`, `health`, or `local`. `sha` is null when the tip is unknown. A forwarding box proxies its release peer with `local=1` (4s timeout) and always reports `source: peer` (the local deployed row is not used). A request with `local=1` or `X-WaveCode-Proxied: 1` answers from this box only: health command, then the deployed row, and does not proxy. A failed ask is cached 5s; a peer answer is cached 15s. The deploy box reports `health` when `staging_health_command` prints a SHA, otherwise `local`. Authenticated; a restricted peer token may GET it. `GET /api/settings` includes `staging_tips`: one `{ project, source, sha, peer }` per project, refreshed at startup and every minute.
- `GET /api/releases/:id`
- `POST /api/reviews/:runId/stage` — stage a freeze card. A developer needs the reviewer's PASS on that exact SHA (403 `Stage needs the reviewer's PASS on this exact SHA` otherwise). An admin may stage without it. A freeze already inside a composed candidate the deploy agent has deployed to staging may be staged without that PASS. Never a stale SHA. 202 with the record.
- `POST /api/reviews/:runId/promote` approves the review for a developer or an admin. The production
  request (the GO) is sent only when the acting user is an admin. A developer approve does not send one.
- `POST /api/releases` `{ sha, target, project?, lane?, desk?, reviewer?, requested_by?, requester_role?, requester_is_admin?, origin_id?, origin_box? }` —
  deploy side: accept a request. Production is admin only for a local caller. A peer (restricted token)
  must forward the originating user: `requested_by` (name) and `requester_role`. The name is accepted
  only when it is listed in `releases.production_approvers` (for example `[denis]`). An empty or unset
  list refuses every peer production request, and a missing name or role refuses too. `requested_by`
  stays that person's name. Staging requests from peers are not checked against the list.
  Idempotent while a request for the same SHA + target is open. The deploy agent receives
  `[Release GO <id> from <person> via WaveCode Promote …]` or `[Staging request <id> … Automated …]`.
  When `releases.staging_command` is set, a staging request runs that command instead of the
  prompt. The argv is a template: `{sha}` is required, `{lane}` and `{desk}` are omitted (with
  the preceding flag) when empty. Before it runs, the deploy box re-checks a known freeze:
  the reviewer's PASS, and GREEN when a gate is recorded. Unknown freezes are left to the
  command. Progress lines (schema v1; unknown fields ignored) update the record and emit
  `release.progress`. A `done` line is `deployed`; a `failed` line is `failed`. If the daemon
  restarts mid-deploy and `releases.staging_watch_command` includes `{deploy_id}`, it
  re-attaches. Production is unchanged and always uses the deploy agent. Without
  `staging_command`, staging keeps today's prompt.
- Candidates are the unit of production when `projects.<p>.candidate_refs` is set: the board lists each
  unreleased candidate with its tip SHA and the lanes it contains; a lane alone is then never promotable.
  `POST /api/releases/candidates/:name/stage` `{ project }` requests staging. A developer needs every contained lane's reviewer PASS, unless that composed candidate is already deployed to staging. An admin may stage either way.
  `…/promote` sends the production GO for the candidate's tip and is admin only (403 otherwise).
- `POST /api/releases/verify` `{ sha, project?, note? }` — **Ready for prod** (verified on staging) for any SHA
  (a lane or a candidate tip), keyed by SHA and recorded with the person's name. Developers and admins.
  Event `release.verified` (entity = sha) carries `sha`, `version`, `lane`, `desk`, `verified_by`; the same
  fields go out through the existing notifiers (ntfy / Telegram / web push). There is no GitHub PR comment client.
- `POST /api/releases/:id/verify` `{ note? }` — the same Ready for prod action for a deployed staging record
  (delegates to the SHA). The release card shows Ready for prod once it is recorded.
- `GET /api/releases/audit?limit=` — who did what, newest first: `stage` / `auto-stage` / `promote` / `rollback` / `prereq`
  (the person, or `overlord` for auto-stage), `verify` (shown as Ready for prod, with lane, version and desk),
  `reject` (with reason), and the deployer's `deployed` / `failed` outcomes with version. Shown on the Release page.
- `POST /api/releases/:id/report` `{ status: 'deployed'|'failed'|'rejected', sha?, version?, note? }` —
  the deploy agent's outcome (MCP `report_release`, or the pane line `RELEASED <id>: deployed <sha> version <x.y.z> to <target>`
  / `RELEASE FAILED <id>: <why>`, detected by the watcher). A deployed report must name the requested SHA.
  Final: a second report is a no-op.
- Events: `release.requested`, `release.progress`, `release.reported` (entity `release`). All are
  visible to a peer's restricted token so the requester can mirror them; a deployed/failed outcome
  also notifies (ntfy / push). Progress heartbeats are stored and mirrored; they are not threaded.

## Reviews

### `GET /api/reviews`
List review queue items.

### `GET /api/reviews/board`
The Reviews page. `{ last_reconciled_at, stale, reviewers, items, cards, viewer, release }`. `cards` is one card per lane (latest freeze only; older freezes are `older`). Each card has one `status`, one plain-language `action`, an `owner_label`, a six-step `pipeline` (`Freeze > Tests > Review > Staging > Ready > Prod`), and at most one `button` (`Stage`, `Ready for prod`, or `Promote` for a production approver). `viewer.name` is the developer matched from `developers[].users` or `developers[].tokens`; null shows every lane. `release` is the prod and staging version and SHA, plus lanes waiting in the next release. `reviewers` is each seat's open-review queue and whether its pane is busy or idle. Queue depth counts a review only while the exact SHA has no reviewer verdict (`pass` → run `approved`, `needs-fixes` or `reject` → `rejected`). It does not read `runs.review_status`, which the reconciler backfills from that verdict. A behind-main card that is not superseded and not already in staging or prod stays actionable; its author is pinged once per lane and main SHA to merge main and refreeze. Denied lanes and agents are not pinged. Superseded cards are History. Auto-review picks the least-loaded eligible seat. Independent seats in `pipeline.reviewer_prefer` for the author's vendor come first, then any other independent eligible reviewer (`review_routes`, then the ladder). A same-person seat is chosen only when `pipeline.reviewer_pool_by_author_glob` names it and no independent reviewer is eligible. Denied names and the author stay excluded. When that pooled same-person seat is used, the review note and the lane card say `same-owner reviewer via pool`. Reassignment uses the same order. A review with no verdict that sits on a busy seat longer than `pipeline.review_reassign_minutes` (default 15, 0 disables) moves once, or again when the next seat is idle, and the card logs the move. Each freeze item carries `deploy`: one derived state (`needs_fixes`, `awaiting_review`, `awaiting_tests`, `ready_to_stage`, `on_staging`, `awaiting_prod_go`, `live_on_prod`, `superseded`, `stale`, or `unknown`), the release version, a `staging` or `prod` badge, and the quick or full test on that exact SHA with its time. Title, one-line summary and desk come from the freeze note. A composition or multi-desk note has no single desk number. Filler words (`is`, `from`, `remains`, `update`, `changes`, `source`, `separately`, `held`, `also`, `commits`, `test-path`) are not lane names. A lane is a `wc-*` id, or a lane already named by config or by a run (the author's checkout, or the release request for that SHA). A seat mentioned in prose is not a lane.

`GET /api/reviews/board` serves the reconciler's snapshot. A request does not scan git or the gate. A reconciler rewrites `deploy_card_states` every 90 seconds, on main push, on main merge, and as soon as a stage or deploy finishes (including a deploy mirrored from the peer). Only the current staging tip is `on_staging`. An older SHA that is merely contained in that tip is `superseded` and History. Working lanes, and cards that are on staging or live on prod, are History and stay out of the action set. `reviewers` omits seats named in `review_deny` or `agent_deny`; the assignment ladder refuses those seats too. Containment, computed only during reconcile, is `git merge-base --is-ancestor` in `projects.<p>.repo` against `origin/main`, the staging tip from `resolveStagingTip` (the `release_peer` whenever this project forwards releases, otherwise `staging_health_command`, then the newest deployed staging row) and the prod tip (`prod_health_command`, else the newest deployed production record). A failed peer ask stays unknown and is not replaced by the local row. Each card stores `stage_block`, computed from that card's SHA even when its lane is not configured: behind main, forward-only, the gate, or a refusal because the SHA would roll staging back, is already the staging tip, is superseded, or was rejected. A freeze closed as merged whose SHA is on main and forward of staging stays stageable. The same sentence locks Stage on the run, and `POST /api/reviews/:runId/stage` returns it. A missing tip or an unreadable probe is `unknown`. `stale` is true when `last_reconciled_at` is missing or older than 5 minutes; that also notifies. The Release view reads the tip from that last reconcile.

### `GET /api/reviews/:runId`
Get one review queue item.

### `POST /api/reviews/:runId/promote`
Approve a run. When promote-gating is active (`review.require_pass_to_promote`
or `review.auto_review`), the latest completed AI review must have verdict
`pass`; otherwise the call fails with 400 unless `overrideReason` is supplied
(stored in the `review.promoted` audit event). With
`review.gate_dependents_on_approval`, approval also unblocks dependent tasks.

Body (optional):
`{ overrideReason?: string }`

### `POST /api/reviews/:runId/retry`
Retry the task behind a run.

### `POST /api/reviews/:runId/handoff`
Hand off a task to another agent.

Body:
`{ targetAgentId: string }`

### `POST /api/reviews/:runId/reject`
Reject a run and fail the task.

### `POST /api/reviews/:runId/ai-review`
Request self-review or cross-model review.

Body:
`{ type?: "self" | "cross-model", reviewer_agent_id?: string, reviewer_runtime?: string }`

`reviewer_agent_id` accepts `@alias`, name or id (ladder rung 1; 400 if it is
the author). With neither reviewer field the **assignment ladder** picks
(task reviewer → `default_reviewer` → free tagged `review` → any free agent);
with nobody free the run keeps a pending placeholder, `review.needs_reviewer`
is emitted with candidates, and the call returns 409.

### `POST /api/ai-reviews/:reviewId/reassign`
Move a running or waiting review to another agent (the thread's "→ @x" chip).
Body: `{ reviewer: "@alias | name | id" }`. The old row closes as `failed`
with a note; a new review starts at the same fix round. Observers: 403.

### `POST /api/tasks/:id/reviewer`
`#review #12 @opus`: set the task's reviewer (`{ reviewer: "@x" | null }`).
If the task's latest run is being reviewed or waiting, that review moves now;
if it finished unreviewed, the review starts now. Returns `{ task, review }`.

### `GET /api/reviews/:runId/ai-reviews`
List AI reviews for a run.

### `POST /api/ai-reviews/:reviewId/send-fixes`
Send review fixes back to the original agent.

### Release freezes (reviewed by files)

Countix lanes are frozen and reviewed outside WaveCode's own runs: the author drops a
freeze note and an independent reviewer drops a verdict file into the freeze inbox
(`review.freeze_inbox`, e.g. `/home/wave/inbox`). WaveCode watches that folder and turns
every reviewed SHA into a normal Review-queue card (a synthetic done run for the author
plus a completed `code_reviews` row for the reviewer, announced as `review.ai_completed`
with a `freeze` payload). `ReviewItem.freeze` carries: `sha`, `project`, `desk`, `lane`,
`author_name`, `reviewer_name`, `verdict`, `freeze_path`, `verdict_path`, `gate`,
`status` (`open | promoted | rejected | stale`), `superseded_by`.

File rules (file name contains `freeze` or `verdict`, `.md`/`.txt`):
- the exact 40-character SHA on an `Exact SHA:` / `Freeze SHA:` / `Candidate:` line or in the title;
- a line `VERDICT: PASS`, `VERDICT: PASS (gate pending)`, or `VERDICT: NEEDS FIXES` (a line naming both is a request, not a verdict). `PASS (gate pending)` is a PASS. It does not make the gate green;
- `Author: @x`, `reviewer X` / `Independent reviewer: X`, `Lane:`/`Branch:`, `Project:`, `Desk #n`;
- a freeze note may carry the reviewer's verdict inline: `@codex3 **VERDICT: PASS** on this exact SHA: /path/to/review.md`.

Server rules on `POST /api/reviews/:runId/promote` for a freeze card:
- only an independent `PASS` on the exact SHA promotes (non-PASS needs an admin `overrideReason`, stored in `review.promoted`);
- the reviewer must differ from the author (a self-review file is refused at ingest);
- a newer freeze on the same lane, or for the same desk in the same project (verdict files often carry no lane line), or a lane tip that moved, marks the older SHA `stale` (`review.superseded`, payload `by: 'lane' | 'desk'`); a stale SHA is refused, override or not;
- a SHA inside an unreleased release candidate branch (`projects.<p>.candidate_refs`, a glob over remote
  branch names such as `fable/rc-*`; a candidate already on main is released and ignored) is "in candidate":
  the board shows it as shipping with that release, it is not promotable alone, not an open fix, and the
  overlord is told to leave it to the release;
- Stage (`POST /api/reviews/:runId/stage`) needs the reviewer's PASS on the exact SHA (an admin may stage without that PASS) plus a green quick check or a green full run from `projects.<p>.tests` history. A stale SHA — status `stale`, or the lane tip has moved past the freeze — is refused for everyone, admins included. A lane that does not contain the project's current main is `behind-main` and cannot be staged or promoted.
- Promote needs a green full gate (`kind: gate` or a suite in `tests.full_suites`, default `full-tuned` / `full`) on the exact SHA, plus the admin-only rule and `releases.production_approvers`. A green quick check is not enough. Until that full run is green the card says `full run not green on <sha8>`.
- `POST /api/lanes/:lane/retire` `{ project? }` (admin): retire a lane whose work is all on main (`git cherry origin/main <lane>` empty); its freezes close as merged and it is not pinged about main again. 409 while the lane still has a commit main lacks, 404 when the lane is not on the remote. The branch is never deleted. `{ lane, project, tip, freezes_closed, retired: true }`.
- `GET /api/reviews/lanes` lists developer lanes ahead of main (glob `projects.<p>.lane_glob`, default `wc-*`), including lanes with no freeze. A lane matching `projects.<p>.pipeline.lane_deny`, or whose agent is in `pipeline.agent_deny`, is left off this list and off the review cards. `agent_deny` is also a reviewer deny. Each row has `status_line` (one what's-missing line). `POST /api/reviews/lanes/request-review` with `{ project, lane, reviewer }` sends the freeze to that reviewer and never offers the author. `GET /api/reviews/test-log?project&id` returns a run log when `tests.log_command` is set.
- Test commands (`tests.status_command`, `tests.history_command`, `tests.log_command`) are argv templates with `{lane}`, `{sha}`, or `{id}`. They print JSON schema v1. `tests.quick_suites` (default `quick`, `tier1`) and `tests.full_suites` (default `full-tuned`, `full`) name which suites count. No shell.
- a SHA that is already an ancestor of the project's main (`projects.<p>.repo`, checked with `git merge-base --is-ancestor`, the base clone fetched at most every 10 minutes) is closed as `merged` whenever the board is built: its queue card is approved and `review.superseded` carries `superseded_by: 'main'`. This is how lanes deployed or merged outside the pipeline stop counting as open work or open fixes;
- Promote relays the GO to `projects.<p>.release_peer` with the freeze SHA, lane, reviewer, the person who pressed it and both file paths. Nothing deploys by itself.
- `POST /api/reviews/:runId/reject` accepts `{ reason?: string }` (stored; `review.rejected.reason`). Retry and hand-off do not apply to freeze cards.
- On startup, today's files in the inbox are backfilled; only PASS verdicts create cards then.

`GET /api/reviews/freezes` lists all known freezes (cards and decided ones).
`POST /api/reviews/freezes/ingest` with `{ path }` (a file inside the freeze inbox) ingests a file on demand, for a reviewer that cannot wait for the watcher.

## Peers (docs/peers.md)

### `GET /api/peers`
Configured peers: `[{ name, url, agents }]` — never the token.

### `POST /api/peers/:peer/ask`
Body `{ agent, question, from_agent_id? }`. Delivers the question to that agent
on the peer instance and returns 202 with the question row (`status: sent`).
The answer is written to `~/inbox/answers/<peer>-<agent>-<id>.md`, emitted as
`peer.answer`, and typed into `from_agent_id`'s pane when it is idle (a seat
token's own agent is the default). 404 unknown peer/agent or not in the
allowlist, 502 peer unreachable, 403 observers.

### `GET /api/peers/questions[?status=sent|answered|delivered|failed]`, `GET /api/peers/questions/:id`

## Files

### `GET /api/files/view?path=<absolute or ~/ path>`
Read-only viewer behind "a path in an agent's reply is a link" (the UI
turns bare paths into `/file?path=…` links). Serves text files ≤ 1 MB under
the browsable roots only — `paths.rooms_root`, `paths.worktrees_root`,
`paths.projects_root`, `paths.transcripts_root`, `artifacts.storage` and
`paths.browse_roots` (extra directories, e.g. a shared inbox) — resolved
through realpath. Returns `{ path, name, size, modified_at, kind:
"markdown"|"text", content }`; 400 invalid, 403 outside the roots, 404
missing, 413 too large, 415 binary.

## Specs

### `GET /api/specs`
List research/spec runs.

### `GET /api/specs/:id`
Get one research/spec run.

### `POST /api/specs`
Create a research/spec run.

### `POST /api/specs/:id/attach`
Attach a completed spec to an agent.

### `POST /api/specs/:id/fork`
Create a follow-up research/spec run from an existing result.

### `DELETE /api/specs/:id`
Delete a research/spec run.

## Artifacts

### `GET /api/artifacts`
List artifacts.

Query:
`agent_id`, `run_id`

### `GET /api/artifacts/:id`
Get artifact metadata.

### `GET /api/artifacts/:id/download`
Download artifact contents.

### `POST /api/artifacts/upload`
Upload an artifact into the existing hashed store (not a second store).
When `agent_id` is set, the file is copied into that agent's
`.wavecode/artifacts` workspace (`artifact_targets`). When `run_id` is
set, a `run_artifacts` row is recorded.

Body (either):
- `multipart/form-data` with `file`, optional `note`, `agent_id`, `run_id`
- `application/json`:
  `{ filename: string, content_base64: string, note?: string, agent_id?: string, run_id?: string }`

JSON callers must send `content_base64` + `filename`. `path` is rejected
(a token must not be able to read arbitrary VPS files). MCP
`upload_artifact` still accepts a local `path` — the MCP process reads
it and posts base64.

### `POST /api/artifacts/:id/attach`
Attach an existing artifact to an agent (workspace copy +
`artifact_targets`) and/or a run (`run_artifacts`). Does not send-keys.

Body:
`{ agent_id?: string, run_id?: string, role?: string }`

### `POST /api/artifacts/:id/share`
Share an artifact with an agent: copy into `.wavecode/artifacts` and try
to notify the pane. File-on-disk is success; notify failure is non-fatal.
Returns `attached_path` (the path the CLI agent can open).

Body:
`{ targetAgentId?: string, agent_id?: string }`

### `GET /api/runs/:id/artifacts`
List artifacts attached to a run.

### The library: fixtures

An artifact is `transient` (pruned after `artifacts.retention_days`), a `fixture` (a kept,
sanitized file for development) or a `document` (an archived freeze note, verdict, hand-off or
report). Fixtures and documents are never pruned and carry `desk` (Product Desk / request
number, normalized to digits: `PD-108` → `108`), `room` (project), `provenance` (where the bytes
came from and how they were sanitized) and `uploaded_by`. Documents are created by the daemon:
every freeze note or verdict the review watcher ingests and every hand-off the inbox watcher
announces is archived with its title as `note`, the exact SHA in `provenance`, and the kept
copy's path in the thread item (`freeze.archive` on `review.ai_completed`; `(archive …)` in the
announcement). Same bytes twice = one document; an edited file is a new version. Customer originals never become fixtures: they stay in
the Product Desk in production; a fixture is a sanitized derivative, and `provenance` says so.

- `GET /api/artifacts?kind=fixture|document|transient&room=&desk=&q=` — `q` searches filename, note,
  desk and provenance. A restricted (peer) token only ever sees fixtures.
- `POST /api/artifacts/upload` also takes `kind`, `desk`, `room`, `provenance` (JSON or form
  fields). The same bytes uploaded again as a fixture promote the existing artifact instead of
  storing a copy.
- `PATCH /api/artifacts/:id` `{ kind?, desk?, room?, provenance?, note? }` — keep as fixture /
  edit the library fields (`null` clears). Emits `artifact.updated`.
- Drop folders: every file put under an `artifacts.fixture_inbox` directory becomes a fixture;
  `<inbox>/<room>/<desk>/<file>` names the room and the desk, or the file name does
  (`desk91-…`, `pd108-…`).
- Import from a peer: `GET /api/peers/:peer/artifacts` lists what the peer marks as fixtures;
  `POST /api/peers/:peer/artifacts/:id/import` `{ room?, desk? }` pulls one over the peer link,
  verifies its sha256 against the peer's record and stores it with a provenance line naming the
  peer, the remote artifact, the importer and the peer's own provenance. Non-fixtures are refused.

## Guides And Templates

### `GET /api/guide-sources`
List guide sources.

### `POST /api/guide-sources`
Add a guide source from git or a local path.

### `POST /api/guide-sources/:id/sync`
Refresh a guide source.

### `DELETE /api/guide-sources/:id`
Remove a guide source.

### `GET /api/guides`
List imported guides.

### `GET /api/guides/:id`
Get one guide with content.

### `GET /api/agents/:id/guides`
List guides attached to an agent.

### `POST /api/agents/:id/guides`
Attach a guide to an agent.

### `DELETE /api/agents/:agentId/guides/:guideId`
Detach a guide from an agent.

### `GET /api/templates`
List templates.

### `GET /api/templates/:id`
Get one template.

### `POST /api/templates`
Register a template from git or a local path.

### `POST /api/templates/:id/sync`
Refresh a template.

### `POST /api/templates/:id/trust`
Mark a template as trusted for spawning.

### `DELETE /api/templates/:id`
Remove a template.

### `POST /api/templates/:id/spawn`
Spawn an agent from a template.

## Docs

### `GET /api/docs`
List root docs and agent workspace markdown files.

### `GET /api/docs/:slug`
Read one document by slug.

### `GET /api/agents/:id/file/:path`
Read a specific file from an agent workspace. Paths are constrained to the agent workspace root.

## Push notifications

### `GET /api/push/vapid-key`
Return the public VAPID key.

### `POST /api/push/subscribe`
Store a push subscription.

Body:
`{ endpoint: string, keys: { p256dh: string, auth: string } }`

### `POST /api/push/unsubscribe`
Delete a push subscription.

Body:
`{ endpoint: string }`

## Thread (Command Center feed)

### `GET /api/thread`
Merged, typed, cursor-paged feed built from the event log (spec §4.1). Query: `agent=<id|all>`, `owner=<user id>` (items on agents that user owns, or that the user caused), `kinds=prompt,report,request,run,verdict,task,alert,artifact`, `attention=1`, `since=<cursor>`, `limit` (≤500), `wait_ms` (≤60000, long-poll; only with `since`).

Without `since`: the newest `limit` items. With `since`: items after that cursor. Response `{ items, cursor }`, items oldest → newest; pass `cursor` back as `since`.

`ThreadItem { id, event_id, at, kind, type, agent_id, actor_id, title, body, refs: {task_id?, run_id?, review_id?, artifact_id?, message_id?}, needs_attention, actions }`

| kind | source events | needs_attention | actions (when the viewer may) |
|---|---|---|---|
| `prompt` | `agent.prompt_sent` | no | — |
| `report` | `message.created` type result/info/handoff (human message = "Reply") | no | reply |
| `request` | `message.created` type request; `agent.status_changed` idle with a last line ending in `?` | yes | reply, send file |
| `run` | `run.started/finished/failed`, `run.phase` failed/incomplete | failed/incomplete | open log, retry, hand off |
| `verdict` | `review.ai_completed` | verdict ≠ pass | promote (pass), override promote (admin, non-pass), send fixes, reject |
| `task` | `task.created/dispatched/completed/blocked/waiting_for_agent/failed` | blocked/waiting | reassign, release agent (lease holder/admin) |
| `alert` | `agent.crashed/hung/lease_expired/runtime_relaunched`, `system.stop_all`, error messages | yes | restart, kill |
| `artifact` | `artifact.created/shared` | no | open, forward |

`actions` are `{ id, label, method, path, body? }`, computed server-side from the viewer's role and agent ownership (observers get only read actions). Body values like `{text}`, `{agent_id}`, `{reason}`, `{artifact_id}` (also in `path`) are placeholders for the UI to fill.

### `POST /api/messages` — replies
`to` (agent id or name) is an alias of `to_agent_id`. A message to an agent **without** `from_agent_id` is a human reply: rule 2 applies (`403` naming the owner), and after it is stored it is typed into the agent's tmux as `[from <user>] <message>`. The response adds `injected: true`, or `injected: false, inject_error` when it could not be typed (file-runner seat, runtime not running, no session). It is never typed into a bare shell.

### `POST /api/agents/:id/restart`
Owner/admin. Spawned agent with a dead session → session recreated (`agent.restarted`); live session whose runtime exited → runtime relaunched in place (`agent.runtime_relaunched`). Returns `{ ok, action }`.

## The retro loop (spec §5f)

- **Feedback**: `POST /api/messages/:id/feedback {score: 1|-1, note?}` on a captured `reply` (one vote per person per reply; voting again replaces it; observers `403`). Thread `reply` items carry `feedback: {up, down, mine, mine_note, can_vote}`. `GET /api/feedback?agent=&limit=` — without `agent`, the caller's own seat. MCP `list_feedback`. Every seat brief includes its recent 👎/noted feedback ("👎 \"too long\" — on: \"who is free?\"") and tells it to keep the lesson in SEAT.md.
- **Templates**: dispatch uses `TEMPLATES/<kind>.md` (`{task}`, `{room}`, `{done_when}`) and records the kind on `tasks.template`.
- **Metrics**: `GET /api/rooms/:project/metrics[?since=]` → `{project, templates: [{template, tasks, reviewed, first_pass_rate, mean_fix_rounds, questions_rate, mean_time_to_result_s}]}` (first pass = verdict PASS on fix round 0; questions = `request` messages per task). MCP `get_room_metrics`. Shown as a strip on the Board and a first-pass badge on the Board rail.
- **Proposals**: `POST /api/rooms/:project/proposals {path, content, evidence}` (MCP `propose_room_change`) → review queue (`GET /api/proposals?status=pending`, `GET /api/rooms/:project/proposals`). `POST /api/proposals/:id/promote` — a person who may write the file (never a seat token) — applies it if the file has not changed since (else `409`, `stale`), with a ledger line; `POST /api/proposals/:id/reject`. A seat token's `PUT` on `SPEC.md` / `TEMPLATES/…` becomes a proposal (`202 {proposed: true, proposal}`): nothing in `TEMPLATES/` or `SPEC.md` changes from an automated actor without a promote (a person's own edit is the approval). The seat may still write `ROOM.md` and `REPORTS/` directly and its `SEAT.md` freely.
- **Retro**: `POST /api/rooms/:project/retro` / `wavecode retro <room>` — writes the evidence (metrics, tasks with verdicts/fix rounds/questions back, feedback, what people asked the seats) to `REPORTS/<date>-retro-evidence.md` and asks the room owner's seat (else the shared orchestrator) to propose template and ROOM.md vocabulary changes with evidence. Nightly at `retro.hour_utc` (default 03 UTC, `retro.nightly: true`) for rooms with activity in `retro.window_days` (7), once per day.

## Project rooms (spec §5e)

One shared folder per project under `paths.rooms_root/<project>/`: `SPEC.md`, `ROOM.md`, `LEDGER.md`, `DECISIONS.md`, `REPORTS/`, `TEMPLATES/{build,review,verify,spec}.md`. Every configured project gets a room; others are created with `POST /api/rooms {project}` (the caller owns it). Agent workspaces get `.wavecode/room` → the room (added to `.git/info/exclude`).

- `GET /api/rooms` → `[{project, root, owner_id, owner, can_write_spec, is_default}]` · `PATCH /api/rooms/:project {owner_id}` (owner/admin).
- `GET /api/rooms/:project/docs` → `{project, root, docs: [{path, size, modified_at, writable}]}` · `GET /api/rooms/:project/docs/<path>` → `{path, content, writable}` · `PUT /api/rooms/:project/docs/<path> {content}`.
- Write rules: `SPEC.md`, `TEMPLATES/…` and other files — room owner or admin; `ROOM.md`, `REPORTS/…` — any non-observer (any seat); `LEDGER.md`, `DECISIONS.md` — WaveCode only. Reads are open. The rules also hold on disk (agents reach the room through `.wavecode/room` and run as one OS user): every file outside `ROOM.md`/`REPORTS/` is read-only (0444) with its canonical content kept by WaveCode; an edit or delete made outside the API is restored before reads and briefings and on the 30s monitor tick, with a `room.integrity_restored` alert in the thread. Paths are relative, `.md/.txt/.json/.log`, no `..`, dotfiles or symlinks; ≤512 KB.
- WaveCode writes: each finished run's RESULT file + prose summary, each review verdict + feedback, and each QA report (`POST /api/agents/:id/docs` with `subdir: qa-reports`) as a file under `REPORTS/` plus a `LEDGER.md` line; decisions are appended to `DECISIONS.md`.
- Tasks: `POST /api/tasks {room?, template?}` — `room` defaults to the room whose `projects.<name>.workspace_match` matches the agent's workspace, else the creator's default room (`PUT /api/users/me/default-room {room}`); `template` is `build` (default) / `review` / `verify` / `spec`. Every dispatch starts with the room index (file list + top of `ROOM.md` and `SPEC.md`) and the task wrapped in its template (`{task}`, `{room}`, `{done_when}`).
- MCP: `list_rooms`, `list_docs {room}`, `read_doc {room, path}`, `write_doc {room, path, content}`. The orchestrator brief lists the rooms and tells the seat to read `ROOM.md` before answering, quote `SPEC.md` for "what are we building", and update `ROOM.md` after a decision.

## One orchestrator seat per user (spec §5d)

All routes act on the caller's own seat. Observers get `403`; the fallback-token `owner` (no user record) gets `400`.

- `GET /api/users/me/seat` → `{status: 'none'|'ok'|'missing', agent?|agent_id?, eligible, rules, has_token}`. `GET /api/me` adds `seat: {status, agent_id?}`.
- `POST /api/users/me/seat {runtime?}` (default `claude-code`) → `201 {agent, mcp: {registered, error?}}`. Spawns `pm-<user>` on the user's credential profile in `<data>/seats/pm-<user>` (with a `SEAT.md` memory file), `role: orchestrator`, owned by the user with lease `seat` (never expires; cannot be reserved, released or swept; the dispatcher never gives it worker tasks). Issues a **seat token** (second bearer for the same user; only its hash is stored) and registers the `wavecode` MCP server with it **in the seat's own workspace only** (Claude Code: the seat workspace's `.mcp.json`, pre-approved in `.claude/settings.local.json`) — never in a profile or home config, where every worker on that login would load it. Runtimes whose MCP config is profile-wide (Codex, …) are not registered automatically (`mcp.registered: false` with the reason). A seat token is narrower than the person: it never carries admin powers (an admin's seat acts as a developer) and gets `403` on `/api/users*` (except `GET /api/users`), `/api/settings*`, `/api/system/*` and login seats. Then briefs it with `docs/orchestrator-seat.md` + who it serves + the SEAT.md instruction + `users.seat_rules`. `409` if you already have one; a *missing* seat is recreated.
- `PUT /api/users/me/seat/rules {rules}` (≤2000 chars, `null` clears) · `POST /api/users/me/seat/brief` re-sends the brief with the current rules.
- `DELETE /api/users/me/seat/token` revokes the seat token (the seat's MCP calls get `401`; your own login keeps working) · `POST /api/users/me/seat/token` issues and registers a new one (`restart_required: true` — the running seat keeps its MCP session until restarted). Revoking a user removes their seat. A leftover `pm-<user>` of that user (an interrupted creation) is re-linked on the next create instead of `409`.
- Routing: `GET /api/agents` flags `orchestrator: true` on the viewer's own seat; without one, on the shared seat (`config.orchestrator_agent`, never another user's seat); with a *missing* seat, on none — the Center offers "Recreate my seat" and blocks Ask instead of silently falling back. Seat replies render in the owner's color.

## Aliases, groups, people, composer grammar (spec §5c)

- **Resolution** everywhere an agent is named (routes, MCP, CLI, composer): alias → name → id; a leading `@` is ignored.
- `PATCH /api/agents/:id {alias?, persona?}` (owner/admin). `alias` matches `^[a-z][a-z0-9_-]{1,23}$`, is unique, and may not equal another agent's name/alias, a tag, a person's name or a reserved word (`all`, …) → `409`/`400`. `persona` is one line ≤80 chars and is prepended to everything typed into the agent as `[you are @alias — persona] …` (prompts, replies, task dispatch); the thread shows what the person wrote. Emits `agent.renamed`.
- **Groups**: `POST /api/agents/:id/tags {tag}`, `DELETE /api/agents/:id/tags/:tag` (owner/admin; `agent.tagged` / `agent.untagged`). `GET /api/agents` rows include `alias`, `persona`, `tags`.
- **People**: `POST /api/messages {to_user, message}` addresses a person (`to_user_id`): the thread item "Message for @name" needs attention for that person only, and it is mirrored to push / ntfy / Telegram. CLI: `wavecode msg @ana "…"`, `wavecode msg @frontend "…"` (one message per agent), `wavecode msg toni "…"`.
- **Task numbers**: tasks carry `num`; `depends_on` accepts `#12`.
- **Command items**: reserve (explicit), release, kill, tag/untag, rename and promote issued by a person appear in `GET /api/thread` as kind `command` with that person as `actor_id` (e.g. `#reserve @toni · until 14:05 UTC`).
- The composer grammar (`@x text`, `@x @y text`, `@group text`, `@all text`, `@person text`, `#reserve @x [Nh]`, `#release @x`, `#kill @x`, `#tag @x name`, `#task [@x] text [deps:#n,#m]`, `#promote #n`, `#file @x name`, `#status`; anything else → the orchestrator seat unchanged) is parsed in the UI and executed through the routes above.

## Reply capture + orchestrator seat (spec §5b)

- Every prompt typed into a tmux agent (`POST /api/agents/:id/send` non-raw, MCP `send_prompt`, a human reply via `POST /api/messages`) is answered in the thread: when the agent next goes idle, its pane is captured, the runtime's TUI chrome is stripped (Claude Code, Codex, Grok extractors; tool-call blocks, spinners, prompt box, status bar) and the final prose (≤4 000 chars, head+tail) is stored as an `agent_messages` row with `message_type: 'reply'`, `ref_prompt_actor`, `ref_prompt_event_id` (and `ref_task_id` when the agent had an open run), emitted as `message.created`. No idle within 10 minutes → a `reply` with `truncated: 1`. Clients cannot post `message_type: 'reply'` (`400`).
- `GET /api/thread` kind `reply`: `refs.prompt_event_id` links it to the prompt; `needs_attention` when it ends with a question; a closing question followed by 2–4 `[ ] option` lines (or a `[A] [B]` line) yields `quick_reply` actions (`POST /api/agents/:id/send {text: option}`) for viewers who may act on the agent.
- `run` items include the run's captured prose summary (`runs.summary`) in `body`.
- Agents have `role` (`'orchestrator'` or null). `POST /api/agents/spawn` / `adopt` accept `role`; `PATCH /api/agents/:id {role}` sets it (owner/admin). Becoming the orchestrator sends `docs/orchestrator-seat.md` (flattened to one line) once the runtime is up. `GET /api/agents` marks the default seat with `orchestrator: true`: `config.orchestrator_agent` by name, else the first agent with role orchestrator, else one named `pm`/`orchestrator`.

## Credential profiles (spec §5)

Agents run on a **profile**: a credential directory `<profiles_root>/<profile>` that the runtime is pointed at via env (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `HOME` for grok), launched as `env K=V … <command>` on spawn, restart, upgrade, runtime relaunch and file-runner runs. Env values are validated (paths/plain tokens only) and an unresolvable profile fails the launch instead of falling back to another login.

- `users.profile` defaults to the user name; the fallback-token `owner` has none (home-dir login).
- `POST /api/agents/spawn` uses the caller's profile; `profile` (name or `null`) is admin-only (`403` otherwise). Shared profiles are admin-only.
- Dispatch: an agent on profile P only takes tasks created by users on P; a `shared` profile takes admin/system tasks; an agent without a profile takes anyone's. A task assigned to an incompatible agent waits with `task.waiting_for_agent {reason: 'profile', profile}`. `GET /api/agents` adds `profile_compatible` for the caller (free but `false` = "free (other subscription)").

### `GET /api/profiles`
`[{ name, shared, mine, runtimes: { <runtime>: { logged_in } } }]` — whether a credential file exists. Never contents or paths.

### `POST /api/profiles/:name/login`
Body `{ runtime }`. Profile owner or admin (shared: admin). Opens tmux seat `wc-login-<profile>-<runtime>` running the runtime's `login_command` with the profile env, registered as an adopted agent `login-<profile>-<runtime>` (reserved for you, never dispatched to) so you can read the device-code URL in AgentView. The seat is removed when the login exits or after 15 minutes (`profile.login_started` / `profile.login_finished {reason, logged_in}`). `409` if one is already open.

CLI equivalent on the box: `wavecode profile login <name> <runtime>` (runs the login in your terminal).

## Events

### `GET /api/events`
Open the server-sent event stream.

Auth:
- use the normal bearer token in authenticated requests
- for browser EventSource clients in token mode, pass `access_token=<token>` in the query string

Reconnect support:
- `Last-Event-ID` header
- `lastEventId` query parameter fallback

Common event families:
- `agent.*`
- `task.*`
- `run.*`
- `artifact.*`
- `review.*`
- `heartbeat`
- `queue.empty`

### Event payloads

Each SSE message carries `{ id, type, entity_type, entity_id, payload, created_at }`.
The most important events for client UIs (sidebar live indicators, dashboards):

#### `agent.spawned`
A new agent has been registered.
Payload: full `Agent` object (`{ id, name, runtime, tmux_session, workspace, mode, status, created_at }`).

#### `agent.killed`
An agent has been removed.
Payload: `{ id: string }`.

#### `agent.status_changed`
The agent's status transitioned (`idle` ↔ `working` ↔ `error`).
Payload: `{ status, lastOutputLine, permissionMode, outputVersion, outputUpdatedAt, autoCorrect? }`.

#### `agent.output_updated`
The agent's tmux pane produced new output without a status change. Fired at the polling
cadence of the output watcher; use it to flash a "this agent just spoke" indicator without
needing to poll `/api/agents`.
Payload: `{ lastOutputLine, permissionMode, outputVersion, outputUpdatedAt }`.

#### `run.started` / `run.finished` / `run.failed`
A run lifecycle event.
`run.finished` payload: `{ run_id, exit_code, duration_s?, changed_files? }`.

#### `task.created` / `task.completed`
Task lifecycle. `task.completed` payload: `{ task_id, success: boolean }`.

#### `artifact.created` / `artifact.deleted` / `artifact.detached`
Artifact lifecycle. `artifact.created` payload is the full `Artifact` object.
`artifact.deleted` payload: `{ id, filename, sha256 }`.
`artifact.detached` payload: `{ agent_id, filename }`.

#### `heartbeat`
A periodic keep-alive (every ~15 s). Empty payload. Clients can use it to detect a
dropped connection that wasn't otherwise signalled.

### Lane pipeline: push check, background gate, capacity-aware reviewers, first pass

Added 25 Oct 2026 for the review speed-up (see `docs/maestro-contract.md` for the file and
event contract).

- **Push check.** A freeze whose exact SHA is not an ancestor of `origin/<lane>` is held:
  event `pipeline.refused`, a `push` note, one line to the author, and a re-check every two
  minutes for twelve hours. WaveCode never pushes a lane; `push_command` is for projects
  that want it to.
- **Gate in the background.** With `auto_gate`, the freeze shows `QUEUED` the moment it
  lands and the gate command runs in a clean detached worktree of the exact SHA
  (`<repos>/.wavecode-gates/<repo>-<sha9>`) with `COUNTIX_REMOTE_TEST_WHO=<author>`,
  `WAVECODE_SHA`, `WAVECODE_LANE` and `WAVECODE_CHECKOUT` in the environment, for up to
  `pipeline.gate_timeout_min` (default 120). The exit code decides: 0 GREEN, 1 RED, 7 (the
  dispatcher's duplicate) stays QUEUED; a submit-only tool may print QUEUED or RUNNING on its
  last line instead. `pipeline.gate_with_quick` skips the pipeline's own quick check so one
  remote run per freeze is submitted while the review runs. Quick and gate commands no longer
  need a `{sha}` placeholder; `{checkout}` is available.
- **Reviewer capacity.** A seat whose profile has less than `review.min_capacity_pct`
  (default 10) left on its 5-hour or weekly window, as read by the usage probe, is not
  picked. An unprobed profile is not excluded. `pipeline.reviewer_allow` limits the open
  ladder to named seats (prefer tiers and author-glob pools stay eligible).
  `pipeline.service_profiles` names shared logins whose seats may review each other.
- **Lane size.** A lane that changes more than `pipeline.max_lane_files` (default 40) files
  gets a `size` note once and a warning sentence in the review ping.
- **First pass on a seat.** `review.first_pass` (`enabled`, `seats`, `dir`, `timeout_min`)
  asks the least-loaded listed seat with capacity, never the author or a seat of the same
  person, to read the diff once and write `wave-firstpass-<sha8>-<yyyymmdd>.md` ending in
  `FIRST PASS: PASS` or `FIRST PASS: NEEDS FIXES`. Events `pipeline.first_pass_requested`,
  `pipeline.first_pass`, `pipeline.first_pass_timeout`. The result is one line to the
  assigned reviewer and, on NEEDS FIXES, to the author. It is never a verdict and cannot
  stage anything; the freeze ingester does not read the file.
- **Shared inbox routing.** `paths.inbox_watch` may include the freeze inbox. There only
  `.md`/`.txt` files with a `To: @seat` line or a `<author>-to-<recipient>-…` name are
  announced; `-to-` names go to the recipient, never the author; logs, receipts, freeze and
  verdict files are left to the freeze watcher; `wave-firstpass-*` files are recorded.

## Merge queue for main (25 Oct 2026)

Approved for Wavepulse main only; see `docs/merge-queue.md` for the rules. WaveCode
merges an eligible freeze into main itself: exact SHA and `TIER:` in the note (ask forced
by `ask_paths` and the migrations directory), quick and API gate green on that SHA, the
tier's reviews (`ask` = two PASS verdicts from non-authors on different credential
profiles, from the new `freeze_verdicts` ledger), the remote lane still at the SHA, a pull
request, and migrations numbered after main's. Serial per project; `--no-ff` merge in
`<repos>/.wavecode-merges/`, optional `version_command` folded into the merge commit, the
full suite run once on the merge SHA (`merge_queue.gate_command`, never skipped), plain push, bounce on
conflict or RED, re-merge when main moved. Kill switch = config `enabled` plus the runtime
flag (Reviews page or `POST /api/merge-queue/:project/switch`). Events `merge_queue.queued`,
`merge_queue.merged`, `merge_queue.bounced`, `merge_queue.requeued`, `merge_queue.switch`;
one line per merge or bounce in `maestro_log`.

- `GET /api/merge-queue[?project=]` — `{ switches: [{ project, config_enabled, enabled, enabled_by, queued }], rows: [...] }`.
- `POST /api/merge-queue/:project/switch` `{ enabled }` — admin.
- `POST /api/merge-queue/:sha/priority` `{ priority }` — 0 to 9, admins only.
- `POST /api/merge-queue/:sha/requeue` `{ reason }` — admins only; returns a bounced row whose freeze is still live to waiting (404 unknown SHA, 409 not bounced or freeze closed). Event `merge_queue.requeued`.
- `POST /api/merge-queue/:project/reset` `{ reason, states }` — admins only; `states` (a non-empty list of `waiting` and/or `bounced`) is required, 400 without it. Event `merge_queue.reset`.
- `GET /api/deployable/:sha?project=` — may this exact SHA go to production? `deployable`, `exit_code` (0 yes, 2 no, 1 error), `checks` (`on_main`, `contains_prod`, `quick`, `api`, each `{ok, text}`), `reasons[]`, `main_sha`, `prod_sha`, the gate report. `GET /api/deployable` lists what production runs per project. `POST /api/deployable/prod-sha {project?, sha}` (admin) records it; event `prod.sha`.
- `GET /api/gate-status/:sha?project=&require=quick,api` — the one checker (docs/merge-queue.md "One checker"): per-suite state, the run used, the verdict and its exit code, everything found for the SHA and why it does not count. Event `gate.result` is written by the queue's merge gate and the pipeline's gate runs (one immutable record per run).
- `POST /api/merge-queue/:project/reset` `{ reason, states? }` — admin; every waiting or bounced row (`states` narrows it to `["bounced"]` or `["waiting"]`) of the project turns superseded with the reason and its open freeze is closed as `stale`; queued, merging, merged and superseded rows are untouched, no branch is touched. Returns `{ reset: [{ sha, lane, was, freeze }], untouched: { state: n } }`. Event `merge_queue.reset` (one per reset, with the SHAs).
- `POST /api/merge-queue/:project/resolve` `{ shas, reason, status? }` — admin; closes the listed freezes (`stale` by default, or `merged`) with the reason and supersedes their rows; returns `{ resolved, skipped }`. Event `merge_queue.resolved`. Every pass also emits `merge_queue.pass` and the switch view carries `last_pass_at`.
- `GET /api/reviews/board` — cards carry `queue: { state, reason, tier, position, merge_sha, pr } | null`;
  the board carries `merge_queue: { projects, can_switch }`.

## Gate flood fix (25 Oct 2026, evening)

The startup backfill of the day's freeze notes no longer starts the pipeline for them
(`IngestOptions.silent`); on 25 Oct a restart re-read some 250 notes and submitted an API
gate for each. `pipeline.gate_max_inflight` (default 3) caps the full gates one daemon runs
per project; further freezes show QUEUED and wait in WaveCode (`gate` note "waits for a
slot") until a slot frees. After a restart, freezes left at QUEUED or RUNNING are settled
from the test history when `tests` is configured, resubmitted once when the dispatcher
never saw them and the freeze is under six hours old, and otherwise noted.

## Testing rule change (25 Oct 2026, evening)

Per the testing study: on push the agent runs lint, types and the related tests locally;
at freeze one narrower run per branch (quick suite plus the API tests for the changed
parts); the merge queue runs the full suite once on the merged code; a nightly full run on
main. In WaveCode: `auto_gate` stays off, and the merge queue always runs
`merge_queue.gate_command` (default `pipeline.gate_command`) on the merge result instead of
reusing the lane's gate when the trees matched.

## Test-server polling cut (25 Oct 2026, night)

The reconcile pass asked the test server for status and history on every freeze
(4,923 of them), about 950 runner commands a minute. Now: identical reads share one
command, at most three runner commands run at once, and a pass reads sparingly
(`readLaneTestsSparingly`): an open freeze under three days old live, an older open one
at most every six hours and not at all once its words are settled, every other one
(behind main, merged, stale) from the cache only, unless its words were still pending. The merge queue evaluates only the
newest open freeze per lane frozen within two weeks, and one `ls-remote --heads` per
pass replaces a `git fetch` per lane.

## Post-pass freeze and lanes-board reads (26 Oct 2026)

After every reconcile pass the daemon stopped answering for four to five minutes: the
review-reassignment loop re-read and re-parsed the `pipeline.review` events for every
candidate seat of every waiting freeze, synchronously. It now reads the events once per
pass, memoises each seat's load (`loadMemo`), and searches for a new reviewer only when
the freeze has waited past the limit and its reviewer is busy. The lanes board reads a
lane's test history live only for a fresh open freeze, every ten minutes for a lane
behind main or long frozen, every three for a lane without a freeze, and no longer warms
the behind-main count for closed freezes. `review_reassign`, `pipeline_tick` and
`merge_queue` are timed in `/api/health/perf`.

The 25 s stall left in the pipeline tick was `overdueFirstPasses`: every lookup by
event type scanned the whole `events` table (no index began with `type`). The new
`idx_events_type_entity (type, entity_id, id)` serves those lookups. The hot-run poller
now follows only the lanes whose own run is queued or running (at most 40), not every
lane on the board; the lanes board reads a lane without a freeze every fifteen minutes
and a lane behind main every thirty.
Views built without runs (`viewShaChecks` for cards, stage blocks and the board route) are
served from a report up to ten minutes old; the pipeline's green decision and the
production promote check still read fresh.

## Merge queue stabilisation (26 Oct 2026)

Maestro's brief, approved by Denis: eligibility by evidence, not by branch name.

- No allowlist. `merge_queue.deny_lanes` (default `main`, `master`, `release/*`, `prod-*`,
  plus the project's main branch) is the only name rule; `laneRefError`'s `lane_glob` no
  longer applies to the queue.
- Every tier needs one PASS on the exact SHA from a non-author on a **different credential
  profile** than the builder (`independentPasses`). Ask tier adds the `github.ok_label`
  (default `ask-tier-approved`) on the open pull request. A `github.hold_labels` label
  parks the lane (`MIGRATION_HOLD`). No `TIER:` line means `show`.
- `merge_queue.github { repo, token_file, ok_label, hold_labels }`: `gh auth status` before
  every pass with the token from `token_file` as `GH_TOKEN` (never logged), then one
  `gh pr list --json number,headRefName,headRefOid,labels` per pass. Failure: every lane
  `GH_AUTH_MISSING`, nothing merges.
- `Eligibility.code` and `merge_queue.reason` start with the code: `GATE_NOT_GREEN`,
  `NO_PASS_ON_SHA`, `NEEDS_FIXES`, `ASK_TIER_NO_OK`, `MIGRATION_HOLD`, `LANE_MOVED`,
  `LANE_GONE`, `LANE_DENIED`, `NO_PR`, `MIGRATION_COLLISION`, `GH_AUTH_MISSING`,
  `QUEUE_OFF`, `NOT_CONFIGURED`, `NO_REPO`, `CHECK_FAILED`.
- Stall alarm (`checkStall`, every merge-queue tick): `stall_minutes` (default 30) →
  `<stall_dir>/wavecode-queue-stall-<yyyymmdd-hhmm>.md`, event `merge_queue.stall`
  `{ project, code, text, file, at }`, kv `merge_queue.<project>.stall` (JSON, cleared on
  progress) and `.stall_written` (throttle). `GET /api/merge-queue` now returns `stalls`.
- Verdicts land on `behind-main` freezes too (they were a noop): the queue merges main for
  such a lane, so its review must count.
- Review on request: inbox file `<you>-<lane>-review-request-<sha8>.md` (`Lane:`, the SHA,
  optional `Reviewer:`) → `pipelineHooks.onReviewRequest` → `requestReviewFor(sha, { reviewer, by })`
  in `lane-pipeline.ts`; event `pipeline.review` entity `<sha>:request`. The backfill after a
  restart does not replay requests. `POST /api/reviews/lanes/request-review` accepts a
  missing `reviewer` and picks one.
- Reviews page: a "Merge queue" panel (`MergeQueueFlow`) draws the flow from
  `GET /api/merge-queue`: the stall first, then merging, queued (in order), waiting with
  code and step, and the last bounces and merges.

## Slack bridge (26 Oct 2026)

`slack:` in config.yaml starts a Socket Mode bridge (docs/slack-bridge.md): a DM or @mention
becomes a prompt to a seat through the same path as `POST /api/agents/:id/send` (now
`prompting.ts`: liveness, persona, send-keys, `agent.prompt_sent`, reply capture), and the
captured reply is posted in the Slack thread. Events `slack.prompt`, `slack.reply`,
`slack.refused`. No new HTTP routes. `POST /api/agents/:id/send` is unchanged on the wire; raw
keys still record `agent.prompt_sent` and capture no reply.
