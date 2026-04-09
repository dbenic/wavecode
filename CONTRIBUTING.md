# Contributing

## Setup

```bash
npm ci
npm ci --prefix src/ui
cp config.example.yaml config.yaml
```

Install the external tools you plan to use in `runtimes`, especially `tmux` and at least one agent CLI.

## Development workflow

1. Create a focused branch.
2. Keep changes scoped to a single concern when possible.
3. Add or update tests for behavioral changes.
4. Run the full verification set before opening a PR.

## Verification

```bash
npm test
npm run typecheck
npm run build
npm run pack:check
```

## Implementation standards

- Prefer explicit service boundaries over route-level orchestration.
- Keep auth and runtime lifecycle changes covered by tests.
- Avoid introducing new hardcoded filesystem roots.
- Do not commit secrets, local databases, or generated runtime state.

## Pull requests

- Describe the behavioral change, not just the code diff.
- Call out config, migration, or operational impact.
- Include screenshots for UI changes when relevant.
