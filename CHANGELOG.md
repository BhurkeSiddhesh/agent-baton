# Changelog

All notable changes to Agent Baton are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Documented maintainer and contributor responsibilities, pre-1.0 compatibility, deprecation, migration and release approval expectations; clarified external platform escalation for maintainer-related conduct reports.
- Included governance-linked policy files in the npm distribution so local documentation links work.

## [0.1.0] - 2026-10-13

First release.

### Added

- `baton init` installs the workflow into any repository: `.baton/` (config, plan, ledger mirror, manifest), a vendored
  runtime in `.baton/runtime/` with `sh` and Windows shims, a managed block in `AGENTS.md`, role prompts, and
  `.gitignore` / `.gitattributes` blocks. It is idempotent and never overwrites edited files (`.baton-new` sidecars).
  Flags: `--agents`, `--name`, `--test-cmd`, `--yes`, `--force`, `--dry-run`, `--no-vendor`, `--cloud`, `--hooks`,
  `--docs`, `--no-git-ignore`, `--json`.
- Adapters for Claude Code, Codex CLI, Gemini CLI, Antigravity, Cursor, GitHub Copilot, Windsurf, Cline, Aider and
  OpenCode, plus custom agents declared in `.baton/agents.json`.
- Planning: `plan show|validate|add|edit|rm|import|graph`, `split` (prompt builder and `--run` for `claude`, `codex`,
  `gemini` or a custom command, saving proposals only), `assign`, `gate`, `prompt`.
- Packet lifecycle with leases and an enforced state machine: `begin`, `heartbeat`, `reclaim`, `block`, `verify`,
  `submit`, `review`, `accept`, `fix`, `reject`, `reassign`, `handoff`, `carry`.
- Verify gate: scope guard in `git-branch`, `git-shared` and `snapshot` modes, protected paths, secret scan of files and
  branch history, and the project test command with a timeout.
- Findings (`finding add|list|resolve`) that block acceptance while BLOCKER or MAJOR findings are open.
- Bus (`bus post|list|tail`), scoreboard (`scores`), milestones and gates (`release`), `digest`, `check`, `render`.
- Append-only, hash-checked ledger with one file per event, mirrored in `.git/baton/` and `.baton/ledger/`;
  `ledger import|export|verify`.
- Git helpers: `guard` hook (Claude, Cursor and generic dialects), `worktrees`, `sync`, `merge` (fast-forward only).
- Cloud: `dispatch` (GitHub issue from a packet brief) and `init --cloud` workflows for CI, `@claude` and issue handoff.
- `doctor`, `upgrade`, `uninstall`, `agents list|add|remove|set|install`, `version`.
- `--json` on query commands, exit codes 0/1/2/3, `BATON_AGENT`, `BATON_NOW`, `NO_COLOR`.
- Zero runtime dependencies; Node 18 or newer on Windows, macOS and Linux.
- Brand assets and documentation.

[Unreleased]: https://github.com/BhurkeSiddhesh/agent-baton/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/BhurkeSiddhesh/agent-baton/releases/tag/v0.1.0
