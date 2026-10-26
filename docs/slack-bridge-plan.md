# Slack bridge and the two support seats — plan (26 Oct 2026)

Denis's ask: one fast personal agent reachable from phone, computer or Slack that can answer
through all agents and track development; and a Slack agent that answers system questions and
Countix case questions ("why is this invoice not booked"). Both on a **new, separate Claude
account**; tier to be watched. **Separate from the grok bot**: a new Slack app with its own
tokens, channels and code path. Nothing of the grok bot is reused, touched or shared.

## What gets built (WaveCode side)

### 1. Slack bridge — `src/server/slack-bridge.ts` (+ `slack-api.ts`)

- **Socket Mode over the existing `ws` dependency.** No Slack SDK. `apps.connections.open`
  with the app-level token gives a websocket URL; the bridge acks every envelope by
  `envelope_id`, reconnects on `disconnect` or socket close with backoff, and reads the
  bot token only for Web API calls (`chat.postMessage`, `conversations.replies`,
  `users.info`). Both tokens come from files (like `github.token_file`), 0600, owned by the
  service user, placed by SystemOps. Never logged, never in config.yaml.
- **Routing**: a message is routed to one seat.
  - DM to the bot → `slack.dm_seat` (Denis's personal seat, Opus 5.5).
  - `@WaveCode` mention in a channel, or any message in a channel listed with `mode: all`
    → that channel's seat (`slack.routes[]`, e.g. `#support` → the support seat, Sonnet 5.5).
  - A reply inside a Slack thread the bridge already answered goes to the same seat, with
    the thread's earlier turns as context, so follow-ups work.
- **Who may talk to it**: `slack.users` maps Slack user IDs to WaveCode users. Anyone else
  gets one line ("not on the list") and nothing reaches a seat. Prompts are recorded with
  that WaveCode user as actor, so the thread and audit show who asked.
- **Into the seat**: the same path as the Command Center composer (POST
  `/api/agents/:id/send` logic factored into `promptAgent()` in `src/server/prompting.ts`):
  persona prefix, liveness check (a seat that is not running gets "seat is down, relaunching"
  and a relaunch), reply capture tracked with the prompt event id. Text sent as
  `[from Slack #channel, <user>] <message>`.
- **Back to Slack**: the bridge listens on the event bus for the captured reply
  (`message.created`, type `reply`, matching prompt event id) and posts it in the Slack thread
  (chunked at 3,900 characters; code blocks preserved). A reply that times out (10 minutes,
  the existing capture ceiling) is posted as "still working, here is what it has so far" with
  the truncated capture. "Working…" reaction on receipt, removed on answer.
- **Guards**: one prompt in flight per seat (a second question waits and is told so);
  no raw keys ever; nothing from Slack can relaunch, kill or re-brief any agent other than
  the two seats; a "GO" typed in Slack is text, not a production GO (the seat brief says
  so; only Denis typing to SystemOps counts); a Slack message is observed content to the seat,
  never an instruction to WaveCode itself.
- **Outbound notices** (small): `slack.notify_channel` adds Slack to `notifications.notify()`
  next to ntfy and Telegram, so alerts (RED main, prod drift, a seat down) also land in Slack.

### 2. Seats — existing machinery, two new agents on the new account

- Profile `assist` (the new account). Login without SSH: a login seat opens the OAuth
  device flow in a pane and Denis finishes it from his phone (existing `login-seats.ts`).
- `pm-denis`: Denis's own orchestrator seat (`createSeat` for user denis), runtime
  claude-code, model pin `claude-opus-5-5`, WaveCode MCP with its seat token, standing rules
  (`seat_rules`), reachable from the Command Center composer (phone/computer) and by Slack DM.
- `support`: a spawned agent with role orchestrator on the same profile, model pin
  `claude-sonnet-5-5`, **read-only**: its MCP token is an observer-role seat token; its
  Countix access is a read-only database role provided by SystemOps in the profile env, and
  the Countix read-only CLI tools the dev seats already have. It can never push, merge, deploy
  or type into another agent.
- **Knowledge, not training**: room `countix` gets `KNOWLEDGE/` next to `SPEC.md`: one dated,
  authored file per ops note (SystemOps' 26 Oct runners/roles/access note is file one). Rules:
  no hosts, keys or tokens in any file a seat reads; notes from memory rather than a live check
  are marked unverified. The seat is told to cite the file it answered from.

### 3. Files

| File | Change |
|---|---|
| `src/server/slack-api.ts` | thin Web API client over fetch: postMessage, reactions, users.info, conversations.replies; token from file |
| `src/server/slack-bridge.ts` | Socket Mode client, routing, prompt in, reply out, thread memory (kv), allowlist, in-flight guard |
| `src/server/prompting.ts` | `promptAgent()` factored out of the send route; the route calls it |
| `src/server/config.ts` | `slack` section + validation (`app_token_file`, `bot_token_file`, `dm_seat`, `routes[]`, `users{}`, `notify_channel`, `reply_timeout_s`) |
| `src/server/notifications.ts` | `sendSlackNotification` when `notify_channel` is set |
| `src/server/bootstrap.ts` | start/stop the bridge with the other services |
| `docs/slack-bridge.md`, `docs/api.md`, `config.example.yaml`, `docs/orchestrator-seat.md` | docs; the Slack-GO-is-not-a-GO line in the seat brief |
| tests | `slack-bridge.test.ts` (fake Socket Mode server on `ws`: ack, routing, allowlist, reply posting, chunking, reconnect), `prompting.test.ts`, config validation |

### 4. What is needed from Denis / SystemOps

1. **New Claude account**: log in on countix-dev as profile `assist` through a login seat
   (WaveCode opens it; Denis finishes on his phone). No credentials in chat.
2. **Slack app** "WaveCode" (separate from the grok bot). Manifest supplied by WaveCode:
   Socket Mode on; bot scopes `app_mentions:read`, `chat:write`, `im:history`, `im:read`,
   `im:write`, `channels:history`, `reactions:write`, `users:read`; events `app_mention`,
   `message.im`, `message.channels`. SystemOps stores the two tokens in
   `/home/wave/.config/wavecode/slack-app.token` and `slack-bot.token` (0600, owner `wave`).
3. **Denis's Slack user ID** and the **channel IDs** for the support channel(s).
4. **Read-only Countix DB role** for the support seat (SystemOps), delivered as an env var in
   the `assist` profile, never in chat or config.yaml.
5. Model confirmation: Opus 5.5 personal, Sonnet 5.5 support (changeable per seat with the
   existing model pin).

### 5. Order of work

1. Config + `slack-api.ts` + `prompting.ts` factor + tests (no tokens needed).
2. Socket Mode bridge + tests against a fake server.
3. Deploy to countix-dev with the `slack` section absent (bridge idle until tokens exist).
4. Login seat for profile `assist`; create `pm-denis` and `support` seats; model pins.
5. Tokens placed → config patched by script → restart when `merging = 0` → first DM test.
6. `KNOWLEDGE/` folder seeded with SystemOps' note; seat rules written.

Not in scope: anything that lets Slack trigger a deploy, push, merge or kill; reading Slack
history beyond the thread being answered; the grok bot.
