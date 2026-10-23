[Agent Baton](../README.md) / [Docs](../README.md#documentation) / Governance and compatibility

# Project governance and compatibility policy

This policy applies to changes proposed for Agent Baton. It describes **maintainer intent and review criteria**, not an assertion that GitHub branch rules are already enabled. The current [unprotected-branch backlog](https://github.com/BhurkeSiddhesh/agent-baton/issues/5) remains a technical prerequisite to enforced policies.

## Roles and authority

| Role | Responsibilities | Limitations |
|---|---|---|
| Contributor (human or agent) | Scope the issue, test both positive and refusal paths, disclose risk/compatibility impact, supply actual CI evidence | May propose changes but not self-certify or bypass checks |
| Code reviewer | Inspect the exact diff and commit, verify acceptance criteria and tests independently, request changes when evidence is missing | A Baton `--by` roster name is not an authenticated review |
| Maintainer | Triage backlog, manage release decisions, review security impact, preserve support commitments, perform publication | Must document risk and exceptions; cannot treat missing branch protection as enforced review |
| Security reporter | Report privately and coordinate a reproducible, responsibly scoped disclosure | Do not expose credentials or exploitable details in public issues |

### Maintainer and reviewer responsibilities
- **Maintainer responsibilities:**
  - Triage issues and backlogs, steer roadmap sequencing, and protect core architectural boundaries.
  - Review and authorize release decisions, version tags, and official package publication.
  - Champion security vulnerability remediation and coordinate responsible private disclosures.
  - Enforce foundational project invariants: zero runtime dependencies, offline-first reliability, multi-platform consistency, and deterministic state transitions.
  - Review and document hotfix exceptions, ensuring mandatory post-incident audit trails.
- **Reviewer expectations:**
  - Inspect exact diffs, commit structures, and adherence to conventional commit messaging.
  - Verify acceptance criteria and test coverage independently; request changes when reproducible test evidence is absent.
  - Evaluate operating-system and Node runtime compatibility (Linux, macOS, Windows; Node 18, 20, and 22).
  - Probe error handling, refusal paths, trust boundaries, and CLI documentation parity (`docs/COMMANDS.md`).
  - Confirm that no new runtime dependencies or unauthorized external network requests are introduced.
  - Disallow self-certification: a Baton roster designation (e.g., `--by <agent>`) is an audit attribution, not an authenticated human review or release sign-off.

The repository owner (`BhurkeSiddhesh`) is currently the release decision-maker. Delegation of merge or publish access must be documented in a tracked issue or PR, not inferred from coding-agent assignments. A sole maintainer may have to take emergency action without a second reviewer; record that exception and the subsequent independent follow-up review before considering the incident closed.

## Changes and review expectations

All non-trivial code and documentation changes should reference one tracked issue. Use `Refs #N` for partial progress and `Closes #N` only when its verifiable acceptance criteria are met. Reviewers should explicitly evaluate: operating-system/Node compatibility, error handling, trust boundaries, CLI help/docs, regression evidence, and whether a new runtime dependency or external network call has been introduced.

### Required tests and evidence for PR acceptance
1. **Automated test suite passing:** All unit, integration, and platform tests must pass cleanly (`npm test`). Pull requests must include passing CI evidence across Ubuntu, Windows, and macOS on Node 18, 20, and 22, along with the Debian 11 Git 2.30 baseline.
2. **Negative and refusal path tests:** Every new CLI command, flag, schema field, validation rule, or permission profile must include automated tests asserting graceful refusals, expected error messages, and standard exit codes (`1` for rule violation / `BatonError`, `2` for usage error, `3` for internal error).
3. **Documentation and command parity:** If CLI commands, options, or help summaries are modified, `docs/COMMANDS.md` must be regenerated (`node .github/scripts/gen-commands.mjs`) and committed. Markdown links must resolve cleanly (`node .github/scripts/check-links.mjs`).
4. **Zero-dependency verification:** `package.json` `dependencies` must remain empty. Automated package inspection ensures no runtime dependencies or extraneous development assets leak into the distribution tarball.
5. **Security review and CI:** Security-sensitive code (process execution, credential scanning, permissions, GitHub workflows, ledger integrity) warrants an independent human review and the full security CI suite. An agent-generated summary or a success-shaped ledger event is not an adequate replacement.
6. **Rollback and migration plans:** Pull requests altering persistent storage formats, state machines, or configuration schemas must disclose a tested rollback or migration procedure.

## Compatibility contracts (pre-1.0)

The project currently declares `0.1.x`, Node 18+ and zero required runtime dependencies. Version 1 of `.baton/config.json` and `.baton/plan.json` and version 1 ledger events (`hv`) are current *formats*, not an indefinite promise that future runtimes accept all old versions. In particular:

| Surface | Patch-level expectation | Breaking-change process |
|---|---|---|
| Public CLI commands/options and exit codes | Preserve documented accepted forms and 0/1/2/3 meanings; tighten dangerous behavior only with explicit migration notes | Track issue, regression tests, updated generated command docs and changelog; migration or opt-in flag where feasible |
| JSON output / config / plan / ledger | Avoid silent field removals; continue reading supported on-disk versions; reject unreadable newer versions clearly | Schema version bump with fixture tests, compatible reader/upgrade route and rollback steps; no silent data loss |
| Installer-generated files and adapters | Preserve user edits, managed blocks and existing root files; avoid destructive upgrades | Add manifest/sidecar migration tests and document refreshed adapter behavior |
| Offline package and supported platforms | Keep no mandatory network service, no new runtime dependencies and required OS coverage | Explicit compatibility announcement, versioning justification and smoke tests before release |

### Schema and ledger compatibility guarantees
- **Ledger readers:** Ledger readers accept checksum-valid legacy events without `hv` as v0 and current `hv: 1` events only after structural schema validation. Malformed events and unknown future versions are reported by `baton ledger verify`/`baton check` and excluded from replay and import; they cannot authorize state changes. Format migration must append traceable evidence or use an explicit upgrade tool—never edit checksum-bound history in place.
- **Causal ordering and deterministic replay:** New ledger writes include per-stream revisions and causal parents. Identical event sets replay in deterministic causal order across clones even with clock skew or out-of-order delivery. Concurrent events for the same stream revision and missing parents are reported as reconciliation errors; operators must resolve the clone divergence before treating the ledger as authoritative.
- **Simultaneous claims and arbitration:** Simultaneous claims across independent clones are arbitrated deterministically by causal topological order and timestamps (first valid claim wins). Sibling concurrent claims do not overwrite the winning claimant; losing claimants are flagged with `CLAIM_CONFLICT` and rejected from submitting branches as packet holders. Callers can use `--expected-rev` for compare-and-swap claim assertions.
- **Monotonic lease fencing tokens:** Packet leases carry monotonically increasing integer fencing tokens (`lease_token`) issued on `begin` and incremented on `reclaim` or `handoff`. Verify markers bind to the active lease token, and `submit` rejects submissions produced under superseded lease generations with `STALE_LEASE_TOKEN`. Heartbeat events from revoked generations do not revive expired leases during replay.
- **Idempotent multi-event transitions:** Multi-event transitions (`begin`, `reclaim`, `submit`, `verdict`, `block`, `handoff`, `reassign`, `gate`) support explicit operation IDs (`op_id`). Interrupted transitions can retry idempotently without emitting duplicate ledger verdicts or broadcast messages. Transition to `READY_FOR_REVIEW` requires both a valid on-disk verify marker and an authenticated `verify` event committed to the ledger under the active lease token, preventing partial or uncommitted operations from authorizing packet completion. Run `baton ledger reconcile` to reconcile interrupted operations or clean orphaned verify markers.
- **Diverged clone reconciliation:** Deterministically merges independent safe events across separate Git clones while detecting corrupt events, missing causal parents, concurrent revision collisions, competing simultaneous claims, and contradictory verdicts (`baton ledger reconcile [--from <dir>] [--dry-run]`). Unsafe conflicts are surfaced with machine-readable resolution guidance and are never silently overwritten.

### Adapter and installer compatibility guarantees
- **Adapter registry:** Supported agent adapter profiles (`claude`, `copilot`, `gemini`, `cursor`, `antigravity`, `codex`) are declared in `templates/adapters.json` and resolved via `src/install/registry.js`.
- **Managed block preservation:** Baton manages integration blocks in agent instruction files (`AGENTS.md`, Copilot instructions, Claude configurations) bounded by strict delimiters (`<!-- baton:start -->...<!-- baton:end -->`). All content outside these delimiters is strictly preserved across updates.
- **Manifest-bound non-destructive upgrades:** Installer operations are tracked in `.baton/manifest.json` with SHA-256 hashes. Rerunning `baton init` is completely idempotent. `baton uninstall` removes only unedited files matching manifest hashes, preventing accidental loss of user work.

## Deprecation and migration

Before version 1.0, follow the existing semver scheme but do **not** infer that every minor release is non-breaking. Potentially breaking changes must be labeled and explained in the release notes with a concrete upgrade or rollback procedure. Users should pin known-good versions for production and stage upgrades in disposable repositories.

The deprecation and breaking-change lifecycle adheres to the following sequence:
1. **Tracked issue and motivation:** Create a tracked issue describing the motivation, affected interfaces, legacy behavior, proposed replacement, and migration/rollback path. Mark security changes separately.
2. **Deprecation notice and warning period:** When possible, introduce a deprecation warning on stderr with a transition period spanning at least one minor release before removal; otherwise explicitly document why a safety or security fix must alter behavior immediately.
3. **Comprehensive test coverage:** Provide tests covering old accepted inputs, new behavior, invalid inputs, and replay of existing on-disk data. Assert that deprecation warnings fire appropriately for legacy invocations.
4. **Persistent-format upgrade verification:** For persistent-format changes, exercise upgrade and rollback in disposable repositories, including corrupted or interrupted operations; do not claim downgrade support unless verified by automated tests.
5. **Documentation and changelog updates:** Update README, generated `docs/COMMANDS.md` (when relevant), `docs/COMPATIBILITY.md`, and `CHANGELOG.md` under `Unreleased`.
6. **Release authorization:** Require passing targeted tests and the supported-platform matrix before release authorization.

## Releases and exceptions

The maintainer checks issue completion, release notes, security exposure, package contents, platform CI and actual install/uninstall smoke results before signing off a tag. Version-tag quality gates and a dedicated release process are tracked by [BAT-004](https://github.com/BhurkeSiddhesh/agent-baton/issues/4) and [BAT-087](https://github.com/BhurkeSiddhesh/agent-baton/issues/87); this document **does not** automatically protect branches, block GitHub merges, or publish packages. Releases must never be represented as ready solely because an agent accepted a packet.

### Release approval expectations
1. **Milestone and issue closure:** All issues targeted for the release must be completed, verified against acceptance criteria, or explicitly rescheduled.
2. **Accurate release notes:** `CHANGELOG.md` must clearly categorize all additions, changes, deprecations, removals, fixes, and security disclosures.
3. **Package validation:** `npm pack --dry-run` must verify that the published tarball contains all required runtime files, has zero runtime dependencies, and contains no leaked credentials, temporary files, or internal development metadata.
4. **Multi-platform CI gate:** The full CI matrix (Ubuntu, Windows, macOS on Node 18, 20, 22; Debian 11 Git 2.30 baseline) must be 100% green without skipped or failing required jobs.
5. **Smoke test validation:** Post-build smoke verification must execute real install, CLI invocation, and clean uninstall tests on packaged artifacts.
6. **Maintainer sign-off:** Official version tags (e.g., `v0.1.1`) and npm package publishing require explicit maintainer authorization. Autonomous agents, bots, or subagents are strictly prohibited from publishing packages or pushing release tags.

### Emergency hotfix exceptions
For a hotfix bypassing ordinary review, record the affected SHA, severity, reason, approving maintainer, temporary safeguards, rollback instructions and follow-up review on a tracked issue or PR. Never put vulnerability exploit details or credentials into a public record. An independent audit must be completed and documented before considering the hotfix incident closed.

## Security response and release ownership

Security response and vulnerability management are maintained under the private reporting policy described in [SECURITY.md](../SECURITY.md).

1. **Private reporting channel:** Security vulnerabilities must be reported through GitHub Private Vulnerability Reporting (<https://github.com/BhurkeSiddhesh/agent-baton/security/advisories/new>) or directly via email to the maintainer profile on [BhurkeSiddhesh](https://github.com/BhurkeSiddhesh) with the subject "agent-baton security".
2. **Triage and response timeline:** The maintainer acknowledges reports within 48 to 72 hours, conducts impact assessment, and collaborates with the reporter in a private GitHub advisory.
3. **Confidential patch development:** Fixes are developed in private forks, verified against regression and security tests, and reviewed independently.
4. **Release ownership:** The project maintainer retains exclusive ownership of security patch releases and coordinated disclosures. Security fixes are released as patch versions and credited in [CHANGELOG.md](../CHANGELOG.md) (unless anonymity is requested).
5. **Pre-1.0 security support:** Only the latest released version receives security patches while the project is in the 0.1.x series.

## Reporting and conduct

Use the private reporting path in [SECURITY.md](../SECURITY.md) for vulnerabilities. Non-security behavior and contributor conduct are governed by [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md); conduct reports ordinarily go to the maintainer through the channels described there. **If the maintainer is implicated, do not send that report to the maintainer.** GitHub's platform-level Report abuse mechanism is an external escalation option for GitHub-hosted conduct; it is not an independent project appeal process. A separate independent project contact has not yet been designated. The recipient should acknowledge, investigate impartially, restrict sharing to those needed for resolution, and document remediation without exposing reporters.
