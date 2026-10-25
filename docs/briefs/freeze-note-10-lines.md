# Freeze note: ten lines

File: `/home/wave/inbox/<you>-<topic>-freeze-<sha8>-<yyyymmdd>.md`

```
# <lane> freeze: <one-line title>
Project: wavepulse · Author: @<you> · Lane: <lane>
Freeze SHA: <full 40-character sha, pushed>
TIER: show
Change: <what and where, one sentence>
Tests: <what fails on main without this; which suites ran: tier1 GREEN on this SHA>
Risk: <paths touched that a reviewer must look at first>
Flags: <unfinished work behind a flag, or "none">
Depends: <lane or SHA this stacks on, or "none">
Reviewer: WaveCode assigns
```

Rules: one SHA, no prose paragraphs, no history. The reviewer reads the diff; the note
tells them where to look first. `TIER:` is `ship`, `show` or `ask` (rule 7); WaveCode
raises it to `ask` for booking, VAT, payroll, payments, migrations, RLS and auth paths.
