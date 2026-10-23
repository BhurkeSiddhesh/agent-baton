# Project DNA — Agent Baton

<!-- reconciliation:metadata
last_reconciled: 2026-10-23
baseline_commit: 2a24a7e7709033eb4fc2696333e556146a88e3f4
status: reconciled
-->

## Multi-Agent Coordination Law
- **Inter-Agent Bus**: All coordination, claims, heartbeats, and notices MUST go through `docs/AGENT_BUS.md`.
- **Claim Before Touch**: Never touch files claimed by another agent.
- **Current Active Work Boundary**:
  - `antigravity-lead` coordinates concurrent execution via specialized sub-agents with disjoint file claims.

## Tech Stack
- **Runtime**: Node.js >= 18 (ESM modules).
- **Core CLI**: Zero-runtime-dependency offline CLI (`bin/baton.js`, `src/`).
- **Storage**: Append-only event-sourced ledger (`.baton/state/` or git common directory).
- **Testing**: Built-in `node:test` runner (`npm test`).

## Structure
- `bin/`: CLI executable entry points.
- `src/lib/`: Core orchestrator engine, event schema, locking, ledger store, and context.
- `src/commands/`: Baton CLI subcommands (`plan`, `next`, `begin`, `verify`, `review`, `bus`, `worktrees`, `sync`, etc.).
- `templates/`: Agent adapter templates (Claude, Codex, Gemini, Antigravity, Copilot, Cursor).
- `docs/`: Canonical documentation and protocol specifications (`docs/AGENT_BUS.md`, `docs/task.md`, `docs/ARCHIVE.md`).
- `tests/`: Integration and unit test suite.

## Patterns & Constraints
- **Zero Runtime Dependencies**: The core CLI must remain standalone with no npm dependencies required for runtime execution.
- **Fail Closed**: Invariants, schema validation, and security policies fail closed upon violation.
- **Append-Only Ledger**: State is reconstructed deterministically from signed/validated historical events.
- **Worktree Isolation**: Parallel work packets run on distinct git worktrees and branches.

## Active Focus
- **Parallel Issue Execution**:
  - `BAT-021`: Establish mandatory security regression and disclosure tests (queued).
  - `BAT-030`: Benchmark replay and introduce optional state snapshots (queued).
  - `BAT-031`: Introduce safe ledger retention and archival (queued).
  - `BAT-033`: Add distributed claim and lifecycle stress tests (queued).
  - `BAT-013`: Execution identity provenance and session tracking (completed & verified).
  - `BAT-014`: Bind merge approvals to trusted verification and review policies (completed & verified).
  - `BAT-015`: Harden hook guard and uncover bypass paths (completed & verified).
  - `BAT-016`: Strengthen protected path policies and config immutability (completed & verified).
  - `BAT-017`: Expand secret scanning and redact sensitive logs (completed & verified).
  - `BAT-019`: Risk-tiered human approval gates (completed & verified).
  - `BAT-020`: Adversarial prompt-injection test suite (completed & verified).
  - `BAT-084`: Governance and compatibility policy (completed & verified).
  - `BAT-086`: Vendored template audit and license compliance (completed & verified).
  - `BAT-089`: Versioned goal contract & evidence evaluator engine (completed & verified).
  - `BAT-082`: Runnable Node and Python integration examples (completed & verified).
  - `BAT-071`: Tested capability matrix for all agent adapters (completed & verified).
  - `BAT-081`: Reorganized runnable end-to-end workflow documentation (completed & verified).

## Change Log
| Date | Change | Author |
|---|---|---|
| 2026-10-23 | Complete BAT-019 risk-tiered human approval gates with immutable action context | Gate Policy Engineer |
| 2026-10-23 | Complete BAT-017 expanded credential scanning and sensitive log redaction | Secret Scanner Hardener |
| 2026-10-23 | Complete BAT-020 adversarial prompt-injection test suite and threat disclosures | Adversarial Security Engineer |
| 2026-10-23 | Complete BAT-014 bind merge approvals to trusted CI and platform review policies | Merge Policy Engineer |
| 2026-10-23 | Complete BAT-016 strengthen protected path policies and configuration immutability | Protected Policy Engineer |
| 2026-10-23 | Complete BAT-015 harden hook guard against traversal, UNC, junctions, and alternate streams | Hook Guard Hardener |
| 2026-10-23 | Complete BAT-089 goal contract & deterministic evidence evaluator | Subagent Goal Evaluator |
| 2026-10-23 | Complete BAT-082 runnable Node & Python integration examples and guide | Subagent Integration Examples |
| 2026-10-23 | Complete BAT-071 tested agent adapter capability matrix | Subagent Adapter Matrix |
| 2026-10-23 | Complete BAT-081 runnable end-to-end workflow docs reorganization | Subagent Workflow Docs |
| 2026-10-23 | Complete BAT-086 license audit & automated verification tests | Subagent License Auditor |
| 2026-10-23 | Complete BAT-084 governance, compatibility, and security policies | Subagent Governance |
| 2026-10-23 | Daily DNA reconciliation, bootstrap AGENT_BUS and multi-agent coordination protocol | Antigravity Lead |
| 2026-10-23 | Add BAT-013 execution identity provenance and session tracking | Parallel Agent |

## Learned Knowledge
- Test suite invokes real git commands and integration runs; commands must allow sufficient time to execute.
- Always check `docs/AGENT_BUS.md` active claims before touching any file.
