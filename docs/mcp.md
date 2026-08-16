# WaveCode MCP Server

WaveCode exposes its full orchestration surface over the Model Context
Protocol, so any MCP-capable agent — Grok, Claude, a custom bot, a script —
can drive it exactly like the web UI: spawn and kill agents, dispatch tasks,
read output, and work the review loop. The MCP layer is a thin wrapper over
the REST API (`docs/api.md`); it holds no state of its own and enforces
nothing the API doesn't — every rule (promote gating, pin validation, kill
semantics) lives server-side, so all clients get the same guarantees.

## Starting the server

```bash
wavecode mcp                                   # local daemon, no auth
wavecode mcp --url https://vps:3777 --token …  # remote daemon, token auth
```

Environment variables (flags take precedence):

| Variable | Meaning | Default |
|---|---|---|
| `WAVECODE_URL` | Daemon base URL | `http://localhost:3777` |
| `WAVECODE_TOKEN` | Bearer token (when `auth.method: token`) | none |

The transport is stdio — the standard for MCP clients. The process speaks
JSON-RPC on stdout and logs to stderr only.

## Connecting clients

**Claude Code** (`.mcp.json` in a project, or `claude mcp add`):

```json
{
  "mcpServers": {
    "wavecode": {
      "command": "wavecode",
      "args": ["mcp"],
      "env": { "WAVECODE_URL": "http://localhost:3777", "WAVECODE_TOKEN": "…" }
    }
  }
}
```

**Grok / other MCP clients:** register a stdio server with the same command.
For clients that only support remote (HTTP) MCP servers, run `wavecode mcp`
on a machine that can reach the daemon (e.g. the VPS itself over Tailscale)
via any stdio-to-HTTP MCP bridge, or connect through SSH:
`ssh vps wavecode mcp`.

## Tool reference

### Agents

| Tool | What it does |
|---|---|
| `list_agents` | All agents: runtime, status, pinned model/effort, last output line |
| `spawn_agent` | Create an agent in tmux. `model`/`effort` pin its LLM (see below) |
| `pin_agent` | Change an agent's model/effort pin (`null` clears; applies on relaunch) |
| `kill_agent` | Terminate a spawned agent's session and remove it |
| `stop_all` | **Emergency stop**: kill spawned, interrupt adopted, disable auto-dispatch |
| `send_prompt` | Type into an agent's terminal |
| `get_agent_output` | Read the agent's recent terminal output |

### Tasks

| Tool | What it does |
|---|---|
| `create_task` | Queue work; `depends_on` builds the DAG; `agent_id` pins the assignee |
| `list_tasks` | Tasks by status |

### Review loop

| Tool | What it does |
|---|---|
| `list_reviews` | Runs awaiting human review, with the latest AI verdict inline |
| `request_ai_review` | Cross-model review of a run's diff by another agent or the LLM |
| `get_ai_reviews` | Full review history for a run: verdicts, issues, fix rounds |
| `promote_run` | Approve. **Blocked without a `pass` verdict** unless `override_reason` is given (stored in the audit log) |
| `retry_run` | Reject + re-queue on the same agent |
| `handoff_run` | Reject + reassign to another agent |
| `reject_run` | Reject + fail the task (dependents block) |

### Events + messages (the feedback channel)

| Tool | What it does |
|---|---|
| `await_events` | **Block until something happens** — long-poll the audit log with a cursor (`since_id`) and type filters (`run.*`, `review.*`, `message.created`, …) |
| `send_message` | Post to the persistent agent wire (broadcast or addressed) |
| `list_messages` | Read the wire, filtered by recipient/workspace |

## The orchestration loop

This is the intended operating cycle for a manager/orchestrator agent — one
MCP connection driving many developer agents, like a product manager
delegating to mobile/frontend/backend/testing leads:

```
1. SPAWN the team          spawn_agent × N — each with its own workspace
                           (projects_root/<name> or a git worktree), runtime,
                           and pinned model/effort. Runtimes launch in
                           no-questions mode (bypassPermissions/--full-auto/--yes),
                           so agents can install dependencies, run servers, and
                           set up their own test infrastructure inside their
                           workspace without approval prompts.

2. DELEGATE                create_task × M with depends_on edges — the DAG is
                           the plan. Assigned tasks go to their agent; open
                           tasks go to whoever is idle first.

3. AWAIT                   loop: await_events(since_id=cursor, wait_seconds=60,
                                              types="run.*,task.*,review.*,message.created")
                           Every dispatch, completion, failure, review verdict,
                           fix round, and agent message arrives here in order,
                           with a cursor — nothing is missed between calls.

4. REACT                   run.finished        → the auto-review loop is already
                                                 on it (if enabled); read verdicts
                                                 with get_ai_reviews
                           review.ai_completed → verdict pass? promote_run.
                                                 needs-fixes? fixes were already
                                                 sent back; watch the next round
                           task.failed         → retry_run / handoff_run to a
                                                 different agent / respec the task
                           message.created     → an agent is reporting or asking —
                                                 answer with send_message or
                                                 send_prompt
                           agent silent?       → get_agent_output to look at its
                                                 terminal directly

5. GATE                    promote_run advances the DAG (with
                           gate_dependents_on_approval, dependents dispatch only
                           on approval). Promotion is refused without a passing
                           review unless you give an override_reason — the same
                           rule the human UI has.

6. GOTO 3                  until list_tasks shows everything done.
```

The inner loops are WaveCode's job, not the orchestrator's: dispatching the
DAG, watching terminals, detecting hangs/crashes, restarting sessions,
cross-reviewing every finished run, and bounding fix rounds all run inside
the daemon. The MCP client only makes the decisions machines shouldn't —
what to build, who does it, and what passes.

### How agents report back (human-to-human style)

Developer agents are CLI processes in tmux; they reach the wire three ways:

1. `wavecode msg <to|all> "<text>" --type result --task <id>` — the CLI on
   the server writes straight to the daemon's database (same install).
2. `curl -X POST $WAVECODE_URL/api/messages -H "Authorization: Bearer $TOKEN"`
   — from anywhere.
3. Implicitly: everything they do (runs, diffs, reviews) already lands in
   the event log the orchestrator is polling.

Tell agents in their task prompt to report with `--type result` on
completion and `--type request` when blocked — those messages surface in the
orchestrator's `await_events` loop within a second, which is what makes the
delegation feel synchronous.

## Model/effort pinning

Every agent can be pinned to a model and a reasoning-effort level
(`low | medium | high | xhigh`):

- The pin is **recorded** on the agent row and shown on the dashboard.
- At (re)launch, WaveCode injects the pin into the runtime command via the
  runtime's configured `model_flag`/`effort_flag` (see `config.example.yaml`).
- Pin values are strictly validated (they reach a shell): models must match
  `[a-zA-Z0-9][a-zA-Z0-9._/:-]{0,99}`, efforts must be one of the four levels.

## Error handling

Tool calls that fail return an MCP error result whose text is the daemon's
error message verbatim (e.g. `Promotion blocked: latest review verdict is
'needs-fixes'. …`). Orchestrating agents should read these messages — they
state exactly which rule blocked the action and what would unblock it.
