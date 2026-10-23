[Agent Baton](../README.md) / [Docs](../README.md#documentation) / Branch and tag protection

# Branch and tag protection runbook (BAT-005)

**Current status:** This document prescribes repository settings. It does not configure or verify any GitHub ruleset. Check **Settings → Rules → Rulesets** and the `main` branch metadata before claiming enforcement.

## Activate the main/release branch ruleset

1. As a repository administrator open **Settings → Rules → Rulesets → New branch ruleset**, set enforcement to **Active**, and target `main` plus `release/*` (create the latter only if the project uses release branches).
2. Require a pull request before merging, block force pushes and deletions, require resolved conversations, and require successful checks on the latest PR head. Enable checks from an expected source (GitHub Actions) where GitHub offers that option.
3. Require **both** exact check names from a recent successful PR:
   - `branch protection gate (all required CI checks)` — waits for the full OS/Node matrix, Git 2.30 baseline, unit, integration, security, smoke, docs and offline package checks; fails when any prerequisite is skipped, cancelled or failed.
   - `test coverage baseline (node 20)` — separate coverage workflow, with machine-readable artifacts.
4. Prefer one independent human approval for sensitive changes. A sole maintainer cannot approve their own PR. If no independent reviewer is available, disclose that limitation, retain PR plus mandatory checks, and establish a narrowly scoped documented emergency bypass rather than silently claiming independent review.
5. Set bypass permissions narrowly. Do not give ordinary coding agents, automation tokens or all contributors an unrestricted bypass. Record exceptional bypass use with commit SHA, reason, approving person, rollback plan and subsequent independent review. Check effective permissions for GitHub Apps separately.

GitHub may expose controls under classic **Branches** instead of **Rulesets** depending on repository/account settings. Use the equivalent enforceable controls and do not enable a required context until that check has appeared on a recent relevant PR.

## Protect version tags

Create a separate **tag ruleset**, target `v*`, and restrict updates/deletions and unauthorized creation. Do not allow routine tag rewriting. A tag ruleset does not prove a release passed CI: `release gate (all required checks)` is evaluated **after tag push**. It is not a replacement for a protected publishing workflow or deliberate release approval. See [CI/release readiness](CI_RELEASE.md).

## Verify effective enforcement

Use a **non-admin test contributor** on a disposable clone or a separate test repository configured with equivalent rules. Confirm that (a) direct push to a targeted branch is rejected, (b) force push/deletion is rejected, (c) a PR with a deliberately failed or cancelled required check cannot merge, (d) passing required checks with the configured review policy can merge, and (e) rewriting/deleting a disposable protected tag is denied. Record screenshots or check URLs and effective actor permissions. Avoid probing production tag protections by altering an actual release tag.

Check explicitly that a tag validation cannot mark a release ready when any matrix job fails, skips or cancels. The branch gate and tag gate both compare prerequisite results to the literal `success`.

## Recovery for a sole maintainer

1. If rules prevent emergency hotfixes, attempt the normal PR/review/CI path first; never bypass merely to save time.
2. For a genuine incident, document the affected SHA, severity, which restriction must be relaxed, expiration/re-enable plan, and rollback.
3. Use an authorized administrator bypass *only if configured and available*. Otherwise temporarily adjust the relevant ruleset through GitHub settings, narrowly and with an auditable change record. Never disable protections permanently.
4. Apply the minimal fix, restore the original active ruleset settings, and verify with a non-admin test. Request a follow-up independent review and append evidence to the incident issue/PR.

**Acceptance remains open** until settings are active and non-admin failure-mode tests actually pass; CI documentation alone is not enforcement.
