# OSS Readiness Tracker

This document tracks the highest-priority release blockers, correctness fixes, and test gaps before WaveCode is presented as a well-tested open-source project.

## Priority Order

| Priority | Status | Area | Why it matters | Target |
| --- | --- | --- | --- | --- |
| P0 | Done | Auth boundary hardening | Prevent tailscale-mode access from being bypassed through untrusted local/private reverse proxies | `src/server/auth.ts`, `src/server/auth.test.ts` |
| P0 | Done | Installer / CLI contract | Public users should not get a different `wavecode` command than the package and docs advertise | `package.json`, `src/cli/index.ts`, `scripts/install.sh`, `README.md` |
| P0 | Done | systemd template path policy | The tracked service file now matches the real writable-path story instead of advertising a broken restrictive template | `scripts/wavecode.service`, `config.example.yaml`, `README.md` |
| P1 | Done | Runtime default safety | Public defaults no longer silently start Claude in the most permissive mode | `src/server/config.ts`, `config.example.yaml`, `README.md` |
| P1 | Pending | Docs / metadata cleanup | Remove misleading claims, local-machine artifacts, and licensing ambiguity before opening wider | `landing/index.html`, `.claude/launch.json`, `package.json`, `src/ui/package.json` |
| P1 | Pending | Coverage visibility | We need a coverage report and CI threshold before claiming broad test confidence | `package.json`, `vitest.config.ts`, CI workflow |

## Test Backlog

### Must add

None at the moment in the originally identified server/UI coverage gaps.

### Should add

- One opt-in real `tmux` smoke test.
- A coverage threshold in CI after the missing high-value suites land.

## Existing Test Quality

### Strong

- `src/server/agent-runtime.integration.test.ts`
- `src/server/startup-reconcile.test.ts`
- `src/server/bootstrap.startup-integration.test.ts`
- `src/server/llm-provider.test.ts`
- `src/server/health-monitor.test.ts`
- `src/server/research-runner.test.ts`
- `src/server/runner.test.ts`
- `src/server/goal-orchestrator.test.ts`
- `src/server/task-verifier.test.ts`
- `src/server/routes/messages.test.ts`
- `src/ui/src/views/Dashboard.test.tsx`
- `src/ui/src/views/TaskBoard.test.tsx`
- `src/ui/src/views/Settings.test.tsx`

### Thin but useful

- `src/server/session-manager.test.ts`
- `src/server/task-dispatcher.test.ts`
- `src/server/routes/tasks.test.ts`
- `src/server/output-watcher.test.ts`
- `src/server/app.agent-routes.test.ts`
- `src/ui/src/hooks/useApi.test.ts`


## Working Rules

1. Fix correctness and public-contract bugs before polishing.
2. Every bug fix should land with a regression test in the same change.
3. Add direct tests for critical routes and state machines before chasing broad coverage percentages.
4. Run the real deploy smoke checklist in `docs/post-deploy-smoke-checklist.md` before claiming production stability.
