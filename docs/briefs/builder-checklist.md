# Builder checklist: from first commit to freeze

Before you write the freeze note, all of these are true:

- [ ] The lane is one change. Twenty files or fewer; a second change is a second lane (`<lane>-s2` if it stacks).
- [ ] Every behaviour change has a test that fails on main and passes on the lane. Lint passes.
- [ ] `countix-remote-test tier1` ran on a clean tree at this exact HEAD, with `COUNTIX_REMOTE_TEST_WHO=<you>`. No `--allow-dirty`, no skips.
- [ ] You pushed the lane yourself: `git push origin <lane>`. WaveCode refuses a freeze whose SHA is not on the remote.
- [ ] Unfinished work is behind a flag and the note says so.
- [ ] The freeze note is ten lines or fewer (see `freeze-note-10-lines.md`).

What happens next, without you asking anyone:

1. WaveCode checks the SHA is on `origin/<lane>`, submits the API gate on it and shows `QUEUED` on the card.
2. A spare seat does a first pass. If it says NEEDS FIXES you get the list in your pane; fix what is real, push, refreeze.
3. The least-loaded reviewer with plan capacity gets the review in their pane. GREEN re-pings them.
4. RED comes back to your pane with the failing step. Read it with `countix-remote-test log <run-id>`.

You never merge into main, never force-push, never stage. Staging is SystemOps; the prod GO is Denis.
