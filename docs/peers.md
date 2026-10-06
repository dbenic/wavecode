# Peers — asking an agent on another WaveCode instance

Two WaveCode instances (for example the **development box** with the coding
agents and the **deploy box** with a read-only "Fable" that knows the
production database) can talk without any agent holding access to both
machines. A question travels as text; the answer comes back as text and is
saved as a file. No credentials cross the wire, every question and answer is
in both audit logs, and the agents never poll — the daemons do.

```
dev agent ── ask_peer("deploy","fable",q) ──▶ dev WaveCode
dev WaveCode ── POST /api/agents/<fable>/send  (peer token) ──▶ deploy WaveCode ──▶ Fable's pane
Fable answers; deploy WaveCode's reply-capture stores it as a reply to that prompt
dev WaveCode long-polls /api/events/log on the deploy box (free), fetches the text,
  writes ~/inbox/answers/deploy-fable-<id>.md, emits peer.answer,
  types "[Answer from deploy/fable …] <text>" into the asking agent when it is idle
```

## Setting it up

### On the answering side (deploy box)

1. Run the answering agent as a normal WaveCode agent (adopted or spawned),
   e.g. `fable`. It should have only the access it needs (a read-only DB
   login); WaveCode does not change that.
2. Create the token the other box will use, **limited to that one agent**:

   ```bash
   wavecode user add peer-countix-dev --role developer --only-agents fable
   ```

   A user with `--only-agents` can prompt and read only those agents; every
   other agent, output, message and event is hidden from it, and it cannot
   spawn, kill or reserve anything else. Hand the printed token to the admin
   of the asking box — never the fallback admin token.

### On the asking side (dev box)

`config.yaml`:

```yaml
peers:
  deploy:
    url: http://100.100.165.71:3777     # the deploy box over the tailnet
    token: <token from the step above>
    agents: [fable]                     # optional allowlist of remote handles
```

Restart the daemon. Check with `GET /api/peers` (no token is ever shown).

## Asking

- From the Command Center: `#ask deploy/fable Is the invoices table migrated on staging?`
- From a seat or agent with MCP: `ask_peer(peer="deploy", agent="fable", question=…)`;
  the answer arrives as `peer.answer` (`await_events` with `types=peer.*`).
- From the API: `POST /api/peers/deploy/ask { agent, question, from_agent_id? }` → 202 with the question row.

What the asking agent gets, when it is next idle:

```
[Answer from deploy/fable to your question "Is the invoices table migrated…"] Full text: /home/wave/inbox/answers/deploy-fable-01M….md

<the answer, up to 3000 chars>
```

In the thread: *Question → deploy/fable*, then *Answer ← deploy/fable* with
the file path as a link. A question nobody answers in 30 minutes becomes
*No answer from deploy/fable* and needs attention.

## Limits and guarantees

- One question, one answer. Follow-ups are new questions (the answer file
  gives the context to quote).
- The answering agent sees `[Question <id> from <host>/<asker> via WaveCode
  peering — answer in full in this turn …]` so it knows to answer completely
  and not to ask back.
- Pending questions survive a restart of the asking daemon (they are in its
  database); polling resumes at boot.
- The peer token is scoped on the **answering** side (`--only-agents`), so
  even a compromised asking box can do nothing there but ask that agent.
