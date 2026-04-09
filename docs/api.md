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
Spawn a managed agent and optional git worktree.

Body:
`{ name: string, runtime: string, repo?: string, branch?: string }`

### `POST /api/agents/:id/send`
Send text or a raw tmux key sequence to an agent.

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
Detach or remove an agent.

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

### `GET /api/tasks/:id`
Get one task with dependency and run context.

### `POST /api/tasks`
Create a task.

Body:
`{ prompt: string, agent_id?: string, priority?: number, depends_on?: string[] }`

### `POST /api/tasks/:id/retry`
Reset a failed or done task to `pending`.

### `GET /api/tasks/:id/runs`
List runs for a task.

### `POST /api/dispatch`
Manually dispatch queued work, even when `autonomy.auto_dispatch` is disabled.

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

## Reviews

### `GET /api/reviews`
List review queue items.

### `GET /api/reviews/:runId`
Get one review queue item.

### `POST /api/reviews/:runId/promote`
Approve a run.

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

### `GET /api/reviews/:runId/ai-reviews`
List AI reviews for a run.

### `POST /api/ai-reviews/:reviewId/send-fixes`
Send review fixes back to the original agent.

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
Upload an artifact.

Body:
`multipart/form-data` with `file`, optional `note`, optional `agent_id`

### `POST /api/artifacts/:id/share`
Share an artifact with an agent.

Body:
`{ targetAgentId: string }`

### `GET /api/runs/:id/artifacts`
List artifacts attached to a run.

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
