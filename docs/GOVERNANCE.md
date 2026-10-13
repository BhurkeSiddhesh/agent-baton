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

The repository owner is currently the release decision-maker. Delegation of merge/publish access must be documented in a tracked issue or PR, not inferred from coding-agent assignments. A sole maintainer may have to take emergency action without a second reviewer; record that exception and the subsequent independent follow-up review before considering the incident closed.

## Changes and review expectations

All non-trivial code and documentation changes should reference one tracked issue. Use `Refs #N` for partial progress and `Closes #N` only when its verifiable acceptance criteria are met. Reviewers should explicitly evaluate: operating-system/Node compatibility, error handling, trust boundaries, CLI help/docs, regression evidence, and whether a new runtime dependency or external network call has been introduced.

Security-sensitive code (process launch, secret handling, GitHub workflows, merge authorization, file permissions or ledger integrity) warrants an independent human review where possible and the full security CI suite. An agent-generated summary or a success-shaped ledger event is not an adequate replacement.

## Compatibility contracts (pre-1.0)

The project currently declares `0.1.x`, Node 18+ and zero required runtime dependencies. Version 1 of `.baton/config.json` and `.baton/plan.json` and version 1 ledger events (`hv`) are current *formats*, not an indefinite promise that future runtimes accept all old versions. In particular:

| Surface | Patch-level expectation | Breaking-change process |
|---|---|---|
| Public CLI commands/options and exit codes | Preserve documented accepted forms and 0/1/2/3 meanings; tighten dangerous behavior only with explicit migration notes | Track issue, regression tests, updated generated command docs and changelog; migration or opt-in flag where feasible |
| JSON output / config / plan / ledger | Avoid silent field removals; continue reading supported on-disk versions; reject unreadable newer versions clearly | Schema version bump with fixture tests, compatible reader/upgrade route and rollback steps; no silent data loss |
| Installer-generated files and adapters | Preserve user edits, managed blocks and existing root files; avoid destructive upgrades | Add manifest/sidecar migration tests and document refreshed adapter behavior |
| Offline package and supported platforms | Keep no mandatory network service, no new runtime dependencies and required OS coverage | Explicit compatibility announcement, versioning justification and smoke tests before release |

Before version 1.0, follow the existing semver scheme but do **not** infer that every minor release is non-breaking. Potentially breaking changes must be labeled and explained in the release notes with a concrete upgrade or rollback procedure. Users should pin known-good versions for production and stage upgrades in disposable repositories.

## Deprecation and migration

1. Create a tracked issue describing the motivation, old behavior and migration/rollback path. Mark security changes separately.
2. When possible, introduce a deprecation warning and transition period before removal; otherwise explicitly document why a safety fix must change behavior immediately.
3. Provide tests covering old accepted inputs, new behavior, invalid inputs and replay of existing on-disk data.
4. For persistent-format changes, exercise upgrade/downgrade in disposable repositories, including corrupted or interrupted operations; do not claim downgrade support unless tested.
5. Update README, generated `docs/COMMANDS.md` (when relevant), the compatibility reference and `CHANGELOG.md`.
6. Require passing targeted tests and the supported-platform matrix before release authorization.

## Releases and exceptions

The maintainer checks issue completion, release notes, security exposure, package contents, platform CI and actual install/uninstall smoke results before signing off a tag. Version-tag quality gates and a dedicated release process are tracked by [BAT-004](https://github.com/BhurkeSiddhesh/agent-baton/issues/4) and [BAT-087](https://github.com/BhurkeSiddhesh/agent-baton/issues/87); this document **does not** automatically protect branches, block GitHub merges, or publish packages. Releases must never be represented as ready solely because an agent accepted a packet.

For a hotfix bypassing ordinary review, record the affected SHA, severity, reason, approving maintainer, temporary safeguards, rollback instructions and follow-up review on a tracked issue or PR. Never put vulnerability exploit details or credentials into a public record.

## Reporting and conduct

Use the private reporting path in [SECURITY.md](../SECURITY.md) for vulnerabilities. Non-security behavior and contributor conduct are governed by [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md); conduct reports ordinarily go to the maintainer through the channels described there. **If the maintainer is implicated, do not send that report to the maintainer.** GitHub's platform-level Report abuse mechanism is an external escalation option for GitHub-hosted conduct; it is not an independent project appeal process. A separate independent project contact has not yet been designated. The recipient should acknowledge, investigate impartially, restrict sharing to those needed for resolution, and document remediation without exposing reporters.
