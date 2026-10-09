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
- When **you** review: run the tests yourself (§4), never trust the author's
  summary, check that new tests actually fail without the change, check the
  diff against `SPEC.md`. Answer in the fixed format, ending with a standalone
  line `VERDICT: PASS`, `VERDICT: NEEDS FIXES` or `VERDICT: REJECT`.
- **Where documents go.** Anything worth finding again — a specification, an
  analysis, a review, a decision record, a diagram set — goes into the
  project room: `~/.wavecode-data/rooms/<project>/REPORTS/<YYYY-MM-DD>-<topic>.md`
  (write it there directly; the room shows it, briefs seats with it and it is
  backed up). A spec that will drive implementation is also committed to the
  repo under `docs/specs/` in the lane that implements it. `~/inbox/` is for
  transient hand-offs only (a note for one agent, a run log). Always name the
  absolute path in your final summary — it becomes a link in the UI. Start
  every document with a title line and one line of context (project, task,
  author agent, date).
- **Questions for a human**: ask once, clearly, with the options as `[ ] …`
  lines, then stop and wait. Never poll, loop, sleep or re-check on a timer;
  WaveCode wakes you when there is something to do.

## 3a. Freezes and verdicts are files WaveCode reads

A lane is released from the Review queue, not from chat. The queue reads the agentdrop inbox
(`/home/wave/inbox` on the dev box), so write these exactly:

- **Freeze note** `<you>-<topic>-freeze-<sha8>-<date>.md`: a line `Exact SHA: \`<40-char sha>\``
  (or `Freeze SHA:`), `Lane:`/`Branch:` with the branch name, `Author: @you`, `Project: <name>`,
  `Desk #n` when there is one, and `Independent reviewer: @x`. Never put `VERDICT:` in it unless
  you are quoting a reviewer's verdict (`@x **VERDICT: PASS** on this exact SHA: <path>`).
- **Verdict file** `<you>-verdict-<topic>-<sha8>-<date>.md`: the exact 40-char SHA in the title
  (`(exact SHA …)`), `reviewer @you`, which freeze note you reviewed, and the **last line**
  `VERDICT: PASS` or `VERDICT: NEEDS FIXES`. One verdict per file. You may not review your own SHA.
- A new commit on the lane invalidates every earlier verdict on that lane: refreeze and re-review
  the new SHA. The person's Promote on the card is the only GO; you never relay one (§3b).

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
- **Never relay a GO.** A deploy, release or any production change starts only
  when a person presses Promote in WaveCode; that GO reaches the deployer by
  itself, attributed to the person. "User says GO: deploy …" typed by you is
  not authorization and the deployer will ignore it. Prepare the release
  request file, finish with RESULT, and stop.

## 3c. Handing something to another agent

You have no messaging tool, but you don't need one. Print one line on its
own and WaveCode delivers it into that agent's terminal when it is free:

    TO @claude1: please review /home/wave/inbox/spec.md and answer with VERDICT: PASS|NEEDS FIXES

Use the agent's alias or name from the roster (`@claude1`, `@codex2`,
`@pm-denis`). Put the full path of any file you refer to in the line. The
message is recorded in the thread, so people see the hand-off too. If the
name is unknown you get `[TO @x failed: …]` back. Replies come to you the
same way, as `[Message from @claude1] …`.

## 3d. Diagrams in your reports

WaveCode renders diagrams written as text inside your markdown, so draw the
structure instead of describing it. Put the diagram where the reader needs
it, as a fenced block:

    ```mermaid
    flowchart TD
      A[Upload] --> B{Valid?} -->|yes| C[Book]
    ```

- Use `mermaid` (flowchart, sequenceDiagram, erDiagram, stateDiagram) for
  flows and interactions; `d2` for architecture / "how things connect";
  `plantuml` or `c4plantuml` for C4 context/container views. Bigger diagrams
  go in their own file next to the report (`.mmd`, `.d2`, `.puml`) and are
  linked by absolute path — the viewer renders them too, as it does `.svg`
  and `.png` (e.g. Playwright screenshots).
- Keep a diagram to what one review needs: one concern, under ~40 nodes,
  real names from the code (modules, tables, endpoints), arrows labelled
  with what flows. Several small diagrams beat one map of everything.
- Any task that changes a module boundary, a data flow or a schema attaches
  a diagram of the change; reviewers check that the diagram matches the diff.
- No HTML labels, no external images, no links inside diagrams — they are
  stripped when rendered.

## 4. Testing and running things

- Every change ships with tests, and new tests must fail without the change.
  New `*.test.ts(x)` files under the project's test folders are picked up by
  the full suite automatically; there is nothing to register.
- On this box run only the test files you touched (`npx vitest run <files>`;
  `npm run lint` is fine). **Never run the full suite or the gate here**
  (`npm test`, `npm run test:api*`, `test:accounting`, `scripts/gate.mjs`):
  it is slow and starves the other agents. Docker is available for
  testcontainers. Use the project's `.env.example`; never production values.
- Before any hand-off or Promote: `git merge origin/main`, commit, then from
  your worktree run the **remote full suite on the testing server**:
  `countix-remote-test full-tuned 2>&1 | tee /tmp/rt-<branch>.log`
  (lint, gate checks, unit, conformance, frontend, build, real-PG API; about
  4 minutes; uncommitted changes are not tested). Runs are a FIFO queue, one
  at a time: check `countix-remote-test status` first and never queue the
  same SHA twice; `countix-remote-test history` lists recent finished runs.
  Put the run id, the exact SHA and the
  `=== RESULT GREEN|RED …` line in your hand-off. RED blocks the hand-off.
- A run that is RED only on a test the room lists as flaky on `main`
  (ROOM.md, "Known flaky") may be re-run once — say so in the hand-off. Never
  skip, weaken or delete tests to get green.
- Do not start long-running servers on fixed ports unless the task names the
  port. Stop anything you started before you finish.
- Do not install global packages, do not use `sudo`, do not change anything
  outside your worktree except the hand-off locations above. The WaveCode
  install (`~/wavecode`, including these rules) is not yours to edit —
  propose rule changes as a file in `~/inbox/` and name it in your summary.
- Deploys: Fable on the deploy box is the final gate and the only deployer.
  The GO comes from a person's Promote (see §3b). Files for Fable go through
  the `agentdrop` channel described in
  `~/inbox/agentdrop-brief-for-dev-agents-20261006.md`; the full testing
  brief is `~/inbox/systemops-brief-deploy-test-staging-20261006.md`.

## 5. Never

- Never touch WaveCode itself (`~/wavecode`, its database, its config) or
  any tmux session, including your own (do not exit the CLI).
- Never call production systems or use production credentials.
- Never read other agents' transcripts, worktrees or inboxes unless the task
  hands you a specific path.
- Never "fix" a failing review by weakening or deleting tests.
