[Agent Baton](../README.md) / [Docs](../README.md#documentation) / CI and releases

# Quality gates and release readiness

The [CI workflow](../.github/workflows/ci.yml) runs on pull requests, pushes to `main`, and version tags matching `v*`. It does **not** publish npm packages or GitHub releases. A passing tag validation is a prerequisite to publishing, not proof that publishing is safe.

| Check | Environment | Why it is independent |
|---|---|---|
| Full regression test matrix | Ubuntu, Windows, macOS × Node 18, 20, 22 | Exposes platform-specific command and filesystem failures |
| Unit tests | Ubuntu / Node 20 | Library-level error isolation |
| CLI integration and E2E | Ubuntu / Node 20 | Packet lifecycle, project installation and command behavior |
| Security regressions | Ubuntu, Windows, macOS / Node 20 | Hook guard, credential patterns and documented trust boundaries |
| Install/doctor smoke | Ubuntu, Windows, macOS / Node 20 | Clean scratch-repo initialization and uninstall |
| Docs | Ubuntu / Node 20 | Relative links, anchor integrity, generated CLI reference parity |
| Package integrity | Ubuntu / Node 20 | Expected archive entries, excluded secrets/dev state, offline tarball install |
| Release gate | Version-tag validation only | Requires every other job to finish with `success`; cancellation/skip/failure never counts as ready |

Failed full and security suites upload their captured logs as artifacts (7-day retention). Matrix jobs use `fail-fast: false` to preserve diagnostics on all tested platforms. The manifest from `npm pack` is retained; the archive is smoke-installed from a local path with `--offline` and no install scripts.

## Reproduce locally

```bash
npm test
node --test tests/lib-*.test.js
node --test tests/cmd-*.test.js tests/e2e.test.js
node --test tests/cmd-exec-guard.test.js tests/lib-secrets.test.js tests/security-model-docs.test.js
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
4. Inspect that tag's **release gate (all required checks)** job, which fails when any prerequisite is not successful.
5. Only then, from a separately approved release workflow or manually, publish the package and verify a clean installation. Do not place write tokens in untrusted pull-request jobs.

**Limits:** The gate verifies the workflow results for the tag but does not authenticate the tag pusher, sign artifacts, create branch protections, or publish a release. A separate protected publisher is required for automatic releases.

## Enforcing branch and tag rules

See the [branch and tag protection runbook](BRANCH_PROTECTION.md) for the exact required status contexts, GitHub ruleset steps, failure-mode tests and sole-maintainer recovery process. GitHub rules must be enabled separately; CI jobs do not activate branch protection.
