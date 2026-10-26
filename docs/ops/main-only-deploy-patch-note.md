# Patch note for SystemOps: the deploy guard asks WaveCode `deployable`

Status: proposed by WaveCode (Claude for Denis), 26 Oct 2026. SystemOps applies it only after Denis's OK.
Rule: "main is the only road to prod" (Denis, 26 Oct 2026). Prod deploys only a SHA that is on
origin/main, contains the SHA prod runs now (forward-only), and has quick + api GREEN on that exact SHA.

## 1. Before any production deploy, the guard runs

```bash
wavecode deployable <full-sha>            # exit 0 YES, 2 NO (reasons printed), 1 error (daemon down, bad SHA)
wavecode deployable <full-sha> --json     # the same as JSON (checks.on_main / contains_prod / quick / api, reasons[])
```

The deploy proceeds only on exit 0. Exit 2 prints one line per failed check, in plain words
(which SHA main is at, what prod runs, which suite is missing or RED). Exit 1 means the guard could
not decide: do not deploy, tell Denis.

`wavecode deployable` replaces `wavecode gate-status <sha> --require quick,api` in the guard; the
gate part is the same checker, the two git checks are new.

## 2. After every successful production deploy, record what prod runs

```bash
wavecode prod-sha <full-sha-now-on-prod>
```

Admin token (the service config's `auth.fallback_token`, as for the other `wavecode` commands on the
box). WaveCode keeps it in the DB (`kv_settings production_sha:<project>`, event `prod.sha`) and
uses it for the "contains prod" check and the prod-drift banner. Until it is recorded once,
`deployable` answers NO with "what production runs is not recorded".

One-time: after this note is applied, record the SHA prod runs today (Denis named 6baf6e92; if the
Hipsl hotfix f3ccb4bb is what is live, record that one instead).

## 3. Nothing else changes

- Denis's typed `GO prod <sha>` in the SystemOps chat stays the trigger. The guard only refuses.
- No branches cut from prod, no bundles, no force-push. A hotfix is a fast lane in the merge queue
  (admin priority), gated like any lane.
- The daemon side (`GET /api/deployable/:sha`, `releases.main_only: true`) is live on countix-dev
  since the WaveCode build that carries this note; the Stage/Promote buttons already refuse a
  production request that is not deployable.
