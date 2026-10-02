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

### 4.4 Board is collapsible

The right-hand Board (task swimlanes by owner, review-queue count, goal
rollups) collapses to a 40px rail showing only badges (open tasks, pending
reviews, attention count); a click expands it. Default: collapsed when the
viewer owns no running tasks, expanded otherwise. The state is React state
for the session (no browser storage). The thread takes the freed width.
Same for the Roster on narrow desktops (≤1100px): collapse to avatars.

## 5. Credential profiles — one subscription per developer

Problem: every CLI stores its login in the home directory, so all agents
under one Unix user share one subscription (rate limits hit together, and
vendors treat one login driving N concurrent agents as abuse). Separate
Linux users would fix it but cost sudo plumbing and cross-user tmux. The
CLIs expose relocation knobs instead, so WaveCode gets **profiles**: a named
credential directory per developer that an agent's runtime process is
pointed at.

### Config

```yaml
profiles_root: /home/ci/profiles          # <root>/<profile>/{claude,codex,grok-home}
profiles:
  denis: { }                               # dirs are created on first login
  ana:   { }
  service: { shared: true }                # referee-style seats; admin-only
```

Per-runtime env injected at launch (template vars `{profile_dir}`):

| runtime | env |
|---|---|
| claude-code | `CLAUDE_CONFIG_DIR={profile_dir}/claude` |
| codex | `CODEX_HOME={profile_dir}/codex` |
| grok | `HOME={profile_dir}/grok-home` (no profile flag; HOME override for that process only, PATH preserved) |

Runtime config gains `env: { KEY: "template" }`; `buildRuntimeCommand`
prefixes `env KEY=value … <command>` using the same strict value alphabet as
model pins (profile names `^[a-z0-9][a-z0-9_-]{0,31}$`). Applies to spawn,
restart, upgrade, and file-runner seats.

### Schema / binding

- `users.profile TEXT` (default = user name), `agents.profile TEXT NOT NULL`.
- `spawn_agent` / `POST /api/agents/spawn` use the caller's profile unless
  admin passes `profile` explicitly; the agent record keeps it for restarts.
- **Free means profile-compatible**: a free agent on profile P is
  dispatchable only for tasks created by users whose profile is P (or by
  admin targeting a `shared` profile). Otherwise it is listed as
  *free (other subscription)* and skipped — nobody's task may burn
  someone else's quota. §2 rule 6 gains this predicate.

### Login without SSH

`POST /api/profiles/:name/login {runtime}` (owner of the profile or admin)
opens a throwaway tmux seat `wc-login-<profile>-<runtime>` with the
profile env running the runtime's login command (`claude /login`,
`codex login`, `grok`). It is registered as a normal adopted agent so the
developer opens it in AgentView, reads the device-code URL, and finishes
OAuth on their phone; the seat is killed on exit or after 15 minutes.
`GET /api/profiles` reports, per profile and runtime, whether a credential
file exists (never its contents).

### Not security, by design

Profiles separate *subscriptions*, not *access*: any process under the
service user can read any profile directory. That is acceptable for a
trusted team and is exactly the gap per-Linux-user isolation (spec F2)
closes later — when it does, a profile maps to a Unix user and the env
prefix becomes `sudo -u`, with nothing else changing.

## 5b. Reply capture — agents answer in the thread, not only in their pane

Problem (first live test): the thread shows events *about* agents but never
what an agent *said* — its answer stays in the terminal pane, so asking the
PM seat "what is chatgpt-countix doing?" produces nothing in the thread,
and every reply has to be read by opening the agent. The conversation must
feel like chat: you ask, the agent's answer appears as its message.

### Server: `reply-capture.ts`

- When a prompt is sent to a tmux agent (`POST /api/agents/:id/send`
  non-raw, MCP `send_prompt`, reply injection from `/api/messages`), record a
  **pending reply** `{agent_id, actor_id, prompt_excerpt, sent_at,
  pane_marker}` where `pane_marker` is the pane's line count / last line at
  send time.
- On the agent's next *working → idle* transition (output-watcher), extract
  the answer: the text produced after `pane_marker`, with the runtime's TUI
  chrome stripped (Claude: tool-call blocks `● Running…`/`⎿`, spinner lines
  `✻ … done`, the prompt box `❯`, status bar; Codex: `›` composer, status
  line; Grok: equivalent). Keep the final assistant prose (max 4 000 chars,
  head+tail if longer). Per-runtime extractors live in one table with tests
  on real pane captures.
- Persist it as an `agent_messages` row: `from_agent_id = agent`,
  `to_agent_id = null`, `message_type = 'reply'`, `ref_prompt_actor =
  actor_id`, `ref_task_id` when the prompt was a task dispatch; emit
  `message.created`. The thread renders it as kind `reply` with the agent's
  name and color, directly under the prompt it answers.
- If no idle transition arrives within 10 min, post a `reply` with
  `truncated: true` containing whatever was captured so far — never silence.
- Task runs: the final RESULT line/reason is already captured; the run's
  prose summary (same extractor at `run.finished`) is attached to the `run`
  thread item so "what did it do" is answerable without the pane.

### UI

- Composer default target = the **orchestrator seat** (config
  `orchestrator_agent: pm`, or the first agent named `pm`/`orchestrator`;
  a chip shows who will receive it). No selection needed to just type.
  `@name` in the text retargets.
- Thread shows `reply` items as chat bubbles (agent color, name, time);
  the terminal stays folded. The Attention filter includes replies that end
  with a question.
- "Ask" is the composer's default mode name (same as Prompt); Task / Reply /
  File unchanged.

### The orchestrator seat behaves like a PM, by default

Reference behaviour (from the Grok seat the team uses today):

> Codex2 finished all the email and eSLOG fixes, and they're ready for
> review. … Everything is tested but not deployed. Elsewhere, live is still
> 0.440.29 … I've lined up Fable to review Codex2's fixes after those.
> Deploy Codex2's email and eSLOG fixes once Fable's review passes?
> [Deploy on pass] [Hold]

- `docs/orchestrator-seat.md` is a standing operating prompt, sent to a seat
  when it is spawned or adopted with `role: orchestrator` (agents gain a
  nullable `role` column; `config.orchestrator_agent` names the default
  seat). It instructs the seat to: answer questions with a prose status
  synthesized from `list_agents`/`list_tasks`/`get_agent_output`/the wire,
  in plain language, naming agents and what they are on; end a message
  that needs a human decision with ONE question and 2–4 short options on
  their own lines prefixed `[ ]`; after a decision, carry it out with the
  tools and report each step as it lands; never claim an agent's result
  without a RESULT/verdict behind it.
- The thread renders a reply whose tail is a question + `[ ] option` lines
  as a bubble with **quick-reply chips**; tapping a chip sends that option
  text back to the same seat (the existing "RESPOND" chip code in AgentView
  is the starting point).

### Acceptance

- Send "what is chatgpt-countix doing?" to `pm` from the composer with no
  target selected → within one idle cycle a `reply` bubble from `pm` with
  the prose answer appears under the prompt; the pane was not opened.
- A reply ending with a question and `[ ]` options renders chips; tapping
  one sends the option to the seat and shows it as the user's prompt.
- A prompt to `builder` that triggers tool calls yields a reply with the
  final prose only (no `● Running…` / `⎿` lines).
- Codex and Grok seats produce replies with their chrome stripped.
- A reply never contains the echoed prompt.

## 5c. Aliases, @mentions, #commands

Agents get a short human alias; the composer gets a tiny deterministic
grammar so the common moves are one line, with the orchestrator seat as the
fallback for everything else.

- `agents.alias TEXT UNIQUE` (`^[a-z][a-z0-9_-]{1,23}$`), set via
  `PATCH /api/agents/:id {alias}` and a "rename" action on the roster card.
  Resolution order everywhere (routes, MCP, CLI, composer): alias → name → id.
- Composer grammar (parsed client-side, executed through existing routes):
  `@x text` prompt; `@x @y text` fan-out; `#reserve @x [Nh]`; `#release @x`;
  `#kill @x`; `#task @x text [deps:#n,#m]`; `#promote #n`; `#file @x path`;
  `#status` (prompt to the orchestrator seat); `@all text` broadcast.
  No `@`/`#` or unparseable → prompt to the orchestrator seat (Ask).
  Every executed command appears in the thread as the user's item.
- Autocomplete: `@` → roster (color dot, status, current task), `#` →
  commands, `#` followed by digits → open tasks. Tab/Enter accepts.
- Groups: `agent_tags(agent_id, tag)`; `#tag @x frontend`; `@frontend text`
  fans out to the group; roster filter by tag.
- Personas: `agents.persona TEXT` (one line, e.g. "frontend lead"), shown on
  roster cards and reply bubbles, and prepended to prompts as
  `[you are @toni — frontend lead]` so narrative status can name agents.
- People: `@<user>` in `wavecode msg` or the composer addresses a person;
  the message lands in their Attention filter and Telegram/ntfy mirror.

Acceptance: `#reserve @toni 2h` reserves within one request and shows the
lease on the card; `@toni @mia review each other's lane` creates two prompt
items and two pane sends; an unknown `#foo` goes to the orchestrator seat
unchanged; `@frontend` with two tagged agents sends to both.

## 5d. One orchestrator seat per user

Each developer gets their **own** orchestrator seat — own conversation
history, own standing rules, own subscription — while the worker agents
stay one shared pool governed by leases (§2). Asking in the Center talks to
*your* seat; it sees everyone's agents and may act on the free ones and
yours, exactly like you.

- **Seat = agent** with `role = 'orchestrator'`, `owner_id = <user>`,
  `lease_reason = 'seat'` (never expires, never auto-released), `profile`
  = the user's profile, name `pm-<user>`. `users.seat_agent_id` points at it.
- **Creation on demand**: "Create my seat" in the Center (and
  `POST /api/users/me/seat {runtime?}`) spawns it, registers the `wavecode`
  MCP server *inside that profile's CLI config* with a **seat token** —
  a second bearer token for the same user (`users.seat_token_hash`), so
  the seat acts as the user under the same lease/role rules and can be
  revoked without rotating the person's own token — then briefs it with
  `docs/orchestrator-seat.md` + the user's rules.
- **Rules & memory**: `users.seat_rules TEXT` (Settings → My seat; e.g.
  "always answer in Slovene", "never promote without asking me") is
  appended to the brief. The seat keeps a `SEAT.md` in its workspace with
  standing facts it learns (the brief tells it to maintain the file); the
  CLI session itself holds the conversation memory. Thread history is
  already per user via `actor_id`.
- **Routing**: Ask targets the caller's seat; `config.orchestrator_agent`
  remains the shared fallback (admin's) for users without a seat. The
  seat's replies carry the user's color.
- **Health**: a seat is a spawned agent — liveness relaunch and the
  attempt cap apply; if the seat is missing when the user asks, the
  Center offers to (re)create it rather than silently falling back.
- **Observers** get no seat (read-only role).

Acceptance: Ana and Denis each ask "what is @builder doing?" at the same
time → two seats answer in their own threads; Ana's seat gets 403 trying
to `send_prompt` to an agent Denis reserved; editing Ana's seat rules and
re-briefing changes her seat's next answer; revoking the seat token stops
the seat's MCP calls but not Ana's login.

## 5e. The project room — one shared space per project

Roles are personas, not architecture: a developer, a tester and a spec
writer are the same agent primitive with different briefs. What they need
in common is one place where the spec, the decisions, the ledger and the
test evidence live, that every seat is briefed with and every tool can
read. Today specs land in one agent's docs, reports in another's,
decisions in a table — nothing guarantees the tester reads the spec the
developer built from.

- `rooms` (`id`, `project` key from `projects.<name>` or a free name,
  `root` dir under `paths.rooms_root/<project>/`, `created_at`). The room
  folder: `SPEC.md` (what we are building), `LEDGER.md` (task ids → status
  → verdict, written by WaveCode), `DECISIONS.md` (mirror of the decisions
  table, appended), `REPORTS/` (test/QA/review reports, one file per run),
  `TEMPLATES/{build,review,verify,spec}.md` (§5f), `ROOM.md` (the PM's
  running summary: current goal, who is on what, open questions, vocabulary
  — see §5f). Agent workspaces get a `.wavecode/room` symlink to it.
- **Briefing**: every dispatch prepends the room index (file list + first
  lines of `ROOM.md`) and the task's template; the orchestrator brief tells
  the seat to read `ROOM.md` before answering and to update it after a
  decision. Replies and task prompts can reference room files by path.
- **MCP / API**: `list_docs {room}`, `read_doc {room, path}`,
  `write_doc {room, path, content}` (owner-of-room or admin for `SPEC.md`
  and templates; any seat for `REPORTS/` and `ROOM.md`), `GET/PUT
  /api/rooms/:project/docs/*`. Reports from runs (RESULT files, review
  feedback, QA findings) are copied into `REPORTS/` automatically.
- Tasks carry `room` (default: the room matching the agent's workspace via
  `projects.<name>.workspace_match`, else the user's default room).
- UI: a **Room** tab in the Center (file list, inline markdown view/edit
  for the files the user may write, "send to @agent" on any file).

Acceptance: a spec written via `write_doc` is visible in the developer's
dispatch briefing and in the tester's; a review verdict lands as a file
under `REPORTS/` and a line in `LEDGER.md`; the PM seat's answer to "what
are we building?" quotes `SPEC.md`; a user without room write access gets
403 on `SPEC.md` but can read it.

## 5f. The retro loop — learning from questions and outcomes

Learning means a curated memory plus measured prompt evolution, gated like
code. Three mechanisms:

1. **Feedback on replies.** 👍/👎 and an optional "better: …" on any reply
   bubble → `reply_feedback(reply_message_id, prompt_event_id, user_id,
   score, note)`. The seat brief tells it to read its last 20 feedback
   rows (`list_feedback` tool) at the start of a session and before long
   answers, and to keep what it learns in `SEAT.md` (§5d).
2. **Prompt templates with metrics.** Dispatch uses
   `TEMPLATES/<kind>.md` (`build`, `review`, `verify`, `spec`) with
   `{task}`, `{room}`, `{done_when}` placeholders; `tasks.template` records
   which. Per template WaveCode tracks: first-pass PASS rate (verdict pass
   on fix_round 0), mean fix rounds, questions-back rate (`request`
   messages per task), time to first RESULT. `GET /api/rooms/:project/
   metrics` and a strip in the Board rail.
3. **Nightly retro.** A scheduled task (the §F6-style timer, or `wavecode
   retro <room>`) runs on the room's PM seat: read the week's tasks,
   verdicts, fix rounds, `request` messages, feedback and the questions
   people asked; produce (a) proposed diffs to templates and `ROOM.md`
   with the evidence for each ("4/6 builds failed typecheck on first
   review → add `npm run typecheck` to build.done_when"), (b) a vocabulary
   update (questions people re-ask, the words they used, the answer shape
   that scored well). Proposals are artifacts in the review queue; a human
   approves → WaveCode applies the diff. The seat may edit `SEAT.md`
   without review.

Acceptance: a 👎 with "too long" on an inventory-style answer is visible to
the seat's next session and its next status answer is shorter; a build
template edit proposed by the retro appears in the review queue with its
evidence and applies on promote; metrics show per-template first-pass rate
after two tasks; nothing in `TEMPLATES/` or `SPEC.md` changes without a
promote.

## 6. Build order (one task each; each lands with tests)

| # | Task | Depends on |
|---|---|---|
| T0 | **Runtime liveness** (bug found in dogfooding): the dispatcher must not send-keys into a session whose runtime TUI has exited (a bare shell executes prompt lines as commands). Detect a shell prompt on the pane before dispatch and in the health-monitor tick; relaunch the runtime command first, with a `agent.runtime_relaunched` event; fail the dispatch with `task.failed {error:'runtime not running'}` if relaunch does not settle within 30s. Tests with simulated pane output. | — |
| T1 | §1 identity: `users` table + migration v10, token hashing, auth middleware resolves user, `/api/me`, `/api/users`, CLI `user add`, `actor_id` on events | — |
| T2 | §2 leases: columns, reserve/release routes, rule 2 guards on send/kill/handoff/assign, auto-lease + release in dispatcher, expiry in health monitor, events | T1 |
| T6 | §5 credential profiles: config + env injection in `buildRuntimeCommand` (all launch paths), `users.profile`/`agents.profile`, profile-compatible "free" in the dispatcher, `/api/profiles` + login seats, CLI `wavecode profile login <name> <runtime>` | T2 |
| T3 | §3 MCP: user-aware tool results, `reserve_agent`/`release_agent`/`whoami`, admin-only guards; `spawn_agent` honors profiles | T6 |
| T4 | §4.1 `GET /api/thread`: merged, typed, cursor-paged feed with per-user `actions`; `needs_attention` rules; reply injection into tmux | T2 |
| T5 | §4.2–4.3 Command Center UI: roster, thread, composer, board, presence, attention filter, mobile tabs, users + profiles settings pages (login button per runtime) | T4, T6 |
| T7 | §5b reply capture: pending-reply tracking on every prompt path, per-runtime pane extractors, `reply` messages in the thread, composer defaults to the orchestrator seat, `docs/orchestrator-seat.md` operating prompt + `agents.role`, quick-reply chips | T5 |
| T8 | §5c aliases (`agents.alias`), persona, tags/groups, composer grammar + autocomplete, people addressing | T7 |
| T9 | §4.4 collapsible Board + Roster rails with badges, thread takes the width | T8 |
| T10 | §5d per-user orchestrator seats: seat agents, seat tokens, MCP registration inside the profile, rules + SEAT.md memory, Ask routes to the caller's seat, Settings → My seat | T8 |
| T11 | §5e project room: rooms + folder layout, workspace symlink, dispatch/seat briefing with the room index + template, list/read/write_doc MCP + /api/rooms, auto-copied reports, Room tab | T10 |
| T12 | §5f retro loop: reply feedback (UI + table + `list_feedback`), templates with placeholders and per-template metrics, nightly retro task producing reviewable diffs, vocabulary notes in ROOM.md | T11 |

## 7. Acceptance

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
