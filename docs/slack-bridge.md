# Slack bridge

A Slack message becomes a prompt to one WaveCode seat; the seat's captured reply (spec §5b)
is posted back in the Slack thread. The bridge is its own Slack app, separate from any other
bot, with its own tokens, channels and code (`src/server/slack-bridge.ts`, `slack-api.ts`).
Plan and the two seats it serves: `docs/slack-bridge-plan.md`.

## Routing

| Message | Seat |
|---|---|
| DM to the bot | `slack.dm_seat` (answers are plain messages in the DM, not a thread) |
| `@WaveCode …` in a channel with a route | that route's `seat` |
| any message in a route with `mode: all` | that route's `seat` |
| `@WaveCode …` in a channel without a route | `slack.dm_seat` |
| a reply inside a thread the bridge answered | the seat that answered (remembered in `kv_settings`, survives restarts) |
| anything else | ignored |

Only Slack users listed in `slack.users` (Slack user ID → WaveCode user name) reach a seat;
anyone else gets one line and nothing is typed anywhere. The prompt is recorded with that
WaveCode user as actor, so the Command Center thread and the audit show who asked.

## What the seat gets

`[from Slack #support, denis] <text>` (or `DM`, and `same thread` on a follow-up), typed through
the same path as the Command Center composer (`prompting.ts`): liveness check, persona prefix,
send-keys, `agent.prompt_sent`, reply capture. While the seat works, the question carries an
hourglass reaction. The captured reply is posted in the thread in 3,900-character pieces with
code fences kept balanced. No reply inside `reply_timeout_s` (default 600, the capture ceiling):
one line says so and points at the Command Center. One prompt in flight per seat; a second
question is told it is queued and goes next.

## What it never does

- Sends raw keys, relaunches, kills or re-briefs an agent. A seat that is not running is
  reported in the thread, nothing else.
- Treats Slack text as an instruction to WaveCode. It is a prompt to the seat. A "GO" typed
  in Slack is not a production GO: only Denis typing to SystemOps counts
  (`docs/orchestrator-seat.md`).
- Reads Slack history. Only the message that arrives is seen.
- Logs or stores a token. Tokens are read from the files at start.

## Transport

Socket Mode over the `ws` package. `apps.connections.open` (app-level token) returns the
websocket URL; each envelope is acknowledged by `envelope_id` before it is handled; `hello`
resets the backoff; `disconnect` or a socket close reconnects (2 s doubling to 60 s).
`auth.test` (bot token) learns the bot's user ID so its own messages and the mention text are
recognised. A mention in a channel arrives twice (`app_mention` and `message`); it is answered
once (`client_msg_id`).

## Notifications

`slack.notify_channel` adds Slack to `notifications.notify()` next to ntfy and Telegram: the
same alerts, posted with the bot token.

## Configuration

```yaml
slack:
  app_token_file: /home/wave/.config/wavecode/slack-app.token   # xapp-…, 0600, owner wave (SystemOps)
  bot_token_file: /home/wave/.config/wavecode/slack-bot.token   # xoxb-…
  dm_seat: pm-denis                 # Denis's own orchestrator seat (Opus 5.5)
  routes:
    - { channel: C0XXXXXXX, seat: support, name: support, mode: all }   # Sonnet 5.5 support seat
    - { channel: C0YYYYYYY, seat: support, name: dev }                  # @mentions only
  users:
    U0XXXXXXX: denis                # Slack user ID → WaveCode user name
  notify_channel: C0ZZZZZZZ         # optional
  reply_timeout_s: 600
```

A token in place of a file path is refused at load. Without the section the bridge does not
start; with the section and a missing token file it stays idle and logs one warning.

## Slack app

Create the app from `docs/ops/slack-app-manifest.yaml` (Socket Mode on). Bot scopes:
`app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write`, `channels:history`,
`reactions:write`, `users:read`. Events: `app_mention`, `message.im`, `message.channels`.
Install to the workspace, invite the bot to the routed channels, and hand the two tokens to
SystemOps for the token files. Never paste a token in chat.

## Events

`slack.prompt` (agent; channel, thread, user, prompt event id), `slack.reply` (agent; message id,
characters), `slack.refused` (slack; a user not on the list).
