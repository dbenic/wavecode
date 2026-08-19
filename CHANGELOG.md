# Changelog

All notable changes to WaveCode are documented here.

## Unreleased

### Added
- Native MCP Streamable HTTP on the daemon at `/mcp` (same tools as `wavecode mcp` stdio). Auth is `createAuthMiddleware()` — Tailscale and/or `Authorization: Bearer <token>` / `WAVECODE_TOKEN`. Sessions use the `mcp-session-id` header after initialize. Grok Bot / Cursor remote connectors use the HTTPS URL + bearer; `ssh … wavecode mcp` is deprecated for those clients. MCP `get_run_result` wraps `GET /api/runs/:id/result`.
- Per-run orchestrate result file at `<data-dir>/runs/<runId>/result.txt` (sibling of `transcripts_root`). Written once at the end (overwrite, capped). Last line is exactly `RESULT: PASS` or `RESULT: FAIL` plus a one-line reason. Orchestrate reads that file by run_id only — never tmux or transcript scrape. API may expose path/contents as a convenience. Spawned/adopted prompts are briefed to write the file before idle. Missing or unparseable is never PASS; idle-close may overwrite FAIL or leave the file missing. Referee / wavepulse-gate RESULT remains the promote gate.
- Persist-only goals: `POST /api/goals` and MCP `create_goal` accept `decompose: false` (or `persist_only`) to insert the goal row and emit `goal.created` without LLM decomposition or `dispatchNext`. Default still decomposes.
- MCP artifact tools `list_artifacts`, `upload_artifact` (path or base64), `share_artifact`, `attach_artifact` wrap the existing hashed store. JSON `POST /api/artifacts/upload` and `POST /api/artifacts/:id/attach` so orchestrators can push a dropped file to an agent's `.wavecode/artifacts` workspace. `share` returns `attached_path`; notify failure is non-fatal. `list_artifacts?agent_id=` confirms the implementer has the file. JSON upload rejects `path` (MCP reads local files and posts base64) so a token cannot read arbitrary VPS files.
- `create_task` / MCP accept optional `goal_id` (ULID or `external_id`) and `hold: true` to skip auto-dispatch.
- Persisted goals (`goals` table, schema v10). `POST /api/goals` writes a parent row; decomposed tasks store `goal_id`. `GET /api/goals` and `GET /api/goals/:id` return child-task rollup counts. Optional `external_id` (e.g. `F-16`) is a label only.
- MCP tools `list_goals`, `get_goal`, `create_goal`, `list_decisions`, `record_decision` so orchestrators can track epics and binding decisions without the UI.
- Task Board goal rollup (title + n/m tasks done).
- Per-project verify/referee profile (`projects` in config). A matching workspace invokes the configured gate after `run.finished`, persists the RESULT line, and `promote()` uses that RESULT as the only test evidence. Unmatched workspaces are unchanged. LLM `verify_completion` is skipped when a gate is configured.
- Codex runtime default `effort_flag: -c model_reasoning_effort=` so a pin of `high`/`xhigh` is actually injected.

### Fixed
- Idle-close waits a dispatch grace (~60s after `started_at`) before failing a just-dispatched Codex/Claude run that never showed working (status bar / `›` / splash). After the pane shows working, a later idle close is allowed. After grace, idle + missing result is still FAIL. A parseable `RESULT: PASS` file still PASSes. Claude splash with no open run still goes idle. No invented PASS; no spawned auto-retry.
- Claude Code's fresh splash (welcome ✻/✶, "Try refactor …" tips, `shift+tab` / `⏵⏵` bar without "esc to interrupt") is `idle`. A sparkle or tip verb no longer sticks the seat on `working`, so the idle override can complete. Real work stays `working` (`esc to interrupt`, action-verb status lines while running).
- Spawned missing / unparseable / `RESULT: FAIL` does not auto-retry or re-queue the same WaveCode seat. The write-once `runs/<run_id>/result.txt` file is the signal; CountixDev failovers to a Cursor cloud agent. The seat stays up (WaveCode remains primary). Adopted seats keep the retry budget. Manual `POST /api/tasks/:id/retry` is unchanged.
- Spawned-agent lifecycle is one open run per seat: `executeRun` / dispatch refuse a second run while `finished_at` is null. Interactive TUIs get the prompt + `insertRun` (no `echo|nc` paste) and close on stable idle via `onRunComplete`. `reject_run` and cancel persist `finished_at` before failing the task. Grok `Responding` / `Thinking` / `Worked-for` / interrupt lines are working; `idle_pattern` is wired; `status=error` is correctable when the pane is healthy. `wavecode tasks` no longer throws EPIPE when a consumer closes the pipe.
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
