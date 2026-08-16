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
promotion on the review verdict. A stdio MCP server exposes the whole
control plane so any MCP-capable client (a Claude session, Grok, a script)
can act as the orchestrator.

Read in this order:
1. `CLAUDE.md` — architecture, schema, conventions, what NOT to do
2. `docs/operating-model.md` — roles, spec sharing, checks, who tests what
3. `docs/mcp.md` — the MCP tools and the orchestration loop
4. `docs/api.md` — REST reference

## Subsystem map (src/server)

| Concern | Files |
|---|---|
| Schema + CRUD (SQLite, WAL, migrations v1→v9) | `db.ts` |
| Agent lifecycle: scan/adopt/spawn/kill/detach/stopAll | `session-manager.ts`, `runtime-launcher.ts`, `tmux.ts` |
| Run execution (spawned agents, ndjson over Unix socket) | `runner.ts` |
| Terminal polling, idle/working detection, auto-complete | `output-watcher.ts` |
| DAG dispatch, retries, dependency gating | `task-dispatcher.ts` |
| Cross-agent review loop (verdicts, fix rounds) | `code-review.ts` |
| Human review queue (promote/retry/handoff/reject) | `review-queue.ts` |
| Event log + SSE + long-poll | `event-bus.ts`, `routes/system.ts` (`/api/events/log`) |
| Agent wire (messages) | `routes/messages.ts`, CLI `wavecode msg` |
| MCP control plane | `../mcp/tools.ts` (`wavecode mcp`) |
| Health / crash / hang | `health-monitor.ts` |
| NL command chat (reactive LLM PM) | `command-chat.ts`, `llm-provider.ts` |

## Recently landed (see git log for detail)

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
4. **MCP control plane** — `wavecode mcp` (stdio) with 19 tools wrapping the
   REST API; config via `WAVECODE_URL`/`WAVECODE_TOKEN`. Includes
   `await_events`: cursor-based long-poll so an orchestrator loop costs one
   call per idle minute and misses nothing.
5. **The wire** — `wavecode msg <to|all> "<text>" --type result --task <id>`
   for agents to report back; mirrors to `/api/messages` + `message.created`
   events.

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

## Known gaps — the next work, in priority order

1. **Token roles** — one bearer token holds all authority. Split into
   orchestrator / observer / human-only (override-promote, stop-all stays
   human+orchestrator). Prereq for letting a cloud bot hold a seat safely.
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
