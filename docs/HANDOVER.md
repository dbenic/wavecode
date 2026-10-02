# WaveCode — Agent Handover

Read this first if you are an AI agent (or human) picking up development on
WaveCode. It tells you what the system is, what was recently built, how to
work on it safely, and what to build next. Deployment-specific values
(hosts, tokens) are deliberately NOT in this public repo — they live in
`~/wavecode-ops.md` on the deployment server.

## What this is

WaveCode is a server-side daemon + mobile PWA that orchestrates multiple CLI
coding agents (Claude Code, Codex, Grok, Aider) running in tmux sessions on
one box. It dispatches a task DAG to agents, watches their terminals,
cross-reviews every finished run with a *different* agent, and gates
promotion on the review verdict. MCP exposes the whole control plane
(stdio `wavecode mcp`, or Streamable HTTP at `/mcp` with bearer auth) so
any MCP-capable client (Grok Bot, Cursor remote, Claude, a script) can
act as the orchestrator.

Read in this order:
1. `CLAUDE.md` — architecture, schema, conventions, what NOT to do
2. `docs/operating-model.md` — roles, spec sharing, checks, who tests what
3. `docs/mcp.md` — the MCP tools and the orchestration loop
4. `docs/api.md` — REST reference

## Subsystem map (src/server)

| Concern | Files |
|---|---|
| Schema + CRUD (SQLite, WAL, migrations v1→v19) | `db.ts` |
| Agent leases: reserve/release, rule-2 guards, auto-lease, expiry sweep | `leases.ts` (+ dispatcher, health-monitor, routes) |
| Identity: users, hashed tokens, roles, request actor | `users.ts`, `auth.ts`, `request-context.ts`, `routes/users.ts` |
| Agent lifecycle: scan/adopt/spawn/kill/detach/stopAll | `session-manager.ts`, `runtime-launcher.ts`, `tmux.ts` |
| Run execution (spawned agents, ndjson over Unix socket) | `runner.ts` |
| Terminal polling, idle/working detection, auto-complete | `output-watcher.ts` |
| DAG dispatch, retries, dependency gating | `task-dispatcher.ts` |
| Cross-agent review loop (verdicts, fix rounds) | `code-review.ts` |
| Human review queue (promote/retry/handoff/reject) | `review-queue.ts` |
| Event log + SSE + long-poll | `event-bus.ts`, `routes/system.ts` (`/api/events/log`) |
| Command Center feed: typed items, per-viewer actions, reply injection | `thread.ts`, `routes/thread.ts`, `routes/messages.ts` |
| Reply capture (pane → `reply` messages, run summaries) + orchestrator seat | `reply-capture.ts`, `reply-extractors.ts` (+ `__fixtures__/panes`), `orchestrator.ts`, `docs/orchestrator-seat.md` |
| Aliases / personas / tag groups / people addressing; composer grammar | `agent-identity.ts`, `db.resolveAgent`, `routes/agents.ts` (tags), `cli/msg-command.ts`, `ui/src/utils/composer-grammar.ts` |
| One orchestrator seat per user (seat lease, seat token, MCP registration, rules, My seat) | `seats.ts`, `seat-mcp.ts`, `routes/seat.ts`, `ui/src/views/MySeat.tsx` |
| Project rooms (SPEC/ROOM/LEDGER/DECISIONS/REPORTS/TEMPLATES, briefing, reports, docs API) | `rooms.ts`, `routes/rooms.ts`, MCP `list_docs/read_doc/write_doc`, `ui/…/RoomView.tsx` |
| Retro loop: reply feedback, per-template metrics, proposals (apply on promote), nightly retro | `feedback.ts`, `metrics.ts`, `proposals.ts`, `retro.ts`, CLI `retro`, `ui/…/RoomProposals.tsx` |
| Command Center UI (default route `/`): roster, thread, composer, board, presence, Users page | `ui/src/views/CommandCenter.tsx`, `ui/src/components/command-center/*`, `ui/src/utils/command-center.ts`, `ui/src/views/Users.tsx` |
| Agent wire (messages) | `routes/messages.ts`, CLI `wavecode msg` |
| MCP control plane | `../mcp/tools.ts` (stdio `wavecode mcp` + HTTP `/mcp`) |
| Health / crash / hang | `health-monitor.ts` |
| Runtime liveness (TUI exited → bare shell): relaunch before dispatch + on tick | `runtime-liveness.ts` |
| Credential profiles: env per runtime, spawn profile, free rule, login seats | `profiles.ts`, `profile-validation.ts`, `login-seats.ts`, `routes/profiles.ts`, CLI `profile login` |
| NL command chat (reactive LLM PM) | `command-chat.ts`, `llm-provider.ts` |

## Recently landed (see git log for detail)

-1. **Reviewer assignment ladder** (`reviewer-ladder.ts`, 2026-10-02):
   explicit → task → `default_reviewer` → free tagged `review` → any free
   agent → "needs a reviewer" (pending placeholder, retried whenever an
   agent goes idle). Other vendor preferred, never the author, PM seats and
   reserved/busy/other-subscription agents are not "free". Auto picks are
   posted in the thread with "→ @alt" chips; `#review #n @x`,
   `POST /api/ai-reviews/:id/reassign`, `POST /api/tasks/:id/reviewer`,
   `tasks.reviewer` (schema v20), `review.auto_pick`.

0. **Per-project referee** — `projects.<name>` in config (workspace glob +
   gate command). Matching agents skip LLM `verify_completion`; promote
   requires a stored `RESULT GREEN|RED` from the referee. RED is allowed
   only when failing test *files* are a subset of the newest nightly
   `*-full.log`. No schema bump (RESULT JSON in `kv_settings`).
1. **Agent pinning** — `agents.model` + `agents.effort` (`low|medium|high|xhigh`),
   injected into runtime commands via per-runtime `model_flag`/`effort_flag`.
   Pins are shell-embedded, so they are validated with a strict alphabet at
   BOTH the route layer (`validate.ts`) and `session-manager.spawnAgent`.
   Never relax one without the other.
2. **Kill switch** — `POST /api/agents/:id/kill`, `POST /api/system/stop-all`
   (kills spawned, Ctrl+C's adopted, disables auto-dispatch), UI buttons.
3. **Automatic review loop** — on `run.finished`, `maybeAutoReview` assigns a
   reviewer that is never the author (`resolveReviewerAgentId`: name →
   runtime → LLM-direct). Verdicts parse ONLY from a standalone
   `VERDICT: <value>` line (`parseVerdict`) — the prompt template line
   cannot match, and unparseable feedback is `needs-fixes`, never a pass.
   Non-pass feedback auto-returns to the author (`sendFixesToAgent`), the
   next round starts when the author goes idle (`onAuthorAgentIdle`),
   bounded by `review.max_fix_loops`. `promote()` refuses without a pass
   verdict when gated (`auto_review` or `require_pass_to_promote`) unless
   given an `overrideReason`, which is stored in the audit event.
   Optional `review.gate_dependents_on_approval` makes the DAG advance on
   human approval instead of mere completion.
4. **MCP control plane** — same tools in `tools.ts` over stdio (`wavecode mcp`)
   and Streamable HTTP (`/mcp` on the daemon, bearer / Tailscale). Connection
   via `--token` / `WAVECODE_TOKEN` / `auth.fallback_token` (same
   `resolveDaemonConnection()` as `wavecode queue`). Includes `await_events`
   and `get_run_result`. Grok Bot / Cursor remote use URL + bearer, not SSH.
5. **The wire** — `wavecode msg <to|all> "<text>" --type result --task <id>`
   for agents to report back; mirrors to `/api/messages` + `message.created`
   events.
6. **Multi-orchestrator** (docs/multi-orchestrator-spec.md, built by the
   builder agent as a T0–T6 DAG and cross-reviewed before merge):
   - *Identity*: `users` (sha256-hashed bearer tokens, roles
     admin/developer/observer), `wavecode user add`, `/api/me`, `actor_id`
     on every event. `auth.fallback_token` = synthetic admin `owner`.
   - *Leases*: `agents.owner_id/lease_reason/lease_expires_at`; owner-or-admin
     guards on send/kill/detach/handoff/send-fixes; auto-lease on dispatch;
     expiry sweep never yanks a working agent; stop-all and override-promote
     admin-only. Command chat is **admin-only** until its tools enforce this.
   - *Profiles*: `profiles_root` + `profiles:` in config; per-runtime env
     (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `HOME` for grok) injected via a
     strictly validated `env` prefix; "free" agents are profile-compatible
     only; `wavecode profile login <name> <runtime>` or dashboard login seats.
   - *Thread + Command Center*: `GET /api/thread` (typed, cursor-paged,
     per-viewer `actions`, long-poll) and the 3-pane UI as default route.
   - *Runtime liveness (T0)*: dispatch and manual send refuse a bare-shell
     pane; the monitor relaunches **spawned** sessions only, capped at
     `MAX_RELAUNCH_ATTEMPTS`, then marks the agent `error`.
7. **Agents answer in the thread (T7, spec §5b)** — `reply-capture.ts` tracks
   every prompt sent to a pane and, on the next idle, lifts the answer out
   with per-runtime extractors (`reply-extractors.ts`, fixtures in
   `__fixtures__/panes/`) into an `agent_messages` row of type `reply`.
   Replies are only trusted when anchored to the prompt echo (or Claude's
   `[Pasted text #N]` placeholder); otherwise the 10-minute fallback posts
   them as `truncated`. A superseded prompt still gets a truncated reply —
   never silence. The orchestrator seat (`agents.role`,
   `config.orchestrator_agent`, brief in `docs/orchestrator-seat.md`) is the
   composer's default target and answers like a PM with `[ ]` option chips.
8. **Aliases, personas, groups, grammar (T8, spec §5c)** — `agents.alias`
   (unique, `^[a-z][a-z0-9_-]{1,23}$`), resolution is **id-first for
   ULID-shaped refs**, then alias → name; spawn/adopt refuse names that
   collide with an id or alias. `#reserve/#release/#kill/#task/#promote/
   #file/#status`, `@x @y` fan-out, `@group`, `@person`; `#kill`/`#promote`
   confirm. `@person` notification mirrors carry no body (channels are
   per-install, not per-user).

9. **Per-user seats, project rooms, retro loop (T10–T12, spec §5d–§5f)** —
   `pm-<user>` seat agents on the user's profile with a revocable seat
   token registered **only in the seat workspace's project MCP config**
   (never a profile-wide CLI config: workers would inherit the identity);
   seat tokens are tagged (`via_seat`) and may not mint/rotate tokens,
   manage users, create seats, record feedback or start retros. Rooms:
   `paths.rooms_root/<project>/` with SPEC/LEDGER/DECISIONS/REPORTS/
   TEMPLATES/ROOM.md, `.wavecode/room` symlink in workspaces, write rules
   enforced on disk (canonical copies + `room.integrity_restored`), atomic
   doc writes with `expected_modified_at` → 409, byte-capped dispatch
   briefings. Retro: 👍/👎 on replies (people only; a personal seat's brief
   folds in only its owner's and admins' notes), per-template metrics,
   proposals applied only on promote, nightly retro into the room owner's
   seat.

## Working on this codebase

- `npm install && npm --prefix src/ui install`, then `npm test` (all green;
  keep it that way), `npm run typecheck`, `npm run build`.
- Conventions are in CLAUDE.md and enforced by review: typed result objects
  (`{ok, data|error}`), no throwing from handlers, ulid ids, pino logs, SSE
  not WebSocket for live data, Tailwind only, tests co-located.
- Every behavior change lands WITH tests in the same change. The suite is
  the safety net for a daemon that runs unattended.

Test-suite gotchas that will bite you:
- `vi.clearAllMocks()` clears calls, NOT implementations — a
  `mockReturnValue` in one test leaks into the next. Use
  `mockReturnValueOnce` for per-test stubs (see `session-manager.test.ts`).
- Route tests mock modules with explicit export lists — when you add an
  export to `db.ts`/`session-manager.ts` used by a route, add it to the
  `vi.mock` factories in the affected `*.test.ts` files or they throw.
- `validate.ts` imports from `db.ts`; tests that mock `db.js` must provide
  `EFFORT_LEVELS`/`isEffortLevel`.
- New tables belong in BOTH `SCHEMA_SQL` (fresh DBs) and a migration
  (existing DBs); bump `SCHEMA_VERSION`. Lazily-created tables (e.g.
  `code_reviews` pre-v9) are upgraded via guarded `ALTER TABLE` in their
  `ensure*Table()`.

## Deployment shape (specifics in ~/wavecode-ops.md on the server)

- systemd unit `wavecode.service` running `node dist/cli/index.js server
  start --foreground` as the service user; config in `<repo>/config.yaml`
  (mode 600, contains the auth token — never commit it).
- Runtimes configured: claude-code, codex, grok (+aider); each with
  `model_flag` for pin injection.
- Review loop is ON in production: `auto_review: true`,
  `default_reviewer: codex`, `require_pass_to_promote: true`.
- The Claude CLI on the box has the `wavecode` MCP server registered
  (user scope) — any `claude` session there is orchestration-capable.

### Target layout (decided 2026-10-02): two machines, two trust zones

- **Dev box** `countix-dev` (188.40.85.171, Hetzner AX102, Ubuntu 26.04): WaveCode + every agent in tmux + the
  per-developer credential profiles. No production secrets, ever. Provision
  with `scripts/provision-dev-box.sh` (root, idempotent): service user `wave`,
  Node 22 via nvm, CLIs, build, `config.yaml` with `profiles:` per developer,
  systemd, Tailscale, ufw (SSH + tailnet only). Then each developer runs
  `wavecode profile login <name> claude-code|codex|grok` once per CLI so their
  agents and personal seat run on *their own* subscription (spec §5).
  Linux users: `denis` (sudo) and the `wave` service user; group `wavedev` may
  `sudo -iu wave`. Profiles `denis dev1 dev2 dev3` (placeholders until the
  developers are known; rename = mv dir + config key). Developers log in with
  `wave-login <runtime> [profile]`. Ops note: `/home/wave/wavecode-ops.md`.
- **Old box** (136.243.8.205): becomes CI runner + staging + release host.
  Hand-offs move to GitHub PRs; the CI verdict per sha gates promote (gap F1).
- Migration: copy `.wavecode-data/rooms/` across (docs are the source of
  truth); recreate agents and users on the new box rather than copying the DB.

## Known gaps — the next work, in priority order

1. **Ownership-aware command chat** — `command-chat.ts` tools (`send_prompt`,
   `send_instruction`, `handoff_file`, `spawn_agent`) bypass leases and
   profiles, so `/api/chat/send` is admin-gated. Pass the acting user into
   `commandChat.chat()` and guard each agent-targeting tool, then lift the
   gate.
1b. **Daemon restart must be safe for in-flight work** — the startup
   reconcile fails orphaned running tasks AND sends an interrupt into the
   agent's session ("Interrupted · What should Claude do instead?"), so a
   deploy mid-task both mis-closes the run and stops the agent. Observed
   twice while dogfooding. Required: never signal a live session on
   restart; re-attach to the open run (pane still changing → keep it
   `running`), and reconcile `result.txt` PASS back to `done` *and* unblock
   dependents (today only `result` flips, status stays `failed`). Until
   then: pause `auto_dispatch`, deploy only when agents are idle.
1e. **Nightly retro marks the day done before it succeeds** — a transient
   failure (dead seat runtime at `retro.hour_utc`) skips the day; write the
   marker after success and skip when a retro prompt is still pending.
   Also validate `retro.hour_utc` (0–23) and `window_days` (≥1).
1f. **Retro evidence and `GET /api/feedback` without `agent`** mix all seats
   and rooms; scope "what people asked" to the room's seat(s).
1d. **False idle-close** — a run was auto-closed FAIL while the agent paused
   between steps (no `result.txt` yet); the agent later wrote PASS. The
   idle-close should wait for a RESULT file or a long quiet period, not the
   first idle tick.
1c. **Headless reviewer seats** — the Codex TUI does not accept a pasted
   multi-line review prompt via tmux; reviews via Codex need `codex exec
   -s read-only` (file-runner style). Claude TUI reviewers work.
2. **Escalation timers (spec F6)** — agent silent N hours on an active task
   → notify orchestrator; orchestrator silent M hours → notify human.
   `health-monitor.ts` only covers crash/hang of `working` agents today.
3. **Gate-verdict binding (spec F1)** — landed as a per-project referee
   profile (`projects.<name>.gate` in config). Matching workspaces invoke
   the configured command after `run.finished`, persist the RESULT line on
   the run (kv, no schema bump), and `promote()` treats that RESULT as the
   only test evidence. Unmatched workspaces keep today's behavior. The
   review loop still reviews diffs; a human "known-red" override cannot
   substitute for a missing RESULT.
4. **Resident orchestrator loop** — command-chat is reactive-only. A
   daemon-hosted loop (LLM + command-chat tool set, woken by events) would
   let the PM survive client disconnects.
5. **Per-agent Unix isolation (spec F2)** — one user per agent + per-agent
   deploy keys. Today isolation is behavioral (workspaces + review gate +
   GitHub branch rulesets).
6. **Runtime tuning** — `grok` idle_pattern is a placeholder; verify against
   the real TUI. Claude first-run "Yes, I accept" is dismissed by the
   output watcher; saved accept flags remain a nice-to-have.

## Non-negotiables (do not "fix" these)

- A developer agent's self-report is never evidence; only reviews/verdicts.
- The author never reviews its own work — `resolveReviewerAgentId` must
  keep refusing the author.
- An unparseable review verdict is never a pass.
- Promotion without a pass verdict requires a stored override reason.
- No git push implementation inside WaveCode (sandbox rule in CLAUDE.md);
  branch enforcement lives at the git host (rulesets/deploy keys).
