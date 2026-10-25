# Review brief: one pass, twenty minutes

You were pinged by WaveCode: `Please review freeze <sha8> on <lane> by @author`.

1. Read the freeze note (ten lines) and, if present, the first-pass file named in the ping. The first pass is a checklist, not a verdict.
2. Read the diff once, against the checklist below. Write every finding now; a second round is a failure of this pass, not of the author.
3. If the code is right and the gate is still running, write `VERDICT: PASS (gate pending)`. The gate word is read from the test history, not from you.
4. Fix nits yourself when they are yours to fix (typos, naming, a missing test line). Do not block on them.

## Checklist

- Correctness: the change does what the note says, on the paths it says, and nothing else.
- Data: no money, VAT, payroll, booking, migration or RLS path changed without a test that fails on main.
- Security: no secrets, no auth bypass, no new network call to a host the project does not already use.
- Tests: new behaviour has a test; the test fails without the change.
- Size: a lane over the file limit gets one line asking for a split, then is reviewed in chunks anyway.

## Verdict file

`<you>-verdict-<author>-<sha8>-<yyyymmdd>.md` in `/home/wave/inbox`:

```
# Verdict: @author <lane> <sha8>
SHA: <full sha>
Reviewer: @you
- [HIGH] path:line — why
- [LOW] path:line — why
VERDICT: PASS (gate pending)
```

One `VERDICT:` line, one outcome on it. Never both words on one line.
