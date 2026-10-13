#!/bin/sh
# Agent Baton bootstrap: check Node >= 18, then run the installer from GitHub.
# Usage: sh install.sh [init options]     e.g. sh install.sh --yes --agents claude,codex
# Once published to npm, "npx agent-baton init" does the same.
set -eu

if ! command -v node >/dev/null 2>&1; then
  echo "agent-baton: Node.js 18 or newer is required but 'node' was not found. Install it from https://nodejs.org" >&2
  exit 1
fi

major=$(node -p "process.versions.node.split('.')[0]")
if [ "$major" -lt 18 ]; then
  echo "agent-baton: Node.js 18 or newer is required (found $(node -v)). Update from https://nodejs.org" >&2
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "agent-baton: 'npx' was not found. It ships with npm; reinstall Node.js from https://nodejs.org" >&2
  exit 1
fi

exec npx --yes github:BhurkeSiddhesh/agent-baton init "$@"
