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
Discover tmux sessions on the server.

### `POST /api/agents/adopt`
Adopt an existing tmux session.

Body:
`{ sessionName: string, runtime: "claude-code" | "codex" | "aider", name?: string }`

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

### `GET /api/tasks`
List tasks.

Query:
`status`, `agent_id`

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
(`promote | stage | reject | nudge | reassign | refreeze | info`) and a digest — stored, emitted as
`overlord.report`, posted as a thread item whose recommendations are buttons, and sent as a
notification when the digest changed. It never promotes, stages or types into an agent by itself.

```yaml
llm:
  anthropic_api_key: sk-ant-…        # or ANTHROPIC_API_KEY in the service environment
overlord:
  enabled: true
  model: claude-sonnet-5-5
  heartbeat_min: 30
  max_wakes_per_hour: 12
  debounce_s: 45
  notify: true
```

- `GET /api/overview` → `{ board, report, overlord: { enabled, model, heartbeat_min, max_wakes_per_hour } }`
- `GET /api/overview/reports?limit=` — past reports, newest first.
- `POST /api/overview/wake` `{ force? }` — admin: ask now (the hourly cap still applies unless `force`).

## Releases

Releases are records, not chat (`src/server/releases.ts`). A person presses **Stage** (automated
staging deploy, no GO) or **Promote** (the production GO) on a freeze card or in the Release
view; the daemon posts a release request to the project's `release_peer` box, which hands it to
its deploy agent (`releases.deploy_agent`) as one prompt with the right header and waits for
the agent's report. The requester mirrors the outcome, so `/release` shows what is on staging
and in production per lane.

Record fields: `id, project, sha, lane, target ('staging'|'production'), desk, reviewer,
requested_by, origin ('local'|'peer'), peer, peer_request_id, origin_id, run_id,
deploy_agent_id, status ('requested'|'sent'|'deployed'|'failed'|'rejected'), version,
deployed_sha, report, error, created_at, updated_at, reported_at`.

- `GET /api/releases?project=&sha=&target=&status=&limit=` — newest first.
- `GET /api/releases/:id`
- `POST /api/reviews/:runId/stage` — stage a freeze card (any verdict; never a stale SHA). 202 with the record.
- `POST /api/reviews/:runId/promote` on a freeze card creates the production request (the GO) after the usual rules.
- `POST /api/releases` `{ sha, target, project?, lane?, desk?, reviewer?, requested_by?, origin_id?, origin_box? }` —
  deploy side: accept a request (a peer's restricted token, or a local user; production locally is admin only).
  Idempotent while a request for the same SHA + target is open. The deploy agent receives
  `[Release GO <id> from <person> via WaveCode Promote …]` or `[Staging request <id> … Automated …]`.
- `POST /api/releases/:id/report` `{ status: 'deployed'|'failed'|'rejected', sha?, version?, note? }` —
  the deploy agent's outcome (MCP `report_release`, or the pane line `RELEASED <id>: deployed <sha> version <x.y.z> to <target>`
  / `RELEASE FAILED <id>: <why>`, detected by the watcher). A deployed report must name the requested SHA.
  Final: a second report is a no-op.
- Events: `release.requested`, `release.reported` (entity `release`). Both are visible to a peer's
  restricted token so the requester can mirror them; a deployed/failed outcome also notifies (ntfy / push).

## Reviews

### `GET /api/reviews`
List review queue items.

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
- a line `VERDICT: PASS` or `VERDICT: NEEDS FIXES` (a line naming both is a request, not a verdict);
- `Author: @x`, `reviewer X` / `Independent reviewer: X`, `Lane:`/`Branch:`, `Project:`, `Desk #n`;
- a freeze note may carry the reviewer's verdict inline: `@codex3 **VERDICT: PASS** on this exact SHA: /path/to/review.md`.

Server rules on `POST /api/reviews/:runId/promote` for a freeze card:
- only an independent `PASS` on the exact SHA promotes (non-PASS needs an admin `overrideReason`, stored in `review.promoted`);
- the reviewer must differ from the author (a self-review file is refused at ingest);
- a newer freeze on the same lane, or a lane tip that moved, marks the older SHA `stale` (`review.superseded`); a stale SHA is refused, override or not;
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
