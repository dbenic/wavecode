# Production read seat on the deploy box (runbook)

Agreed 26 Oct 2026. Goal: developers and product people ask "why" about production and staging
in Slack and get answers from real data, on a subscription account WaveCode can watch, with no
dependency on the Grok bots. Grok's SystemOps stays the production deploy executor during the
switch (fallback); the WaveCode release runner replaces it in a second step
(`docs/releases.md`).

## What exists today

- The deploy box runs its own WaveCode (`peers.deploy` from countix-dev). It registers one
  agent, `claude-countix`, alias `fable`: Claude Code on an **organisation API key**. That key
  crossed its monthly threshold on 26 Oct and answers every question with a 429 until
  1 Nov 2026 00:00 UTC. Pay-per-token, one shared threshold, cost visible only in the Anthropic
  console.
- countix-dev seats `pm-support` (#dev-support) and `pm-ops` (#ops-support) ask it through
  `ask_peer` (peer `deploy`, agent `fable`); the answer is posted back into the Slack thread.

## Target

`claude-countix` keeps its name and alias and moves to a **subscription login**: credential
profile `assist` (the Max account denis@countix.co that `pm-denis`, `pm-support` and `pm-ops`
already use), or a second account as profile `assist-prod` if it should be its own line item.
It gets two read-only database roles, production and staging, and names the environment in
every answer. Nothing else about it changes: WaveCode on countix-dev still asks it as `fable`.

## Steps (SystemOps, on the deploy box)

1. **Profile**: add `assist` under `profiles:` in that box's `config.yaml`, same shape as on
   countix-dev (`profiles.assist: {}` is enough; the profile dir is created on first use).
   Restart that WaveCode when its merge queue has nothing `merging`.
2. **Login**: `POST /api/profiles/assist/login {runtime: "claude-code"}` (or
   `wavecode profile login assist claude-code` in a terminal as the service user). AgentView
   shows the login seat's pane with the sign-in URL. Denis opens the URL with the Max account
   and pastes the one-time code into the seat (`POST /api/profiles/assist/login/claude-code/code`).
   `profile.login_finished {logged_in: true}` confirms. No token, key or code is written
   anywhere but the CLI's own credential file in the profile dir.
3. **Move the agent**: `PATCH /api/agents/claude-countix {profile: "assist"}` then
   `POST /api/agents/claude-countix/restart`. The first `/usage` probe (within 15 min) shows
   `claude-code / assist` in that box's usage table. Turn prompt suggestions off in the
   profile's CLI settings (`promptSuggestionEnabled: false` in `<profile_dir>/claude/settings.json`),
   as countix-dev does, or reply capture can stall on the composer's ghost text.
4. **Read-only roles**: create `countix_ro` on the production database and on staging with
   `SELECT` on the application schema only, no write, no DDL, a statement timeout (30 s) and a
   row limit convention in the seat's brief. Put the two connection strings in files the service
   user alone can read (0600) and name the files in the seat's brief. Never in config.yaml,
   never in a prompt, never in Slack.
5. **Brief** (`send` to the seat; keep a copy in that box's room folder): "You are fable, the
   production read seat. You answer questions from countix-dev seats about production and
   staging data. Read-only: `SELECT` only, through the connection files named here; never
   UPDATE, DELETE, DDL, never restart or deploy anything. Name the environment in every
   answer. Quote the identifiers you used (document number, supplier, company, date). If a
   query needs more than one table, say which. Never print a host name, user, password or
   connection string." Add `review_deny` for it and role `orchestrator` so no task is ever
   dispatched to it.
6. **Allowlist**: countix-dev `peers.deploy.agents` already lists `fable`; nothing to change.
   On countix-dev, the Slack follow-up flow posts its answer into the asking thread.

## Monitoring the subscription

- `/usage` probe every 15 min per (runtime, profile): the Agents page shows the line
  ("92% left · resets 31 Oct · 5h 5% used") on every agent of that profile; `usage.probed`
  events carry the numbers; `profile_usage` is the table.
- `usage.high` alert (this commit): when a profile's 5-hour window or weekly window passes
  `usage.alert_used_pct` (default 80), one notification per window goes out on the configured
  channels (Slack `notify_channel`, ntfy, Telegram, Web Push). On countix-dev that is Denis's
  DM with the WaveCode bot.
- Rule of thumb for Max 5x → 20x: the 5-hour window hitting 100% more than once a day on
  normal work, or the weekly window under 20% left before Thursday. Both show up as alerts.

## Fallback during the switch

Until step 3 is done, `fable` answers 429 and `pm-support` says so in Slack ("the production
agent is out of API quota until 1 Nov") and answers what it can from WaveCode's own records.
Grok Maestro / SystemOps are untouched; nothing here changes how production is deployed.
