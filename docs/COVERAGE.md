[Agent Baton](../README.md) / [Docs](../README.md#documentation) / Coverage policy

# Regression coverage policy

Agent Baton uses Node's built-in coverage collector; no production dependency is introduced. The [coverage workflow](../.github/workflows/coverage.yml) runs the **entire** test suite on Ubuntu / Node 20 for pull requests and `main` and publishes three artifacts: human-readable coverage output, aggregate percentages in JSON, and raw V8 coverage files.

## Reproduce the baseline

```bash
npm run test:coverage
```

On CI, [parse-coverage.mjs](../.github/scripts/parse-coverage.mjs) converts the Node "all files" line to percentages for lines, branches and functions. The first successful `main` run after the workflow is merged is the **baseline**. Report the measured figures and link the run in release notes rather than asserting unmeasured percentages.

**No arbitrary thresholds are enforced initially.** After at least three healthy main-branch runs, maintainers should compare the actual per-file and aggregate measurements, exclude fixture-only noise, and set realistic regression thresholds in a separate reviewable PR. Until then, code reviews enforce meaningful new tests rather than a fabricated percentage.

Priority regression surfaces are: engine state transitions and reviewer separation; lease/lock recovery; ownership/protected paths; installer rollback/idempotency; verify/merge invariants and dangerous shell dispatch. Every fixed defect must carry a regression test, ideally including an unsafe/negative path and a recovery path. A percentage gain alone is not proof of behavioral safety.

Coverage figures are diagnostics rather than an attestation. CI uploads only the small summary (`coverage-summary.txt`/`.json`, 3-day retention); raw V8 coverage dumps are several MB per run, so they are not collected on CI. To inspect them, run `NODE_V8_COVERAGE=coverage/v8 npm run test:coverage` locally. Keep raw coverage files out of distributed packages; scripts run offline.
