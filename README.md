<p align="center">
  <img src="src/ui/public/wavecode-logo.svg" alt="WaveCode" width="200" />
</p>

<h1 align="center">WaveCode</h1>

<p align="center">
  <strong>Self-hosted multi-agent coding orchestration platform</strong>
  <br />
  Manage tmux-backed AI coding agents from a single dashboard.
  <br />
  <a href="#install">Install</a> · <a href="docs/api.md">API Docs</a> · <a href="#configuration">Config</a> · <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" />
  <img src="https://img.shields.io/badge/platform-linux%20%7C%20macos-lightgrey" />
</p>

> **🚧 Work in Progress** — WaveCode is under active development. Core features (adopt, spawn, dashboard, task dispatch, review queue) are functional and used daily, but APIs may change, rough edges exist, and documentation is still catching up. Contributions and feedback are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

WaveCode orchestrates multiple CLI coding agents (Claude Code, Codex CLI, Aider, and others) running in tmux sessions. It provides a mobile-first PWA dashboard for monitoring, task dispatch, artifact sharing, code review, and research — accessible from phone or desktop.

## Clients

WaveCode is a server with a documented [HTTP/SSE API](docs/api.md). Multiple clients can connect to it:

| Client | Where | Best for |
|---|---|---|
| **Web PWA** | Bundled in this repo (`src/ui/`) | Phone, casual monitoring, dispatch from anywhere |
| **[WaveCode Desktop](https://github.com/dbenic/wavecode-desktop)** | Separate repo | Deep desk work — SSH-first, tmux-native, drag-drop, native notifications |
| **CLI** | Bundled in this repo (`src/cli/`) | Scripting, CI integration, headless ops |

Want to build another client? The API contract is in [`docs/api.md`](docs/api.md). Every client is a peer; none are privileged.

## Features

- **Agent management** — Adopt existing tmux sessions or spawn new ones
- **Task queue** — DAG-based dispatch with retries, dependencies, and auto-chaining
- **Live dashboard** — SSE-driven React PWA with real-time agent status
- **Command chat** — Talk to agents from the UI with prompt enhancement
- **Research specs** — Multi-provider research with Anthropic, OpenAI, Gemini, Perplexity, and xAI
- **Code review** — Review queue with diff preview, approve/reject/retry
- **Artifacts** — Share files between agents with immutable storage
- **Guides & templates** — Import skill libraries (Anthropic Skills, community repos) and attach to agents
- **Context briefing** — Auto-prepend cross-agent awareness context to task prompts
- **Notifications** — Web Push, ntfy.sh, and Telegram
- **Auth** — Token-based access control, with optional private-network/Tailscale mode

## Install

### Published GitHub Repo

```bash
curl -fsSL https://raw.githubusercontent.com/dbenic/wavecode/main/scripts/install.sh \
  | WAVECODE_REPO=https://github.com/dbenic/wavecode.git bash
```

Replace `dbenic` with the GitHub owner or organization that hosts your public fork. The installer clones WaveCode into `~/.wavecode`, builds the server and UI, creates a default config, generates an access token, and adds shell aliases.

**Requirements:** Node.js 22+, tmux, git. The installer checks for these and tells you how to get them.

### From A Local Clone Or Unpublished Fork

```bash
git clone <repo-url> ~/src/wavecode
cd ~/src/wavecode
./scripts/install.sh
```

### Manual Install

```bash
git clone <repo-url> ~/.wavecode
cd ~/.wavecode
npm ci && npm ci --prefix src/ui
ACCESS_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))")"
cp config.example.yaml config.yaml
ACCESS_TOKEN="$ACCESS_TOKEN" node -e "const fs=require('node:fs'); let s=fs.readFileSync('config.yaml','utf8'); s=s.replace(/method:\\s*tailscale/,'method: token'); s=s.replace(/fallback_token:\\s*null/, 'fallback_token: ' + process.env.ACCESS_TOKEN); fs.writeFileSync('config.yaml', s, {mode:0o600});"
echo "WaveCode access token: $ACCESS_TOKEN"
npm run build
node dist/cli/index.js server start --foreground
```

Open **http://localhost:3777** in your browser.

On Linux, `scripts/wavecode.service` is a baseline systemd unit. If you add stronger hardening such as `ProtectSystem=strict`, make sure every configured writable path is included in `ReadWritePaths`, especially `projects_root`, worktrees, transcripts, and artifact storage when they live outside `~/.wavecode`.

WaveCode handles app-level auth, not your network perimeter. If you expose it outside localhost, securing that network path is up to you: firewall rules, reverse proxy, SSH tunnel, VPN, Tailscale, or similar.

### Dedicated Server Setup

For a full guide on provisioning a server from scratch (any provider — Hetzner, OVH, DigitalOcean, AWS, your own hardware), see **[docs/server-setup.md](docs/server-setup.md)**. It covers OS install, security hardening, Node.js setup, Tailscale/nginx access, and systemd configuration.

## Quick Start

### 1. Start WaveCode

```bash
# If you just ran scripts/install.sh, open a new shell or source your shell rc
# first so the `wavecode` alias exists:
#   source ~/.zshrc
# or:
#   source ~/.bashrc

# Foreground
wavecode server start --foreground

# Background (recommended)
wavecode server start
```

The UI will prompt for the access token generated during install. If you used the manual install path, use the `ACCESS_TOKEN` printed in the shell.

### 2. Start a coding agent

In a separate tmux session, start any supported CLI agent:

```bash
tmux new -s my-agent
claude                  # or: codex --full-auto, aider --yes
```

### 3. Adopt the agent

Open the WaveCode dashboard → **Agents** → **Scan** → select the tmux session → **Adopt**.

That's it. WaveCode monitors the session, detects idle/working status, and lets you dispatch tasks from the UI.

### 4. Dispatch a task

Go to **Tasks** → **New Task** → write your prompt → assign to an agent → **Create**.

WaveCode sends the prompt to the agent's tmux session and tracks the run to completion.

## Architecture

```
Phone/Desktop (PWA)
    │ HTTPS + SSE
    ▼
┌──────────────────────────────────┐
│  WaveCode Server (Hono + SSE)   │
│  ├── Session Manager (tmux)     │
│  ├── Task Dispatcher (DAG)      │
│  ├── Research Runner (multi-LLM)│
│  ├── Review Queue               │
│  ├── Event Bus (SQLite → SSE)   │
│  └── Health Monitor             │
└──────────────────────────────────┘
    │         │         │
 tmux-1    tmux-2    tmux-3
 claude    codex     aider
```

**Two operating modes:**
- **Adopt** — discover and monitor existing tmux sessions via `capture-pane` polling
- **Spawn** — create new sessions with a runner wrapper that emits structured events

## Configuration

Copy `config.example.yaml` to `config.yaml` and edit:

```yaml
server:
  port: 3777
  host: 0.0.0.0

paths:
  projects_root: ~/projects        # spawned no-repo agents use <projects_root>/<agent-name>
  worktrees_root: .wavecode-data/worktrees
  transcripts_root: .wavecode-data/transcripts
  teams_root: teams
  guides_root: guides
  templates_root: templates

autonomy:
  auto_dispatch: true
  auto_restart: true
  hang_timeout_min: 10
  max_task_retries: 2

runtimes:
  claude-code:
    command: claude --permission-mode bypassPermissions
    idle_pattern: '\$\s*$'
  codex:
    command: codex --full-auto
    idle_pattern: '^>\s*$'
  aider:
    command: aider --yes
    idle_pattern: '^>\s*$'

auth:
  method: token            # default portable mode
  fallback_token: null     # installer generates one; set manually if needed
  trusted_proxies: []      # set when running behind a reverse proxy

llm:
  provider: anthropic         # or 'openai-compatible' for local models
  api_key: null               # for command chat & research
  anthropic_api_key: null
  openai_api_key: null
  gemini_api_key: null
  perplexity_api_key: null
  xai_api_key: null
  base_url: null              # set for local: http://localhost:11434/v1
  model: claude-sonnet-4-20250514
```

See [config.example.yaml](config.example.yaml) for all options, including local LLM setup examples.

Spawned agents need a real workspace. If you plan to create agents from chat or the dashboard without attaching a repo/template, set `paths.projects_root` to a writable directory first. WaveCode will create `projects_root/<agent-name>` automatically.

WaveCode does not manage your network exposure. The application enforces access tokens, but transport-level security and network reachability are still your responsibility.

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `WAVECODE_HOME` | Installation directory | `~/.wavecode` |
| `WAVECODE_PORT` | Server port (overrides config) | `3777` |
| `WAVECODE_REPO` | Git URL used by `scripts/install.sh` when installing from a published repo | unset |
| `ANTHROPIC_API_KEY` | Anthropic API key fallback | — |
| `OPENAI_API_KEY` | OpenAI-compatible API key fallback | — |
| `GEMINI_API_KEY` | Gemini API key fallback | — |
| `PERPLEXITY_API_KEY` | Perplexity API key fallback | — |
| `XAI_API_KEY` | xAI API key fallback | — |

## Auth Modes

- **`token`** — Default portable mode. Every request needs `Authorization: Bearer <token>`. SSE accepts `?access_token=<token>` query param.
- **`tailscale`** — Optional private-network mode. Use it when the service is only reachable on your tailnet or another trusted private network.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22+ with TypeScript (strict) |
| Server | Hono |
| Database | SQLite via better-sqlite3 (WAL mode) |
| Frontend | React 19 + Tailwind CSS |
| Live updates | Server-Sent Events (SSE) |
| Terminal | tmux via child_process |
| Git | simple-git |

## Development

```bash
# Start server in dev mode (auto-reload)
npm run dev:server

# Start UI dev server (Vite, proxies /api to :3777)
npm run dev:ui

# Type check
npm run typecheck

# Run tests
npm test

# Rebuild native modules after switching Node versions
npm run rebuild:native

# Verify published package contents
npm run pack:check
```

If tests fail with a `better-sqlite3` `NODE_MODULE_VERSION` error after changing Node versions, run `npm run rebuild:native` and retry.

## Project Structure

```
wavecode/
├── src/
│   ├── server/          # Hono API, orchestration, persistence
│   │   ├── index.ts     # Entry point
│   │   ├── db.ts        # SQLite schema + queries
│   │   ├── session-manager.ts
│   │   ├── task-dispatcher.ts
│   │   ├── research-runner.ts
│   │   ├── guide-manager.ts
│   │   ├── template-manager.ts
│   │   └── routes/      # API route handlers
│   ├── ui/              # React PWA
│   │   └── src/
│   │       ├── views/   # Dashboard, Tasks, Review, Library, Specs...
│   │       └── hooks/   # useSSE, useApi
│   └── cli/             # CLI commands
├── scripts/
│   ├── install.sh       # Installer script
│   └── wavecode.service # systemd unit
├── config.example.yaml
├── CLAUDE.md            # Architecture/context guide for agents and humans
└── docs/
    └── api.md           # REST/SSE API reference
```

## Adding Skills & Guides

WaveCode can import skill libraries from git repos and attach them to agents:

```bash
# From the UI: Library → Guides → Add Source
# Enter a git URL like:
https://github.com/anthropics/skills.git

# Or via API:
curl -X POST http://localhost:3777/api/guide-sources \
  -H 'Content-Type: application/json' \
  -d '{"name": "anthropic-skills", "url": "https://github.com/anthropics/skills.git", "glob": "**/SKILL.md"}'
```

Compatible with [awesome-claude-skills](https://github.com/travisvn/awesome-claude-skills) and any git repo containing markdown guides.

## Supported Agents

WaveCode works with any CLI agent that runs in a terminal. **You need to install the agents yourself** — WaveCode orchestrates them but does not bundle them.

### Installing Agents

```bash
# Claude Code (requires ANTHROPIC_API_KEY)
npm install -g @anthropic-ai/claude-code
export ANTHROPIC_API_KEY="sk-ant-..."   # add to ~/.bashrc for tmux sessions

# Codex CLI (requires OPENAI_API_KEY)
npm install -g @openai/codex
export OPENAI_API_KEY="sk-..."          # add to ~/.bashrc for tmux sessions

# Aider (Python — works with any LLM backend)
pip install aider-chat
```

> **Important:** Add your API keys to `~/.bashrc` (or `~/.zshrc`) so they are available in tmux sessions spawned by WaveCode. WaveCode starts agents inside tmux, which inherits the shell environment.

### Agent Compatibility

| Agent | Command | Notes |
|-------|---------|-------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `claude` | Full support with bypass mode |
| [Codex CLI](https://github.com/openai/codex) | `codex --full-auto` | OpenAI's coding agent |
| [Aider](https://aider.chat) | `aider --yes` | Works with any LLM backend |
| Custom | Any command | Configure idle pattern in config.yaml |

## Supported LLMs

Agents call their own LLM backends. WaveCode also uses LLMs for research, command chat, prompt enhancement, and task verification. Any provider with an OpenAI-compatible API works.

### Cloud Providers

| Provider | Models | Config key |
|----------|--------|------------|
| Anthropic | Claude Sonnet / Opus / Haiku | `anthropic_api_key` or `ANTHROPIC_API_KEY` |
| OpenAI | GPT-4.1, GPT-5.4, o3, o4-mini | `openai_api_key` or `OPENAI_API_KEY` |
| Google | Gemini 2.5 Pro / Flash | `gemini_api_key` or `GEMINI_API_KEY` |
| xAI | Grok | `xai_api_key` or `XAI_API_KEY` |
| Perplexity | Sonar / Sonar Pro | `perplexity_api_key` or `PERPLEXITY_API_KEY` |
| DeepSeek | DeepSeek V3 / R1 | Via Aider or OpenAI-compatible `base_url` |
| Qwen | Qwen 3 | Via Aider or OpenAI-compatible `base_url` |

### Local / Self-Hosted

Any tool that exposes an OpenAI-compatible HTTP endpoint works with WaveCode. Set `llm.base_url` in `config.yaml` to point at your local server:

```yaml
llm:
  provider: openai-compatible
  base_url: http://localhost:11434/v1   # Ollama example
  model: llama3.3
  api_key: null                          # most local servers don't need a key
```

| Tool | Endpoint | Notes |
|------|----------|-------|
| [Ollama](https://ollama.com) | `http://localhost:11434/v1` | Drop-in local inference, supports GGUF models |
| [LM Studio](https://lmstudio.ai) | `http://localhost:1234/v1` | GUI-based, one-click model downloads |
| [vLLM](https://docs.vllm.ai) | `http://localhost:8000/v1` | High-throughput production serving, tensor parallelism |
| [llama.cpp / llama-server](https://github.com/ggml-org/llama.cpp) | `http://localhost:8080/v1` | Lightweight C++ inference, runs on CPU or GPU |
| [LocalAI](https://localai.io) | `http://localhost:8080/v1` | Multi-model server, supports audio/image too |
| [Jan](https://jan.ai) | `http://localhost:1337/v1` | Desktop app with built-in OpenAI-compatible server |
| [GPT4All](https://gpt4all.io) | `http://localhost:4891/v1` | Offline desktop app with local API server |
| [text-generation-webui](https://github.com/oobabooga/text-generation-webui) | `http://localhost:5000/v1` | Feature-rich UI with API extensions |
| [KoboldCpp](https://github.com/LostRuins/koboldcpp) | `http://localhost:5001/v1` | Optimized llama.cpp fork with web UI |

> **Tip:** Use different models for different agents. Mix cloud and local freely — for example, Claude Code on Anthropic for implementation, Aider on a local Llama 3.3 for tests, and Gemini for research specs.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions and guidelines.

## License

[Apache 2.0](LICENSE)
