#!/usr/bin/env bash
# WaveCode Sandbox Enforcement Script
# Ensures the server environment is properly sandboxed.

set -euo pipefail

echo "=== WaveCode Sandbox Enforcement ==="

# 1. Verify unprivileged user
if [ "$(id -u)" = "0" ]; then
  echo "ERROR: Do not run WaveCode as root"
  exit 1
fi
echo "✓ Running as unprivileged user: $(whoami)"

# 2. Strip git push remote URLs from all repos in /workspace
if [ -d "/workspace" ]; then
  find /workspace -name ".git" -type d 2>/dev/null | while read gitdir; do
    repo=$(dirname "$gitdir")
    pushurl=$(git -C "$repo" remote get-url --push origin 2>/dev/null || true)
    if [ -n "$pushurl" ]; then
      git -C "$repo" remote set-url --push origin no_push
      echo "✓ Disabled push for: $repo"
    fi
  done
else
  echo "  /workspace not found, skipping git push disable"
fi

# 3. Verify no sudo
if sudo -n true 2>/dev/null; then
  echo "WARNING: User has passwordless sudo access. Consider restricting."
else
  echo "✓ No sudo access"
fi

# 4. Check workspace directories exist
for dir in /workspace/artifacts /workspace/agents /workspace/transcripts; do
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir"
    echo "✓ Created $dir"
  else
    echo "✓ $dir exists"
  fi
done

# 5. Verify tmux is available
if command -v tmux &>/dev/null; then
  echo "✓ tmux available: $(tmux -V)"
else
  echo "ERROR: tmux not found"
  exit 1
fi

# 6. Verify Node.js version
if command -v node &>/dev/null; then
  NODE_VER=$(node -v)
  echo "✓ Node.js: $NODE_VER"
else
  echo "ERROR: Node.js not found"
  exit 1
fi

echo ""
echo "=== Sandbox enforcement complete ==="
