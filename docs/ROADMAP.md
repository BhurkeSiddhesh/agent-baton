# Agent Baton engineering roadmap

This index links the **88 individually tracked engineering issues** created from the October 13, 2026 architecture review. Each issue includes implementation checklists, acceptance criteria, likely code areas and prerequisite task IDs.

**Status:** 88 tracked issues; **BAT-001, BAT-002 and BAT-003 completed** in [CI stabilization PR #90](https://github.com/BhurkeSiddhesh/agent-baton/pull/90) (all 13 GitHub Actions jobs passed on `main` on October 13, 2026). Other items remain proposed unless their GitHub issue is closed. **Prioritization:** P0 = correctness/release blocker; P1 = core capability; P2 = usability/scale; P3 = optional provider expansion. M1–M5 milestones in issue bodies are *planning phases*, not configured GitHub Milestone objects.

**How to execute this roadmap:** Work through release stabilization and security before enabling unattended execution. The existing CLI coordinates workers, but its adapters do not automatically start coding-agent sessions. See the [README feature walkthrough](../README.md#from-a-feature-request-to-merged-code-who-orchestrates-and-how-do-agents-pick-up-work).

## 01 — Release stabilization and tests

Restore a green supported-platform CI matrix, safe installation and reproducible releases.

| Issue | Priority | Work item |
|---|---|---|
| [BAT-001](https://github.com/BhurkeSiddhesh/agent-baton/issues/1) | P0 · Done | Fix Windows Git/path test failures |
| [BAT-002](https://github.com/BhurkeSiddhesh/agent-baton/issues/2) | P0 · Done | Repair Node 18 ESM command-discovery failures |
| [BAT-003](https://github.com/BhurkeSiddhesh/agent-baton/issues/3) | P0 · Done | Make generated command documentation deterministic |
| [BAT-004](https://github.com/BhurkeSiddhesh/agent-baton/issues/4) | P0 | Build release-quality CI gates |
| [BAT-005](https://github.com/BhurkeSiddhesh/agent-baton/issues/5) | P0 | Protect main and release branches |
| [BAT-006](https://github.com/BhurkeSiddhesh/agent-baton/issues/6) | P0 | Define supported OS, Git and Node versions |
| [BAT-007](https://github.com/BhurkeSiddhesh/agent-baton/issues/7) | P1 | Add measurable test coverage and regression policy |
| [BAT-008](https://github.com/BhurkeSiddhesh/agent-baton/issues/8) | P0 | Make install/upgrade/uninstall transactional and non-destructive |
| [BAT-009](https://github.com/BhurkeSiddhesh/agent-baton/issues/9) | P1 | Make tagged releases reproducible and independently installable |

## 02 — Security and trust

Clarify trust boundaries, restrict execution, protect hosted workflows and require appropriate authorization.

| Issue | Priority | Work item |
|---|---|---|
| [BAT-010](https://github.com/BhurkeSiddhesh/agent-baton/issues/10) | P0 | Write explicit multi-agent execution threat model |
| [BAT-011](https://github.com/BhurkeSiddhesh/agent-baton/issues/11) | P0 | Harden command launch against shell injection |
| [BAT-012](https://github.com/BhurkeSiddhesh/agent-baton/issues/12) | P1 | Enforce least-privilege execution profiles |
| [BAT-013](https://github.com/BhurkeSiddhesh/agent-baton/issues/13) | P1 | Add execution identity provenance and session tracking |
| [BAT-014](https://github.com/BhurkeSiddhesh/agent-baton/issues/14) | P1 | Bind merge approvals to trusted CI and review policies |
| [BAT-015](https://github.com/BhurkeSiddhesh/agent-baton/issues/15) | P1 | Harden hook guard and uncover bypass paths |
| [BAT-016](https://github.com/BhurkeSiddhesh/agent-baton/issues/16) | P1 | Strengthen protected path and configuration policies |
| [BAT-017](https://github.com/BhurkeSiddhesh/agent-baton/issues/17) | P1 | Expand secret scanning and redact sensitive logs |
| [BAT-018](https://github.com/BhurkeSiddhesh/agent-baton/issues/18) | P1 | Harden generated GitHub Actions permissions and triggers |
| [BAT-019](https://github.com/BhurkeSiddhesh/agent-baton/issues/19) | P1 | Implement risk-tiered human approval gates |
| [BAT-020](https://github.com/BhurkeSiddhesh/agent-baton/issues/20) | P1 | Add adversarial prompt-injection test suite |
| [BAT-021](https://github.com/BhurkeSiddhesh/agent-baton/issues/21) | P1 | Establish mandatory security regression and disclosure tests |

## 03 — Ledger and distributed correctness

Make claims, leases, event replay and recovery reliable across independent processes and clones.

| Issue | Priority | Work item |
|---|---|---|
| [BAT-022](https://github.com/BhurkeSiddhesh/agent-baton/issues/22) | P1 | Version and validate all ledger event schemas |
| [BAT-023](https://github.com/BhurkeSiddhesh/agent-baton/issues/23) | P1 | Define deterministic cross-clone event ordering |
| [BAT-024](https://github.com/BhurkeSiddhesh/agent-baton/issues/24) | P0 | Prevent conflicting simultaneous cloud packet claims |
| [BAT-025](https://github.com/BhurkeSiddhesh/agent-baton/issues/25) | P1 | Use fencing tokens and safer lease renewal |
| [BAT-026](https://github.com/BhurkeSiddhesh/agent-baton/issues/26) | P1 | Stress-test lock acquisition and stale-lock recovery |
| [BAT-027](https://github.com/BhurkeSiddhesh/agent-baton/issues/27) | P1 | Make multi-event transitions crash-safe and idempotent |
| [BAT-028](https://github.com/BhurkeSiddhesh/agent-baton/issues/28) | P1 | Design ledger reconciliation for diverged clones |
| [BAT-029](https://github.com/BhurkeSiddhesh/agent-baton/issues/29) | P1 | Verify event integrity before sensitive replay |
| [BAT-030](https://github.com/BhurkeSiddhesh/agent-baton/issues/30) | P2 | Benchmark replay and introduce optional state snapshots |
| [BAT-031](https://github.com/BhurkeSiddhesh/agent-baton/issues/31) | P2 | Introduce safe ledger retention and archival |
| [BAT-032](https://github.com/BhurkeSiddhesh/agent-baton/issues/32) | P1 | Recover stale agents without losing their work |
| [BAT-033](https://github.com/BhurkeSiddhesh/agent-baton/issues/33) | P1 | Add distributed claim and lifecycle stress tests |
| [BAT-034](https://github.com/BhurkeSiddhesh/agent-baton/issues/34) | P2 | Test ledger backup, restore and schema migration |

## 04 — Autonomous agent execution

Introduce an optional scheduler, runner interfaces and supervised build/review lifecycle.

| Issue | Priority | Work item |
|---|---|---|
| [BAT-035](https://github.com/BhurkeSiddhesh/agent-baton/issues/35) | P1 | Define a stable pluggable agent runner interface |
| [BAT-036](https://github.com/BhurkeSiddhesh/agent-baton/issues/36) | P1 | Implement supervised Claude Code and Codex CLI runners |
| [BAT-037](https://github.com/BhurkeSiddhesh/agent-baton/issues/37) | P1 | Create per-packet isolated Git worktrees automatically |
| [BAT-038](https://github.com/BhurkeSiddhesh/agent-baton/issues/38) | P1 | Build optional orchestration scheduler loop |
| [BAT-039](https://github.com/BhurkeSiddhesh/agent-baton/issues/39) | P1 | Automate worker begin-build-verify-submit lifecycle |
| [BAT-040](https://github.com/BhurkeSiddhesh/agent-baton/issues/40) | P1 | Launch independent reviewer sessions and record evidence |
| [BAT-041](https://github.com/BhurkeSiddhesh/agent-baton/issues/41) | P1 | Add automatic heartbeats while runners remain healthy |
| [BAT-042](https://github.com/BhurkeSiddhesh/agent-baton/issues/42) | P1 | Introduce retry, backoff and escalation policies |
| [BAT-043](https://github.com/BhurkeSiddhesh/agent-baton/issues/43) | P1 | Enforce per-task token, time and monetary budgets |
| [BAT-044](https://github.com/BhurkeSiddhesh/agent-baton/issues/44) | P1 | Support pause, resume and cancellation of agent workflows |
| [BAT-045](https://github.com/BhurkeSiddhesh/agent-baton/issues/45) | P1 | Bound concurrency and resource usage |
| [BAT-046](https://github.com/BhurkeSiddhesh/agent-baton/issues/46) | P1 | Design optional process sandbox backend |
| [BAT-047](https://github.com/BhurkeSiddhesh/agent-baton/issues/47) | P1 | Connect cloud dispatch to tracked remote execution |
| [BAT-048](https://github.com/BhurkeSiddhesh/agent-baton/issues/48) | P1 | Ship reproducible multi-agent end-to-end demo |

## 05 — Planning, review and Git

Improve plans, packet ownership, review evidence and safe integration.

| Issue | Priority | Work item |
|---|---|---|
| [BAT-049](https://github.com/BhurkeSiddhesh/agent-baton/issues/49) | P1 | Improve AI-generated plan quality and approval gates |
| [BAT-050](https://github.com/BhurkeSiddhesh/agent-baton/issues/50) | P2 | Detect oversized and undersized work packets |
| [BAT-051](https://github.com/BhurkeSiddhesh/agent-baton/issues/51) | P1 | Model file ownership and shared interfaces more precisely |
| [BAT-052](https://github.com/BhurkeSiddhesh/agent-baton/issues/52) | P1 | Define versioned interface contracts between packets |
| [BAT-053](https://github.com/BhurkeSiddhesh/agent-baton/issues/53) | P1 | Specify hard versus soft dependency enforcement |
| [BAT-054](https://github.com/BhurkeSiddhesh/agent-baton/issues/54) | P2 | Improve explainable deterministic agent assignment |
| [BAT-055](https://github.com/BhurkeSiddhesh/agent-baton/issues/55) | P1 | Add configurable independent review policies |
| [BAT-056](https://github.com/BhurkeSiddhesh/agent-baton/issues/56) | P1 | Attach evidence to every completion criterion |
| [BAT-057](https://github.com/BhurkeSiddhesh/agent-baton/issues/57) | P1 | Harden branch and worktree lifecycle |
| [BAT-058](https://github.com/BhurkeSiddhesh/agent-baton/issues/58) | P1 | Introduce Git-safe serial merge queue |
| [BAT-059](https://github.com/BhurkeSiddhesh/agent-baton/issues/59) | P1 | Connect release gates to merged work and CI |
| [BAT-060](https://github.com/BhurkeSiddhesh/agent-baton/issues/60) | P2 | Strengthen findings across rework and handoffs |
| [BAT-061](https://github.com/BhurkeSiddhesh/agent-baton/issues/61) | P2 | Make agent scoreboards statistically interpretable |

## 06 — Developer experience and observability

Improve setup, diagnostics, metrics, structured logs and optional dashboards.

| Issue | Priority | Work item |
|---|---|---|
| [BAT-062](https://github.com/BhurkeSiddhesh/agent-baton/issues/62) | P1 | Build a guided first-run onboarding experience |
| [BAT-063](https://github.com/BhurkeSiddhesh/agent-baton/issues/63) | P1 | Expand baton doctor for runtime and cloud readiness |
| [BAT-064](https://github.com/BhurkeSiddhesh/agent-baton/issues/64) | P1 | Version stable machine-readable CLI output schemas |
| [BAT-065](https://github.com/BhurkeSiddhesh/agent-baton/issues/65) | P1 | Introduce structured, redacted execution logs |
| [BAT-066](https://github.com/BhurkeSiddhesh/agent-baton/issues/66) | P2 | Design optional interactive terminal dashboard |
| [BAT-067](https://github.com/BhurkeSiddhesh/agent-baton/issues/67) | P2 | Create optional read-only web dashboard |
| [BAT-068](https://github.com/BhurkeSiddhesh/agent-baton/issues/68) | P1 | Export operational performance metrics |
| [BAT-069](https://github.com/BhurkeSiddhesh/agent-baton/issues/69) | P2 | Add opt-in actionable notifications |
| [BAT-070](https://github.com/BhurkeSiddhesh/agent-baton/issues/70) | P2 | Standardize CLI options, help and dry-run behavior |

## 07 — Interoperability and performance

Test agent adapters and integrations, then validate performance and multi-agent value.

| Issue | Priority | Work item |
|---|---|---|
| [BAT-071](https://github.com/BhurkeSiddhesh/agent-baton/issues/71) | P1 | Publish tested capability matrix for all agent adapters |
| [BAT-072](https://github.com/BhurkeSiddhesh/agent-baton/issues/72) | P2 | Create versioned custom-agent extension API |
| [BAT-073](https://github.com/BhurkeSiddhesh/agent-baton/issues/73) | P2 | Prototype an optional MCP server integration |
| [BAT-074](https://github.com/BhurkeSiddhesh/agent-baton/issues/74) | P1 | Synchronize GitHub issues, PRs and checks with packets |
| [BAT-075](https://github.com/BhurkeSiddhesh/agent-baton/issues/75) | P3 | Design provider-neutral Git hosting integrations |
| [BAT-076](https://github.com/BhurkeSiddhesh/agent-baton/issues/76) | P2 | Add large-ledger replay and append benchmarks |
| [BAT-077](https://github.com/BhurkeSiddhesh/agent-baton/issues/77) | P2 | Benchmark scheduler throughput and fairness |
| [BAT-078](https://github.com/BhurkeSiddhesh/agent-baton/issues/78) | P1 | Compare single-agent and Baton multi-agent productivity |
| [BAT-079](https://github.com/BhurkeSiddhesh/agent-baton/issues/79) | P1 | Preserve zero-dependency offline core and package footprint |

## 08 — Product readiness and distribution

Publish tested examples, package distribution, governance and success metrics.

| Issue | Priority | Work item |
|---|---|---|
| [BAT-080](https://github.com/BhurkeSiddhesh/agent-baton/issues/80) | P1 | Publish and validate installable npm distribution |
| [BAT-081](https://github.com/BhurkeSiddhesh/agent-baton/issues/81) | P1 | Reorganize docs around runnable end-to-end workflows |
| [BAT-082](https://github.com/BhurkeSiddhesh/agent-baton/issues/82) | P1 | Ship runnable Node and Python integration examples |
| [BAT-083](https://github.com/BhurkeSiddhesh/agent-baton/issues/83) | P2 | Sharpen README positioning and capability boundaries |
| [BAT-084](https://github.com/BhurkeSiddhesh/agent-baton/issues/84) | P2 | Document governance and compatibility policy |
| [BAT-085](https://github.com/BhurkeSiddhesh/agent-baton/issues/85) | P1 | Organize roadmap issues and PR templates |
| [BAT-086](https://github.com/BhurkeSiddhesh/agent-baton/issues/86) | P2 | Audit vendored templates and third-party license obligations |
| [BAT-087](https://github.com/BhurkeSiddhesh/agent-baton/issues/87) | P1 | Establish alpha/beta/stable release gates |
| [BAT-088](https://github.com/BhurkeSiddhesh/agent-baton/issues/88) | P2 | Measure real-world adoption and engineering outcomes |

## Release sequencing

1. **M1 — Stable CLI:** Initial Windows, Node 18 and generated-doc failures are resolved (BAT-001–003); continue security hardening, branch protection, installer safety and release gates.
2. **M2 — Trust + coordination:** Establish stronger identity policies and correct distributed claims, leases and replay.
3. **M3 — Autonomous runner:** Implement optional process supervisors, worktree isolation, concurrency and end-to-end demo.
4. **M4 — Integrations:** Harden GitHub handoffs, PR review, merge queue and interface compatibility.
5. **M5 — Scale and adoption:** Polish tooling, benchmarks, docs, publication and additional optional integrations.

**Standard definition of done:** reviewed PR, regression tests including failure paths, passing relevant CI, evidence matching acceptance criteria, and updated user-facing documentation where behavior changes.
