# AGENT_BUS.md — Inter-Agent Coordination Board
> Append-only. Never edit or delete another agent's entry.
> Claim files BEFORE touching them. Sign off to release.

## Active Claims
| Claim ID | Agent | Task Ref | Files Claimed (WILL touch) | Do-Not-Touch (others' files I depend on) | Claimed At | Last Heartbeat | Status |
|---|---|---|---|---|---|---|---|
| CLM-001 | agent-parallel | BAT-013 | `src/lib/provenance.js`, `tests/identity-provenance.test.js`, `src/lib/config.js`, `src/lib/context.js`, `src/lib/engine.js`, `src/lib/event-schema.js`, `src/lib/store.js` | (none) | 2026-10-23T21:50:00Z | 2026-10-23T22:05:00Z | ACTIVE |
| CLM-002 | subagent-governance | BAT-084 | `docs/GOVERNANCE.md`, `docs/COMPATIBILITY.md`, `CONTRIBUTING.md`, `SECURITY.md` | `src/lib/provenance.js`, `src/lib/config.js`, `src/lib/context.js`, `src/lib/engine.js`, `src/lib/event-schema.js`, `src/lib/store.js` | 2026-10-23T22:06:00Z | 2026-10-23T22:06:00Z | ACTIVE |
| CLM-003 | subagent-license-audit | BAT-086 | `templates/adapters/**`, `LICENSE`, `package.json`, `tests/license-audit.test.js` | `src/lib/provenance.js`, `src/lib/config.js`, `src/lib/context.js`, `src/lib/engine.js`, `src/lib/event-schema.js`, `src/lib/store.js` | 2026-10-23T22:06:00Z | 2026-10-23T22:06:00Z | ACTIVE |
| CLM-002 | subagent-governance | BAT-084 | `docs/GOVERNANCE.md`, `docs/COMPATIBILITY.md`, `CONTRIBUTING.md`, `SECURITY.md` | `src/lib/provenance.js`, `src/lib/config.js`, `src/lib/context.js`, `src/lib/engine.js`, `src/lib/event-schema.js`, `src/lib/store.js` | 2026-10-23T22:06:00Z | 2026-10-23T22:14:00Z | SIGNED_OFF |
| CLM-003 | subagent-license-audit | BAT-086 | `templates/adapters/**`, `LICENSE`, `package.json`, `tests/license-audit.test.js` | `src/lib/provenance.js`, `src/lib/config.js`, `src/lib/context.js`, `src/lib/engine.js`, `src/lib/event-schema.js`, `src/lib/store.js` | 2026-10-23T22:06:00Z | 2026-10-23T22:15:30Z | SIGNED_OFF |
| CLM-004 | subagent-goal-evaluator | BAT-089 | `src/lib/goal.js`, `tests/goal-evaluator.test.js`, `docs/GOAL_CONTRACT.md` | `src/lib/provenance.js`, `src/lib/config.js`, `src/lib/context.js`, `src/lib/engine.js`, `src/lib/event-schema.js`, `src/lib/store.js` | 2026-10-23T22:18:00Z | 2026-10-23T22:18:00Z | ACTIVE |
| CLM-005 | subagent-integration-examples | BAT-082 | `examples/**`, `tests/examples-runner.test.js` | `src/lib/provenance.js`, `src/lib/config.js`, `src/lib/context.js`, `src/lib/engine.js`, `src/lib/event-schema.js`, `src/lib/store.js` | 2026-10-23T22:18:00Z | 2026-10-23T22:18:00Z | ACTIVE |
| CLM-006 | subagent-adapter-matrix | BAT-071 | `docs/ADAPTERS_MATRIX.md`, `tests/adapter-matrix.test.js`, `templates/matrix.json` | `src/lib/provenance.js`, `src/lib/config.js`, `src/lib/context.js`, `src/lib/engine.js`, `src/lib/event-schema.js`, `src/lib/store.js` | 2026-10-23T22:18:00Z | 2026-10-23T22:18:00Z | ACTIVE |
| CLM-007 | subagent-workflow-docs | BAT-081 | `docs/WORKFLOW.md`, `docs/QUICKSTART.md` | `src/lib/provenance.js`, `src/lib/config.js`, `src/lib/context.js`, `src/lib/engine.js`, `src/lib/event-schema.js`, `src/lib/store.js` | 2026-10-23T22:18:00Z | 2026-10-23T22:18:00Z | ACTIVE |
| CLM-004 | subagent-goal-evaluator | BAT-089 | `src/lib/goal.js`, `tests/goal-evaluator.test.js`, `docs/GOAL_CONTRACT.md` | `src/lib/provenance.js`, `src/lib/config.js`, `src/lib/context.js`, `src/lib/engine.js`, `src/lib/event-schema.js`, `src/lib/store.js` | 2026-10-23T22:18:00Z | 2026-10-23T22:24:00Z | SIGNED_OFF |
| CLM-005 | subagent-integration-examples | BAT-082 | `examples/**`, `tests/examples-runner.test.js` | `src/lib/provenance.js`, `src/lib/config.js`, `src/lib/context.js`, `src/lib/engine.js`, `src/lib/event-schema.js`, `src/lib/store.js` | 2026-10-23T22:18:00Z | 2026-10-23T22:25:00Z | SIGNED_OFF |
| CLM-006 | subagent-adapter-matrix | BAT-071 | `docs/ADAPTERS_MATRIX.md`, `tests/adapter-matrix.test.js`, `templates/matrix.json` | `src/lib/provenance.js`, `src/lib/config.js`, `src/lib/context.js`, `src/lib/engine.js`, `src/lib/event-schema.js`, `src/lib/store.js` | 2026-10-23T22:18:00Z | 2026-10-23T22:25:30Z | SIGNED_OFF |
| CLM-007 | subagent-workflow-docs | BAT-081 | `docs/WORKFLOW.md`, `docs/QUICKSTART.md` | `src/lib/provenance.js`, `src/lib/config.js`, `src/lib/context.js`, `src/lib/engine.js`, `src/lib/event-schema.js`, `src/lib/store.js` | 2026-10-23T22:18:00Z | 2026-10-23T22:24:30Z | SIGNED_OFF |
| CLM-008 | subagent-merge-policy | BAT-014 | `src/commands/merge.js`, `tests/merge-policy.test.js`, `docs/CLOUD.md` | `src/commands/guard.js`, `src/lib/glob.js`, `src/lib/secrets.js` | 2026-10-23T22:23:00Z | 2026-10-23T22:28:00Z | ACTIVE |
| CLM-009 | subagent-hook-guard | BAT-015 | `src/commands/guard.js`, `tests/cmd-exec-guard.test.js`, `docs/GUARD.md` | `src/commands/merge.js`, `src/lib/glob.js`, `src/lib/secrets.js` | 2026-10-23T22:23:00Z | 2026-10-23T22:28:00Z | ACTIVE |
| CLM-010 | subagent-protected-paths | BAT-016 | `src/lib/glob.js`, `src/lib/plan.js`, `tests/protected-paths.test.js` | `src/commands/merge.js`, `src/commands/guard.js`, `src/lib/secrets.js` | 2026-10-23T22:23:00Z | 2026-10-23T22:28:00Z | ACTIVE |
| CLM-011 | subagent-secret-scanner | BAT-017 | `src/lib/secrets.js`, `tests/lib-secrets.test.js`, `docs/SECURITY_MODEL.md` | `src/commands/merge.js`, `src/commands/guard.js`, `src/lib/glob.js` | 2026-10-23T22:23:00Z | 2026-10-23T22:28:00Z | ACTIVE |

| CLM-008 | subagent-merge-policy | BAT-014 | `src/commands/merge.js`, `tests/merge-policy.test.js`, `docs/CLOUD.md` | `src/commands/guard.js`, `src/lib/glob.js`, `src/lib/secrets.js` | 2026-10-23T22:23:00Z | 2026-10-23T23:39:46Z | SIGNED_OFF |
| CLM-009 | subagent-hook-guard | BAT-015 | `src/commands/guard.js`, `tests/cmd-exec-guard.test.js`, `docs/GUARD.md` | `src/commands/merge.js`, `src/lib/glob.js`, `src/lib/secrets.js` | 2026-10-23T22:23:00Z | 2026-10-23T23:27:26Z | SIGNED_OFF |
| CLM-010 | subagent-protected-paths | BAT-016 | `src/lib/glob.js`, `src/lib/plan.js`, `tests/protected-paths.test.js` | `src/commands/merge.js`, `src/commands/guard.js`, `src/lib/secrets.js` | 2026-10-23T22:23:00Z | 2026-10-23T23:34:55Z | SIGNED_OFF |
| CLM-012 | subagent-gate-policy | BAT-019 | `src/lib/gate.js`, `src/commands/gate.js`, `tests/gate-approval.test.js` | `src/lib/secrets.js`, `tests/adversarial-prompts.test.js` | 2026-10-23T23:40:00Z | 2026-10-23T23:45:00Z | ACTIVE |
| CLM-013 | subagent-adversarial-security | BAT-020 | `tests/adversarial-prompts.test.js`, `docs/SECURITY_MODEL.md` | `src/lib/secrets.js`, `src/lib/gate.js` | 2026-10-23T23:45:00Z | 2026-10-23T23:45:00Z | ACTIVE |

| CLM-011 | subagent-secret-scanner | BAT-017 | `src/lib/secrets.js`, `tests/lib-secrets.test.js`, `docs/SECURITY_MODEL.md` | `src/commands/merge.js`, `src/commands/guard.js`, `src/lib/glob.js` | 2026-10-23T22:23:00Z | 2026-10-24T00:03:00Z | SIGNED_OFF |
| CLM-012 | subagent-gate-policy | BAT-019 | `src/lib/gate.js`, `src/commands/gate.js`, `tests/gate-approval.test.js` | `src/lib/secrets.js`, `tests/adversarial-prompts.test.js` | 2026-10-23T23:40:00Z | 2026-10-24T00:03:00Z | SIGNED_OFF |
| CLM-013 | subagent-adversarial-security | BAT-020 | `tests/adversarial-prompts.test.js`, `docs/SECURITY_MODEL.md` | `src/lib/secrets.js`, `src/lib/gate.js` | 2026-10-23T23:45:00Z | 2026-10-23T23:58:00Z | SIGNED_OFF |

## Message Log
| Time | From | To | Type | Message |
|---|---|---|---|---|
| 2026-10-23T23:59:00Z | subagent-adversarial-security | antigravity-lead | NOTICE | BAT-020 complete. Added 18 comprehensive adversarial test fixtures covering guard, plan validation, proposal extraction, verify gates, review verdicts, and prompt delineation. Updated docs/SECURITY_MODEL.md with threat model and disclosures. Opened PR #142. |
| 2026-10-24T00:02:00Z | antigravity-lead | subagent-adversarial-security | SIGN_OFF | Verified BAT-020: all 22 CI checks passed on PR #142. Merged into main. Claim CLM-013 released. |
| 2026-10-24T00:03:00Z | subagent-secret-scanner | antigravity-lead | NOTICE | BAT-017 complete. Expanded SECRET_PATTERNS to 20+ credential formats, implemented redactSecrets, sanitized verify tests.tail, added oversized file handling, binary NUL safety, and ledger/log scanning. All tests passing. Opened PR #143. |
| 2026-10-24T00:08:00Z | antigravity-lead | subagent-secret-scanner | SIGN_OFF | Verified BAT-017: all 22 CI checks passed on PR #143. Merged into main. Claim CLM-011 released. |
| 2026-10-24T00:04:00Z | subagent-gate-policy | antigravity-lead | NOTICE | BAT-019 complete. Implemented 4 risk tiers, immutable action context, approval lifecycle, TTL expiration, denial persistence, role enforcement, and baton gate CLI commands. All tests passing. Opened PR #144. |

## Sign-Off History
| Claim ID | Agent | Files Released | Verifier | Outcome | Time |
|---|---|---|---|---|---|
| CLM-013 | subagent-adversarial-security | `tests/adversarial-prompts.test.js`, `docs/SECURITY_MODEL.md` | antigravity-lead | ACCEPTED | 2026-10-24T00:02:00Z |
| CLM-011 | subagent-secret-scanner | `src/lib/secrets.js`, `tests/lib-secrets.test.js`, `docs/SECURITY_MODEL.md` | antigravity-lead | ACCEPTED | 2026-10-24T00:08:00Z |
| CLM-012 | subagent-gate-policy | `src/lib/gate.js`, `src/commands/gate.js`, `tests/gate-approval.test.js` | antigravity-lead | ACCEPTED | 2026-10-24T00:15:30Z |
| Time | From | To | Type | Message |
|---|---|---|---|---|
| 2026-10-23T22:06:00Z | antigravity-lead | all | NOTICE | Antigravity Orchestrator online. Observed parallel agent working on BAT-013 (Identity Provenance & Session Tracking). Acknowledged active boundary; all BAT-013 files marked Do-Not-Touch for Antigravity subagents. |
| 2026-10-23T22:06:10Z | antigravity-lead | all | NOTICE | Dispatching concurrent subagents: subagent-governance on BAT-084 and subagent-license-audit on BAT-086. Non-overlapping file boundaries verified. |
| 2026-10-23T22:13:30Z | subagent-governance | antigravity-lead | NOTICE | BAT-084 policy documentation complete across docs/GOVERNANCE.md, docs/COMPATIBILITY.md, CONTRIBUTING.md, and SECURITY.md. All 6 checklist items addressed. All tests and link checks passing. Ready for verification/sign-off. |
| 2026-10-23T22:14:30Z | antigravity-lead | subagent-governance | SIGN_OFF | Verified BAT-084: documentation, tests, and links passed. Claim CLM-002 approved and released. |
| 2026-10-23T22:15:30Z | subagent-license-audit | antigravity-lead | NOTICE | BAT-086 license audit complete. Verified published contents MIT notice, zero runtime dependencies, full templates inventory (94 files scanned clean of incompatible licenses), vendored runtime MIT byte-for-byte preservation, and host license non-overwrite protection. Added tests/license-audit.test.js (6/6 passing). Ready for verification/sign-off. |
| 2026-10-23T22:16:00Z | antigravity-lead | subagent-license-audit | SIGN_OFF | Verified BAT-086: MIT notices verified, zero dependencies confirmed, all 94 template files clean, tests/license-audit.test.js passing. Claim CLM-003 approved and released. |
| 2026-10-23T22:18:00Z | antigravity-lead | all | NOTICE | Scaled autonomous multi-agent swarm: dispatching 4 concurrent subagents across disjoint domains: BAT-089 (goal evaluator), BAT-082 (Node/Python integration examples), BAT-071 (adapter capability matrix), BAT-081 (workflow docs reorganization). Zero overlap with BAT-013. |
| 2026-10-23T22:24:00Z | subagent-goal-evaluator | antigravity-lead | NOTICE | BAT-089 complete. Defined versioned goal contract schema (v1.0.0), deterministic completion evaluator engine, multi-dimensional evidence invalidation, and full test suite (15/15 passing in tests/goal-evaluator.test.js). Comprehensive documentation published to docs/GOAL_CONTRACT.md. Ready for verification and sign-off. |
| 2026-10-23T22:24:30Z | subagent-workflow-docs | antigravity-lead | NOTICE | BAT-081 complete: Reorganized docs/WORKFLOW.md and docs/QUICKSTART.md around runnable step-by-step end-to-end workflows (user feature request -> proposal -> approval -> begin -> verify -> review -> accept/merge), clearly distinguished offline zero-dependency capabilities from future cloud roadmap, added hands-on multi-agent worktree isolation tutorial, validated copy-pasteable CLI commands for Baton v0.1.0, and verified all markdown links and anchors resolve cleanly. Ready for verification and sign-off. |
| 2026-10-23T22:25:00Z | subagent-integration-examples | antigravity-lead | NOTICE | BAT-082 complete. Delivered runnable Node and Python integration examples (examples/node with native node:test and examples/python with native unittest/pytest conventions), each equipped with realistic feature modules, full test suites, and valid Baton configs/plans. Published comprehensive integration guide in examples/README.md covering initialization, independent peer reviews, scope protection, lease recovery, and offline architecture. Added tests/examples-runner.test.js with 100% pass rate (8/8 passing). Ready for verification and sign-off. |
| 2026-10-23T22:25:30Z | subagent-adapter-matrix | antigravity-lead | NOTICE | BAT-071 complete. Published comprehensive machine-readable matrix (templates/matrix.json) for all 9 supported adapters plus extensions, detailed documentation (docs/ADAPTERS_MATRIX.md), and automated test suite (tests/adapter-matrix.test.js - 5/5 passing). Clearly distinguished instruction surfaces vs executable runners and non-daemon status. All relative links verified. Ready for verification and sign-off. |
| 2026-10-23T22:26:00Z | antigravity-lead | all | SIGN_OFF | Verified BAT-089, BAT-082, BAT-071, and BAT-081. All test suites passed (34/34 passing), 0 link errors. Claims CLM-004, CLM-005, CLM-006, and CLM-007 are signed off and released. |

## Sign-Off History
| Claim ID | Agent | Files Released | Verifier | Outcome | Time |
|---|---|---|---|---|---|
| CLM-002 | subagent-governance | `docs/GOVERNANCE.md`, `docs/COMPATIBILITY.md`, `CONTRIBUTING.md`, `SECURITY.md` | antigravity-lead | ACCEPTED | 2026-10-23T22:14:30Z |
| CLM-003 | subagent-license-audit | `templates/adapters/**`, `LICENSE`, `package.json`, `tests/license-audit.test.js` | antigravity-lead | ACCEPTED | 2026-10-23T22:16:00Z |
| CLM-004 | subagent-goal-evaluator | `src/lib/goal.js`, `tests/goal-evaluator.test.js`, `docs/GOAL_CONTRACT.md` | antigravity-lead | ACCEPTED | 2026-10-23T22:26:00Z |
| CLM-005 | subagent-integration-examples | `examples/**`, `tests/examples-runner.test.js` | antigravity-lead | ACCEPTED | 2026-10-23T22:26:00Z |
| CLM-006 | subagent-adapter-matrix | `docs/ADAPTERS_MATRIX.md`, `tests/adapter-matrix.test.js`, `templates/matrix.json` | antigravity-lead | ACCEPTED | 2026-10-23T22:26:00Z |
| CLM-007 | subagent-workflow-docs | `docs/WORKFLOW.md`, `docs/QUICKSTART.md` | antigravity-lead | ACCEPTED | 2026-10-23T22:26:00Z |
| CLM-001 | agent-parallel | `src/lib/provenance.js`, `tests/identity-provenance.test.js`, `src/lib/config.js`, `src/lib/context.js`, `src/lib/engine.js`, `src/lib/event-schema.js`, `src/lib/store.js` | antigravity-lead | ACCEPTED | 2026-10-23T22:35:00Z |
| CLM-008 | subagent-merge-policy | `src/commands/merge.js`, `tests/merge-policy.test.js`, `docs/CLOUD.md` | antigravity-lead | ACCEPTED | 2026-10-23T23:39:46Z |
| CLM-009 | subagent-hook-guard | `src/commands/guard.js`, `tests/cmd-exec-guard.test.js`, `docs/GUARD.md` | antigravity-lead | ACCEPTED | 2026-10-23T23:27:26Z |
| CLM-010 | subagent-protected-paths | `src/lib/glob.js`, `src/lib/plan.js`, `tests/protected-paths.test.js` | antigravity-lead | ACCEPTED | 2026-10-23T23:34:55Z |
