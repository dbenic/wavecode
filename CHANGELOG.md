# Changelog

All notable changes to WaveCode are documented here.

## [0.1.0] — 2026-04-07

### Added
- Initial open-source release
- **Agent management**: Adopt existing tmux sessions or spawn new ones
- **Task dispatcher**: DAG-based task queue with dependencies, retries, and auto-chaining
- **Dashboard**: SSE-driven React PWA with live agent status, task board, and review queue
- **Command chat**: Multi-provider chat with prompt enhancement
- **Research specs**: One-shot research jobs via Anthropic, OpenAI, Gemini, Perplexity, and xAI
- **Code review**: Review queue with approve/reject/retry workflow
- **Artifacts**: Immutable file sharing between agents with SHA-256 integrity
- **Guides & templates**: Import skill libraries from git repos (compatible with awesome-claude-skills)
- **Context briefing**: Auto-prepend cross-agent context to task prompts
- **Decision tracking**: Extract and share architectural decisions across agents
- **Health monitor**: Heartbeat-based hang detection with auto-restart
- **Auth**: Tailscale-based and token-based access control
- **Notifications**: Web Push, ntfy.sh, and Telegram Bot API
- **One-line installer**: `curl | bash` install script for Linux and macOS
- **systemd service**: Production deployment with security hardening
- **294 bundled skills**: From Anthropic, Trail of Bits, Expo, obra/superpowers, and more
