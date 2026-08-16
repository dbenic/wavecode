# Changelog

All notable changes to WaveCode are documented here.

## Unreleased

### Added
- Persist-only goals: `POST /api/goals` and MCP `create_goal` accept `decompose: false` (or `persist_only`) to insert the goal row and emit `goal.created` without LLM decomposition or `dispatchNext`. Default still decomposes.
- MCP artifact tools `list_artifacts`, `upload_artifact` (path or base64), `share_artifact`, `attach_artifact` wrap the existing hashed store. JSON `POST /api/artifacts/upload` and `POST /api/artifacts/:id/attach` so orchestrators can push a dropped file to an agent's `.wavecode/artifacts` workspace. `share` returns `attached_path`; notify failure is non-fatal. `list_artifacts?agent_id=` confirms the implementer has the file.
- `create_task` / MCP accept optional `goal_id` (ULID or `external_id`) and `hold: true` to skip auto-dispatch.
- Persisted goals (`goals` table, schema v10). `POST /api/goals` writes a parent row; decomposed tasks store `goal_id`. `GET /api/goals` and `GET /api/goals/:id` return child-task rollup counts. Optional `external_id` (e.g. `F-16`) is a label only.
- MCP tools `list_goals`, `get_goal`, `create_goal`, `list_decisions`, `record_decision` so orchestrators can track epics and binding decisions without the UI.
- Task Board goal rollup (title + n/m tasks done).
- Per-project verify/referee profile (`projects` in config). A matching workspace invokes the configured gate after `run.finished`, persists the RESULT line, and `promote()` uses that RESULT as the only test evidence. Unmatched workspaces are unchanged. LLM `verify_completion` is skipped when a gate is configured.
- Codex runtime default `effort_flag: -c model_reasoning_effort=` so a pin of `high`/`xhigh` is actually injected.

### Fixed
- `wavecode mcp` uses the same daemon connection resolution as `wavecode queue` (`auth.fallback_token`, then `WAVECODE_TOKEN`, then `--token`), so a token-auth daemon works without injecting the token into the MCP client environment.
- `wavecode queue` and `wavecode send` POST `/api/tasks` so the daemon creates and dispatches a run (same as MCP `create_task`). If the daemon is down, the task is saved locally as pending with a clear message.
- Auto-review after `run.finished` always leaves a completed `code_reviews` row with a parsed verdict, including empty diffs and LLM/poll failures. `/api/reviews` `latestReview` is no longer null after a successful run.
- Output watcher dismisses Claude Code's first-run "Bypass Permissions / Yes, I accept" dialog (Down+Enter, 8s cooldown).
- Default runtime flags match current no-click bypass commands: `claude --dangerously-skip-permissions`, `grok --always-approve`, `codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust`.
- Daemon polls `dispatchNext` so out-of-band pending inserts are not stuck.

## [0.1.0] — 2026-04-07

### Added
- Initial open-source release
- **Agent management**: Adopt existing tmux sessions or spawn new ones
- **Task dispatcher**: DAG-based task queue with dependencies, retries, and auto-chaining
- **Dashboard**: SSE-driven React PWA with live agent status, task board, and review queue
- **Command chat**: Multi-provider chat with prompt enhancement
- **Research specs**: One-shot research jobs via Anthropic, OpenAI, Gemini, Perplexity, and xAI
- **Code review**: Review queue with approve/reject/retry workflow
- **Artifacts**: Immutable file sharing between agents with SHA-256 integrity
- **Guides & templates**: Import skill libraries from git repos (compatible with awesome-claude-skills)
- **Context briefing**: Auto-prepend cross-agent context to task prompts
- **Decision tracking**: Extract and share architectural decisions across agents
- **Health monitor**: Heartbeat-based hang detection with auto-restart
- **Auth**: Tailscale-based and token-based access control
- **Notifications**: Web Push, ntfy.sh, and Telegram Bot API
- **One-line installer**: `curl | bash` install script for Linux and macOS
- **systemd service**: Production deployment with security hardening
- **294 bundled skills**: From Anthropic, Trail of Bits, Expo, obra/superpowers, and more
