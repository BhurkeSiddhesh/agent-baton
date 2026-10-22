[Agent Baton](../README.md) / [Docs](../README.md#documentation) / CI and releases

# Quality gates and release readiness

The [CI workflow](../.github/workflows/ci.yml) runs on pull requests, pushes to `main`, and version tags matching `v*`. It does **not** publish npm packages or GitHub releases. A successful tag run can produce a checksummed, independently installable **release candidate artifact**, but publication still requires a separate authorized decision.

| Check | Environment | Why it is independent |
|---|---|---|
| Full regression test matrix | Ubuntu, Windows, macOS × Node 18, 20, 22 | Exposes platform-specific command and filesystem failures |
| Unit tests | Ubuntu / Node 20 | Library-level error isolation |
| CLI integration and E2E | Ubuntu / Node 20 | Packet lifecycle, project installation and command behavior |
| Security regressions | Ubuntu, Windows, macOS / Node 20 | Hook guard, credential patterns and documented trust boundaries |
| Install/doctor smoke | Ubuntu, Windows, macOS / Node 20 | Clean scratch-repo initialization and uninstall |
| Docs | Ubuntu / Node 20 | Relative links, anchor integrity, generated CLI reference parity |
| Package integrity | Ubuntu / Node 20 | Archive validation, offline install, cold-start/footprint measurements and no-network CLI smoke |
| Release gate | Version-tag validation only | Requires all seven job groups to succeed **and** tag to equal `v` + package version; cancellation/skip/failure never counts as ready |
| Release candidate | Version tags, after release gate succeeds | Re-packs the tagged tree, validates the archive, computes SHA-256 and uploads an installable tarball without publishing |

Failed full and security suites upload their captured logs as artifacts (7-day retention). Matrix jobs use `fail-fast: false` to preserve diagnostics on all tested platforms. The manifest from `npm pack` is retained; the archive is smoke-installed from a local path with `--offline` and no install scripts.

## Reproduce locally

```bash
npm test
node --test tests/lib-*.test.js
node --test tests/cmd-*.test.js tests/e2e.test.js
node --test tests/cmd-exec-guard.test.js tests/lib-secrets.test.js tests/lib-lock.test.js tests/security-model-docs.test.js
node .github/scripts/check-links.mjs
node .github/scripts/gen-commands.mjs
git diff --exit-code docs/COMMANDS.md
npm pack --json > pack.json
node .github/scripts/validate-package.mjs pack.json
```

The `node --test` wildcard commands above assume shell glob expansion (as used by the CI runner). Never publish an archive merely because a local run passed. Record the exact commit SHA, CI URL and a successful release-gate result.

## Release handoff

1. Make a PR referencing the tracked issue and include verified evidence.
2. Require GitHub branch rules for the relevant full test, security, docs and package check contexts. These rules must be configured separately in repository settings; this workflow cannot impose them.
3. Merge reviewed code only after checks complete. Tag the reviewed commit `v<version>` only when the package version and changelog match.
4. Inspect that tag's **release gate (all required checks)** job. It fails when a prerequisite is not successful or the tag does not exactly match `package.json` version.
5. Download the **release candidate tarball (gated)** artifact from the same tag run. Independently verify `SHA256SUMS`, inspect `pack.json`, and install the tarball offline before approving publication.
6. Only then, from a separately approved release workflow or manually, publish the package and verify a clean installation. Never let a pull-request workflow publish packages. Do not place write tokens in untrusted pull-request jobs.

**Limits:** The gate verifies the workflow results for the tag but does not authenticate the tag pusher, sign artifacts, create branch protections, or publish a release. A separate protected publisher is required for automatic releases.

## Enforcing branch and tag rules

See the [branch and tag protection runbook](BRANCH_PROTECTION.md) for the exact required status contexts, GitHub ruleset steps, failure-mode tests and sole-maintainer recovery process. GitHub rules must be enabled separately; CI jobs do not activate branch protection.

### Failure-mode evidence

`tests/ci-release-gates.test.js` tests failure/cancellation/skip/pending/missing status results for **every** required job, verifies tag/version mismatches, and tests exact package-checksum metadata. These are synthetic negative cases: tag-triggered release candidate creation must still be verified on an authorized version-tag event. A PR run does not simulate a published tag. No auto-publisher or GitHub release is created by this workflow.

## Offline core footprint and network budget (BAT-079)

The current core has zero required runtime dependencies and does not bundle a daemon, container service, MCP server or dashboard. Optional services must use separate distributions. The package validator enforces this boundary. The existing CI package lane installs the real tarball offline and runs initialization, doctor and check.

The package lane records the npm tarball's compressed bytes, unpacked bytes and file count plus five cold Node 20 CLI startup samples, with a p95. Conservative ceilings are 10 MiB compressed, 50 MiB unpacked and 3,000 ms p95 for baton version. These ceilings prevent accidental package inflation; they are not advertised customer benchmarks. The JSON report is retained in the package-manifest artifact.

A Node preload denies socket connections, HTTP, HTTPS, DNS and fetch during a CLI startup smoke. This tests Node-level network access only: it does not sandbox shell tools or authorized agent integrations. No remote provider or Docker is required for core installation. Compare the recorded metrics and investigate changes during every release.
