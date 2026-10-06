# Dev box ↔ deploy box: the agent question link (spec for the system administrator)

**Status:** built, deployed and tested end to end on 2026-10-06 (round trip ≈ 20 s).
**Owner:** Denis. **Code:** WaveCode `src/server/peers.ts`, `docs/peers.md`, `src/server/auth.ts` (restricted tokens).

## 1. Purpose

Developers' coding agents run on the **development box** and must never hold
production access. Production questions ("how many invoices did tenant X
book in September?", "which migration is current?") are answered by **one
agent on the deploy box** that has a database login. The two WaveCode daemons
relay the question and the answer as **text**. No credential, file or shell
access crosses between the machines, and every question and answer is logged
on both sides.

## 2. Topology

```
development box (countix-dev, 188.40.85.171, tailnet 100.124.127.13)
  WaveCode daemon, user `wave`, port 3777 (tailnet only; ufw blocks public)
  coding agents: claude1, codex1, codex2 … (git worktrees, no prod access)
        │
        │  HTTPS/HTTP over Tailscale (WireGuard) only — never the public internet
        │  dev → deploy:   POST /api/agents/<fable>/send   (bearer: peer-countix-dev)
        │  dev → deploy:   GET  /api/events/log, GET /api/messages   (same bearer, read)
        ▼
deploy box (136.243.8.205, tailnet 100.100.165.71)
  WaveCode daemon, user `ci`, port 3777 (tailnet only)
  answering agent: `claude-countix`, alias `fable` (Claude Code, tmux, human-started)
  → reads the production database and answers in prose
```

The deploy box never initiates a connection to the development box.

## 3. The flow of one question

1. A developer, their PM seat or a coding agent asks: in the UI
   `#ask deploy/fable <question>`, via MCP `ask_peer`, or — for any CLI — by
   printing a line `ASK deploy/fable: <question>` in its own output.
2. The dev WaveCode records the question (`peer_questions` table, event
   `peer.question`), resolves `fable` on the deploy box through the peer
   token, and POSTs the question to that agent's `send` endpoint. The deploy
   daemon types it into Fable's terminal with a header saying who asked and
   that the reply is relayed verbatim.
3. Fable answers. The deploy daemon's reply capture stores the answer as a
   message tied to that prompt (`message.created`, `ref_prompt_event_id`).
4. The dev daemon long-polls the deploy daemon's event log (one HTTP request
   per 30 s per peer, only while a question is open; no agent polls anything),
   fetches the answer text, writes
   `/home/wave/inbox/answers/deploy-<agent>-<id>.md`, emits `peer.answer`,
   and types the answer into the asking agent's terminal once it is idle.
5. Unanswered after 30 min → `peer.failed`, visible in the thread.

## 4. Access control

| Where | Control |
|---|---|
| Network | Tailscale only. Port 3777 is firewalled from the public internet on both boxes (ufw: SSH in, everything else only on `tailscale0`). |
| Dev → deploy token | WaveCode user `peer-countix-dev` on the deploy box, role developer, **restricted to agent `fable`** (`--only-agents fable`). Enforced by the deploy daemon's auth middleware: the token may call only `GET /api/me`, `GET /api/agents` (filtered to fable), `GET /api/agents/<fable>`, `GET /api/agents/<fable>/output`, `POST /api/agents/<fable>/send`, `GET /api/events/log` and `GET /api/messages` (both filtered to fable). Every other route answers 403. It cannot spawn, kill, reserve, read other agents, read files, tasks, rooms or the thread. |
| Token storage | Dev box: `/home/wave/wavecode/config.yaml` → `peers.deploy.token` (mode 600, owner `wave`). Deploy box: only its SHA-256 hash is stored. Rotation: `wavecode user add` a new restricted user on the deploy box, swap the token in the dev config, revoke the old user. |
| What Fable may do | Decided on the deploy box by Fable's own login, not by WaveCode. **Current state (Fable's own statement, 2026-10-06):** it reads the live production database through the application's write-capable connection and sets each session read-only itself. **Required:** a dedicated read-only database role for that session, and the write-capable connection removed from its environment. Until then the "read-only" guarantee is procedural, not enforced. |
| Content rules | Agents are instructed (operating rules §3b) to ask for facts only and never for changes, deployments, migrations, secrets or personal data beyond the task. Fable should refuse anything else and say so. |

## 5. What crosses the wire

Only JSON text: the question (≤ 8 000 characters, with the asker's host and
agent name), the answer text, and event metadata (ids, timestamps, agent
names). No files, no credentials, no shell access, no production data other
than what Fable chooses to write in its answer. Answers are stored on the dev
box as plain files under `/home/wave/inbox/answers/` (owner `wave`, mode 600)
and are visible to everyone who can use the dev WaveCode UI.

## 6. Logging and audit

- Dev box: `peer_questions` table (question, asker, times, answer path,
  status) and events `peer.question` / `peer.answer` / `peer.failed`.
- Deploy box: `agent.prompt_sent` with `actor_id = peer-countix-dev` and the
  captured reply message. `journalctl -u wavecode` on both boxes.
- The thread on the dev box shows *Question → deploy/fable* and *Answer ←
  deploy/fable* with the file link.

## 7. Operations checklist for the administrator

1. **Create the read-only database role** for Fable's session and point that
   session at it; remove write-capable credentials from its environment.
   This is the one open security item.
2. Keep both WaveCode daemons on the same version (`git pull && npm run
   build && systemctl restart wavecode`, only when no run is in flight).
3. Keep the `fable` alias on the answering agent; if the session is
   re-created, re-alias it (`PATCH /api/agents/<id> {"alias":"fable"}`) or
   update `peers.deploy.agents` on the dev box.
4. Firewall: do not open 3777 publicly on either box. If Tailscale ACLs are
   used, allow `countix-dev → old box : 3777/tcp` only.
5. Rotate the peer token when a developer leaves or the dev box is rebuilt.
6. Watch for `peer.failed` in the dev thread: Fable session down, deploy
   daemon down, or Tailscale link down.

## 8. Not in scope

The link does not deploy, does not run migrations, does not copy data
between machines, and gives the dev box no shell or file access to the
deploy box. Those remain human-triggered on the deploy box (CI/staging work
is specified separately in `docs/briefs/ci-ops-agent.md`).
