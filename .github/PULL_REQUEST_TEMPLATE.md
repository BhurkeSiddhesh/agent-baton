## Related issue and objective

Closes #<!-- required: replace with the issue number when all acceptance criteria are met; otherwise use Refs #... -->

**Change:** <!-- what changed and why, in two or three sentences -->

## Acceptance criteria

- [ ] Relevant issue criteria are satisfied (link evidence for each; disclose any incomplete criteria)
- [ ] Tests cover success, negative/refusal, recovery and regression scenarios where applicable
- [ ] `npm test` and applicable CI jobs pass on supported platforms; link run(s) below

## Evidence

- **Local verification:** <!-- exact commands and concise output; do not mark green if not run -->
- **CI run:** <!-- URL; mark pending until finished -->
- **Reproduction before / after:** <!-- for a bug; otherwise N/A -->

## Compatibility and Rollback

<!-- CLI/JSON schemas, config, ledger, release/install compatibility; migration needed? How to recover? -->

## Security

<!-- New shells, prompts, tools, trust boundaries, permissions, secret handling, protected paths, dependencies? None with rationale. -->

## Review

- [ ] Changed command help and generated docs regenerated if applicable
- [ ] No dependency or network requirement introduced into the offline core (or explicitly justified)
- [ ] Installer changes remain non-destructive and are tested if applicable
- [ ] Security and identity assumptions are documented; Baton actor names are not authenticated approval
- [ ] Independent reviewer inspects diff, actual CI and issue criteria; no self-approval
- [ ] `CHANGELOG.md` updated under Unreleased or a rationale given

**Risk / reviewer focus:** <!-- concise explanation; include rollout/rollback owner -->
