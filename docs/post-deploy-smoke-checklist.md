# Post-Deploy Smoke Checklist

This checklist validates the real production path on a fresh service. It is intentionally biased toward the gaps that unit and fake-tmux integration tests cannot fully prove: real `tmux`, real runtime launch, real process restarts, and real file/attachment flows.

## Before You Start

- Keep the service log open.
- Keep `tmux ls` open in another terminal.
- If using systemd, keep `journalctl -u wavecode -f` open.
- Record the deployed commit SHA and config file used for the run.

## 1. Service Boot

- Open the UI and confirm the dashboard loads.
- Confirm `GET /api/agents`, `GET /api/settings`, and `GET /api/events` work through the deployed host.
- Confirm the configured paths exist and are writable:
  - `projects_root`
  - `worktrees_root`
  - `transcripts_root`
  - `artifacts.storage`
  - `guides_root`

Pass condition:
- No boot-time errors.
- No permission errors in logs.

## 2. Manual `tmux` Adopted Agent Control Test

This is the control case. If this fails, do not trust later spawn-path failures.

- Start a runtime manually in `tmux`.
- Adopt it through the UI or `POST /api/agents/adopt`.
- Send a simple prompt such as `pwd`, `git status`, or `echo READY`.
- Confirm output appears in the agent view.
- Leave it idle for several minutes.

Pass condition:
- The adopted agent stays attached and does not get recreated.
- No unexpected restart events.

## 3. Spawned Agent Real Test

This is the path most likely to differ from your manual `tmux` workflow.

- Create a new agent from the UI or `POST /api/agents/spawn`.
- Confirm a single `tmux` session named `wc-<agent-name>` is created.
- Confirm the workspace directory is the expected real path:
  - normal spawn without repo: `<projects_root>/<agent-name>`
  - repo-backed spawn: `<worktrees_root>/<agent-name>`
- Confirm the session stays stable for several minutes without being recreated.
- Send the same simple prompt used in the adopted-agent test.
- Confirm output appears and status transitions make sense: `idle -> working -> idle`.

Pass condition:
- Exactly one session is created.
- No spontaneous restart loop.
- No runner socket or `nc -U` errors in logs.

## 4. Chat vs Direct Comparison

- On the same spawned agent, send one prompt in direct mode.
- Then trigger the comparable workflow through chat/orchestration.
- Compare behavior, timing, and logs.

Pass condition:
- Chat-started work does not behave worse than direct manual send.
- No extra session churn, duplicate runs, or agent status flapping.

## 5. Long-Running Stability

- Give the spawned agent a task that takes several minutes.
- Watch `tmux ls`, the service log, and the agent output view.
- Confirm the session name stays the same.
- Confirm the agent does not jump through repeated `crashed` or `restarted` events.

Pass condition:
- Same session survives the task.
- No auto-restart unless you deliberately kill the session.

## 6. Crash Recovery

- While a spawned agent exists, kill its `tmux` session manually.
- Confirm the monitor detects the failure.
- Confirm the session is recreated once.
- Confirm the agent becomes usable again.

Pass condition:
- One recovery path.
- No duplicate agent records.
- No endless restart loop.

## 7. Service Restart Recovery

- Restart the WaveCode service while:
  - one spawned agent is idle
  - one adopted agent exists
- Reload the UI.
- Confirm agent records reconcile correctly.

Pass condition:
- Spawned agents recover without duplicate records.
- Adopted agents are either still valid or clearly marked broken if the backing session is gone.

## 8. Agent-Level File Attachment

- In the agent view, upload a small text file.
- Send a prompt that explicitly asks the agent to read and summarize it.
- Repeat once in direct mode and once in AI mode.
- Verify whether the agent can actually access the file content, not just see a filename.

Pass condition:
- The agent can read the referenced file in the deployed environment.
- Behavior is the same in the mode you expect users to rely on.

Failure notes:
- Current implementation is weaker than a true attachment flow. The UI uploads the file and appends its storage path into the prompt rather than copying it into the agent workspace.

## 9. Artifact Upload and Share

- Upload a document through the artifacts flow.
- Share it to an agent.
- Confirm the agent receives the notification and can access the file path it was given.

Pass condition:
- Upload succeeds.
- Share succeeds.
- The target agent can act on the file.

## 10. Guides / Skills / Documentation

- Attach a guide to an agent from the library.
- Confirm the guide file appears under `.wavecode/guides` inside the agent workspace.
- Open a docs page through the docs viewer.
- If using template spawn with attached guides, spawn from a template and confirm guide files land in the new workspace.

Pass condition:
- Guide attachment creates real workspace files.
- Docs render correctly.
- Template-spawned guide attachments work on a fresh host.

## 11. Minimum Regression Scenario

Run this exact sequence on every fresh deployment:

1. Adopt one manual `tmux` agent.
2. Spawn one new agent from the UI.
3. Send one direct prompt to each.
4. Start one longer task on the spawned agent.
5. Upload one text file in the agent view and ask the agent to summarize it.
6. Attach one guide from the library.
7. Restart the service once.
8. Confirm both agents are still in a sane state.

## What to Record When Something Fails

- Agent id and name
- Agent mode: `adopted` or `spawned`
- Runtime
- `tmux` session name
- Whether the failure happened in direct mode or chat/orchestrated flow
- Whether a restart happened
- Last log lines from the service
- Last visible terminal output in the agent view
