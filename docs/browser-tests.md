# Browser tests by the agents

Decision of 25 Oct 2026: no hosted browser-testing product. The agents drive a headless
Chromium themselves through a Playwright MCP server on the box, against the dev or
staging URL on the tailnet, and write what they saw to the room's `REPORTS/`. Nothing
about customers leaves countix-dev; the seats we already pay for do the clicking.

## What is installed

`scripts/install-playwright-mcp.sh` (run as the service user) installs
`@playwright/mcp` and Chromium under `~/tools/playwright-mcp`, writes the wrapper
`~/bin/playwright-mcp` (headless, isolated context per agent, screenshots under
`~/.wavecode-data/browser-tests/<agent>/`), and adds the server to every credential
profile:

- Codex: `[mcp_servers.playwright]` in `<profile>/codex/config.toml`
- Claude Code: `mcpServers.playwright` in `<profile>/claude/.claude.json`

Each config file is backed up next to itself before it is touched. `--check` only reports.
The Chromium system libraries are installed once as root with
`npx -y playwright@1.64.1 install-deps chromium`.

A relaunched agent sees the new server; a running one picks it up on its next start.

## How an agent uses it

The `verify` room template tells the agent what to do; in short:

1. Read `SPEC.md` for the acceptance criteria, or the task for the URL and the login.
2. Open the page with the `playwright` tools (`browser_navigate`, `browser_snapshot`,
   `browser_click`, `browser_type`, `browser_take_screenshot`). Never a production URL.
3. Check every criterion against what the page shows, not against the code.
4. Write `REPORTS/<yyyymmdd>-<lane or task>-browser.md`: URL and SHA tested, what was
   clicked, what passed, what failed with the screenshot path, and one line
   `BROWSER: PASS` or `BROWSER: FAIL` at the end.

Test logins come from the project's seed files, never from a person's account.

## Where it goes next

The gate does not read these reports yet. When a lane's freeze note says
`Browser: REPORTS/<file>` the reviewer reads it; the merge queue could later require a
`BROWSER: PASS` on the exact SHA for `show` and `ask` tiers.
