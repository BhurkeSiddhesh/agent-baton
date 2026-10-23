# Changelog

All notable changes to Agent Baton are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Strengthened protected path policies and configuration immutability (BAT-016); expanded sensitive path detection to cover certificates (*.crt, *.cer, *.der, *.p8), SSH keys (id_ed25519, id_ecdsa), cloud credentials (.aws/credentials, gcloud credentials.db, azure tokens), and sensitive DBs (*.duckdb, *.kdbx). Enforces case-insensitive protection across platforms, rejects attempts to claim protected paths in plans, establishes orchestrator-only paths (.baton/config.json, AGENTS.md, docs/GOVERNANCE.md) with controlled migration exceptions, and prevents plans from defining or silently relaxing security policies.
- Hardened tool-call hook guard (`baton guard`) against path traversal edge cases: resolves URL-encoded and double-encoded traversals (`%2e%2e`, `%252e%252e`, `%2500`), maps Windows extended-length and local UNC paths while rejecting device namespaces (`\\?\`, `\\.\`), denies NTFS alternate data streams across all platforms (`file:stream`, `file::$DATA`), canonicalizes directory junctions and symlinks, normalizes redundant trailing dots/spaces/slashes, extracts paths from nested file objects and batched edit arrays, enforces fail-closed behavior for unparsable JSON and unknown payloads in block mode, unconditionally denies protected paths in block mode, and publishes dedicated bypass surface disclosures in `docs/GUARD.md`.

- Added execution identity provenance and session tracking (`resolveExecutionProvenance`); separates caller-asserted actor IDs (`--agent`) from verifiable runner and GitHub identities, stamps tamper-evident session IDs (`sess-*`, `gh-*`) and declared trust levels (`github-verified`, `ci-environment`, `local-unverified`) on ledger events, and enforces `requireActorMatch` in `checkIdentity` to prevent GitHub Actions identity spoofing.

- Introduced least-privilege execution profiles (`read-only`, `workspace-write`, `review-only`, `privileged`); enforced in plan validation and tool-call guard hooks (`baton guard`) to restrict file writes, shell execution and network access. Unauthorized escalation to `privileged` by non-orchestrator agents is rejected, and unsupported OS-level/kernel sandbox requests fail closed with explicit enforcement disclosures.

- Enhanced crash and stale-agent recovery (`baton reclaim <packet> [--crashed-pid <pid>] [--reassign <agent>] [--preserve] [--force]`); differentiates expired heartbeats from confirmed dead processes, preserves uncommitted working directory changes into permanent git rescue refs (`refs/baton/rescue/*`), clears stale verify markers to require fresh verification, and blocks reclaimed agents from submitting or heartbeating via incremented fencing tokens (`lease_token`).

- Pre-replay integrity verification (`assertSensitiveReplay`) now guards sensitive transitions (`submit`, `accept`, `merge`); refuses transitions and fast-forwards if unacknowledged corrupt, tampered, or divergent events exist, and adds optional cryptographic attestation support (`createEventAttestation`, `verifyEventAttestation`, `signEvent`, `requireAttestation`) for tamper detection and identity non-repudiation.

- Designed and implemented diverged clone ledger reconciliation (`baton ledger reconcile [--from <dir>] [--dry-run] [--json]`), providing deterministic merging of independent safe events across clones while surfacing corrupt events, missing causal parents, concurrent revision collisions, competing claims, and contradictory verdicts without silent overwrite.

- Multi-event transitions (`begin`, `reclaim`, `submit`, `verdict`, `block`, `handoff`, `reassign`, `gate`) now support explicit operation IDs (`op_id` / `--op-id`) for crash-safe idempotent retries; interrupted transitions recover without duplicate verdict events or broadcast messages, `submit` enforces authenticated ledger verify events, and `baton ledger reconcile` resolves incomplete operations.

- Monotonically increasing fencing tokens (`lease_token`) are now issued on packet claims and takeovers; verify markers bind to the active lease generation, `submit` rejects stale lease tokens, and heartbeats from revoked generations cannot revive expired leases.

- Simultaneous claims across independent clones are arbitrated deterministically by first valid causal claim; losing claimants are flagged with `CLAIM_CONFLICT` and cannot submit branches as packet holders, with CAS `--expected-rev` and `confirmClaim` available for workers.

- New ledger writes record per-stream revisions and causal parents; replay is deterministic across clones, while concurrent sibling revisions and missing parents are reported as reconciliation errors.

- Ledger events now use enforced versioned schemas at append, read, verification and import boundaries; malformed and future-version events are excluded from replay while legacy pre-version events remain readable.

- Added read-only post-release verification that aligns GitHub release metadata with the tag, package version and changelog, compares the fetched GitHub package byte-for-byte with the tagged checkout, and smoke-installs it on Linux, Windows and macOS.

### Added

- Automated zero-dependency offline package contract, optional-service exclusion, no-network Node smoke, and recorded tarball/cold-start budget evidence in CI.

- A tag-only release candidate job after the full CI release gate, with strict tag/package-version validation, offline package checks, SHA-256 artifacts, and negative status regression tests; no automatic package publication.

- Documented maintainer and contributor responsibilities, pre-1.0 compatibility, deprecation, migration and release approval expectations; clarified external platform escalation for maintainer-related conduct reports.
- Included governance-linked policy files in the npm distribution so local documentation links work.

### Fixed

- Lock recovery no longer deletes aged live/remote holders; release checks exact owner tokens, async overlap fails closed, and crash/concurrency/permission regressions run on supported OS runners.

- `verify` now refuses packet-level shell tests imported from a plan unless `--allow-shell` is supplied explicitly; validates test timeout bounds, with refusal and authorized-execution regression coverage. Existing project-level configured tests work unchanged.

- Generated cloud workflows now require a trusted, explicit `@claude` **comment** instead of automatically running on issue bodies; pin workflow action commits and document secret/permission boundaries. Existing installations must run `baton upgrade --cloud` and review any `.baton-new` files before enabling revised workflows.

- Vendored runtime installation now includes its MIT license notice in `.baton/runtime/LICENSE`.

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
