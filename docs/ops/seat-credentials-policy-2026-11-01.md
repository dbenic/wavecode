# Seat credentials policy: no API keys, out under 5 %, out when logged out

Written 1 Nov 2026 after unexpected Anthropic invoices on denis@countix.ai. Audit result: the
dev box does not spend at invoice scale (all 20 Claude panes run on OAuth and every profile rejected
the API key; the daemon's own API calls are 0–2 a day), but two Anthropic keys are exposed there: the
daemon key reaches every process through the tmux server environment, and a production secrets
`.env` sits in the claude2 worktree. Denis's rule, verbatim: *no one uses any key; if we drop below
5 % we take the agent out; same for login / logout; make this clear in the user experience.*

## 1. The rule

| Situation | What WaveCode does | Shown as |
|---|---|---|
| A provider key the seat's own CLI would bill (ANTHROPIC_API_KEY for Claude unless the CLI rejected it, OPENAI_API_KEY for Codex, XAI_API_KEY for grok) in a pane's environment, or a profile that approved an API key | Kill the pane, park the seat, notify. Never dispatch. A foreign key (the daemon's Anthropic key inherited by a Kimi pane) is only shown as `KEY IN ENV` | `API KEY` red badge, attention row, push notification |
| Plan window (5-hour or weekly) under 5 % left | Park: no new dispatch, by-name tasks wait with reason `quota` | `OUT · 3 % left · resets 14:00` red badge |
| Profile logged out (no OAuth credentials, or token expired) | Park: no dispatch, by-name tasks wait with reason `login` | `LOGGED OUT` badge, one-tap "Open login seat" |
| Never probed yet, or a key-based runtime (aider) | Dispatched normally; nothing is parked on a guess | grey `auth ?` badge |

Parked seats stay registered and keep their pane (except the key case); they return to rotation on
the next probe that shows them fit. Nothing ever substitutes a key for a subscription.

## 2. Box changes (ops, on GO, at zero running runs)

1. `/etc/wavecode/wavecode.env`: remove `ANTHROPIC_API_KEY` (the daemon reads `config.yaml`).
2. `config.yaml`: `llm.anthropic_api_key: null` and `llm.api_key: null`. The daemon's LLM-direct
   review fallback, decision extractor, prompt enhancer and command chat switch off; none is in use.
3. `config.yaml`: `autonomy.min_quota_pct: 5` (today 10).
4. `tmux set-environment -g -u ANTHROPIC_API_KEY` so new panes are clean before the restart.
5. Delete `/home/wave/.wavecode-data/worktrees/claude2/.env` (production secrets: Anthropic, Stripe
   secret key, Supabase service role key, Voyage, Cohere, JWT). Denis rotates those keys in their
   consoles; the file is the leak regardless of who spent.
6. Restart the daemon. Existing panes keep the old key in memory until their pane restarts; the
   probe in §3.2 reports them as `key in env` until then, so the dashboard shows exactly which panes
   still need a restart.

Denis's side: rotate both Anthropic keys in console.anthropic.com (freezing the card does not stop
calls), then Usage → group by API key tells which key the invoices came from.

## 3. WaveCode changes (this repo)

### 3.1 Spawn hygiene (`runtime-launcher.ts`, `tmux.ts`, `bootstrap.ts`)
- The launch command of every spawned or re-created pane is wrapped in
  `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY -u GEMINI_API_KEY -u GOOGLE_API_KEY -u XAI_API_KEY -u PERPLEXITY_API_KEY …`
  (one list, `PROVIDER_KEY_VARS`, shared with 3.2).
- At daemon start: unset the same variables in the tmux global environment, and log a warning
  naming any of them present in the daemon's own environment.
- `file-runner.ts` already strips Anthropic variables for `claude -p`; it switches to the shared list.

### 3.2 Credential probe (new `seat-credentials.ts`)
Runs with the usage probe tick (15 min) and right after spawn/adopt, per seat, without typing into
any pane:
- **Claude Code**: `$CLAUDE_CONFIG_DIR/.credentials.json` → `claudeAiOauth.subscriptionType`
  (max/team/pro) and `expiresAt`; `.claude.json` → `customApiKeyResponses.approved` non-empty means
  the profile accepted a key.
- **Codex**: `$CODEX_HOME/auth.json` → ChatGPT tokens (subscription) vs `OPENAI_API_KEY` (key).
- **Any runtime**: the pane's process environment (`/proc/<pid>/environ`, same user) checked for
  `PROVIDER_KEY_VARS`.
- Result per agent in a new table `agent_auth (agent_id PK, mode, plan, detail, checked_at)` with
  `mode ∈ subscription | api-key | logged-out | unknown`. Exposed as `auth` on the agent row.

### 3.3 Dispatcher and leases (`task-dispatcher.ts`, `leases.ts`)
- `agentUnfit` and the idle filter gain codes `login` and `key` next to `quota`; `DEFAULT_MIN_QUOTA_PCT` becomes 5.
- `waitReason` returns `quota | login | key` for tasks addressed to a parked seat, so
  `task.waiting_for_agent` is emitted and the task is visible as waiting instead of a dead letter.
- Events, once an hour per seat like `agent.quota_low`: `agent.logged_out`, `agent.api_key`
  (this one also kills the pane via `sessionManager.kill` and notifies through ntfy/Telegram).

### 3.4 User experience (`overview.ts`, `AgentCard.tsx`, `AgentView.tsx`, `Dashboard.tsx`, `types.ts`)
- Agent row gets `auth: { mode, plan, detail }` and `out: { reason: 'quota' | 'login' | 'key', since, detail } | null`.
- `AgentCard`: a second badge next to the status: `Max 62 %` (green ≥ 20, amber 5–20),
  `OUT · 3 %` (red), `LOGGED OUT` (red), `API KEY` (red, pulsing), `auth unknown` (grey).
- `AgentView` header, when `out` is set: one sentence saying why the seat is out of rotation and
  what returns it (resets at …, or an **Open login seat** button that calls the existing login-seat
  endpoint for that profile).
- Dashboard: attention rows `quota_out`, `logged_out`, `api_key` in the existing attention list, and a
  top banner "N seats out of rotation" linking to them.
- Task board: a waiting task shows "waiting for @seat (logged out)" from the new wait reasons.

### 3.5 Tests
Probe parsers with fixture config dirs; dispatcher skips for each code; `env -u` wrapping; wait
reasons; overview `out` field; card badge rendering.

### 3.6 Docs
`docs/api.md` (agent `auth` / `out`, new events), `docs/agent-operating-rules.md` one line: seats
never carry provider keys; a parked seat is not a bug to work around.

## 4. Order

1. §3.1 + §3.2 + §3.3 (safety first), tests, PR.
2. §3.4 UI, tests, same PR or a second one.
3. Deploy with the §2 box changes in one restart at zero running runs, on Denis's GO.

Expected size: about 600 lines of server code and tests, 200 lines of UI. One day.
