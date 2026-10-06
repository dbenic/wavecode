# Working inside WaveCode — rules for agents

You are a coding agent running under WaveCode. People steer you from a web
UI; WaveCode reads your terminal. These rules keep the shared repository and
the shared machine safe. They apply on top of the project's own CLAUDE.md /
AGENTS.md, and win when they conflict.

## 1. Where you are

- You run in a tmux session that WaveCode owns, on a shared development
  server. Your working directory is **your own git worktree** of the project
  (`~/.wavecode-data/worktrees/<your-name>`), checked out on **your lane
  branch `wc-<your-name>`**. Other agents have their own worktrees — never
  `cd` into them, read them or edit them.
- Your CLI login is a **credential profile** (somebody's subscription). Never
  read, print or copy anything under `~/profiles`, `~/.ssh`, `*.credentials*`,
  `auth.json`, `.env*` with real values, or any token. If a command would show
  a secret, do not run it.
- Prompts arrive typed into your terminal. The last lines you print are what
  people see in the thread. Keep the final summary short and factual.

## 2. Git and GitHub — the only allowed moves

- Work **only on your lane branch**. Never check out, commit to, merge into
  or push `main` (or any protected branch). Never force-push. Never rewrite
  history that has been pushed. Never delete or rename branches you did not
  create. Never change remotes, hooks or git config (your author identity is
  set for you — leave it).
- Bring `main` in with `git merge origin/main`, not rebase, unless the task
  says otherwise. Resolve conflicts by hand; never discard other people's
  changes to make a conflict go away.
- Commit small and often, with messages that say *why*. Push only your lane:
  `git push -u origin wc-<your-name>`.
- Pull requests are opened by the integrator or by Promote. Do not open,
  merge or close PRs unless the task explicitly asks you to.
- Never commit secrets, `.env` files with values, `node_modules`, build
  output or large binaries. Never touch CI, deploy or production
  configuration unless the task is explicitly about it.
- No `git worktree` commands, no `git clean -fdx`, no `reset --hard` on
  anything that is not your own uncommitted work.

## 3. How work flows

- Every task carries a template (build, review, verify, spec) and comes from
  a **project room**: `~/.wavecode-data/rooms/<project>/` — `SPEC.md` is
  what we are building, `ROOM.md` the running status, `LEDGER.md` and
  `REPORTS/` the evidence, `DECISIONS.md` the decisions so far. Read
  `SPEC.md` and `ROOM.md` before a non-trivial task. Never edit `SPEC.md`
  or `DECISIONS.md` yourself — put proposed changes in your report.
- **Finish every task** with a short summary of what you did, what you
  tested, and a final line on its own: `RESULT: PASS` or
  `RESULT: FAIL — <reason>`. Without it the task is not done.
- A **different agent reviews your diff** (your lane against `main`). If the
  verdict is NEEDS FIXES, the issues are typed into your terminal: fix them on
  the same branch, re-run the tests, finish again with a RESULT line. If you
  disagree with a point, say why in one line — do not argue at length.
- When **you** review: run the tests yourself, never trust the author's
  summary, check that new tests actually fail without the change, check the
  diff against `SPEC.md`. Answer in the fixed format, ending with a standalone
  line `VERDICT: PASS`, `VERDICT: NEEDS FIXES` or `VERDICT: REJECT`.
- **Hand-offs and documents**: write them to the room's `REPORTS/` when the
  task says so, otherwise to `~/inbox/<your-name>-<topic>-<YYYYMMDD>.md`, and
  name the absolute path in your final summary — it becomes a link in the UI.
- **Questions for a human**: ask once, clearly, with the options as `[ ] …`
  lines, then stop and wait. Never poll, loop, sleep or re-check on a timer;
  WaveCode wakes you when there is something to do.

## 3b. Asking the deploy box (production data, read-only)

You cannot reach production. A separate agent on the deploy box can read it
and answers questions through WaveCode (docs/peers.md). To ask, print one
line on its own, exactly like this, and then stop and wait:

    ASK deploy/fable: How many invoices were booked for tenant X in September 2026, and with which VAT codes?

WaveCode picks the line up, sends the question, and when the answer arrives
it is typed into your terminal as `[Answer from deploy/fable …]` with the
path of the full text under `~/inbox/answers/`. Minutes, not seconds. Rules:

- One clear, self-contained question per line; include the context the
  answerer needs (tenant, period, table or screen). Follow-ups are new lines.
- Ask only for facts to read: counts, examples, schema, current values.
  Never ask it to change, delete, deploy or run migrations — it is a read
  path, and such requests are logged and refused.
- Never ask for secrets, tokens, personal data beyond what the task needs.
- Quote the answer file path in your summary so people can check the source.

## 4. Testing and running things

- Run the project's test command in your worktree before finishing (for
  Wavepulse: `npm test`, or the gate the task names). Docker is available for
  testcontainers. Use the project's `.env.example`; never production values.
- Do not start long-running servers on fixed ports unless the task names the
  port. Stop anything you started before you finish.
- Do not install global packages, do not use `sudo`, do not change anything
  outside your worktree except the hand-off locations above.

## 5. Never

- Never touch WaveCode itself (`~/wavecode`, its database, its config) or
  any tmux session, including your own (do not exit the CLI).
- Never call production systems or use production credentials.
- Never read other agents' transcripts, worktrees or inboxes unless the task
  hands you a specific path.
- Never "fix" a failing review by weakening or deleting tests.
