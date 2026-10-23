# Agent Baton Integration Examples

This directory provides concrete, runnable reference examples demonstrating how to integrate Agent Baton into real-world codebases.

## Overview of Examples

| Directory | Language & Runtime | Test Runner | Manifest | Description |
|---|---|---|---|---|
| [`examples/node/`](node/package.json) | Node.js (ESM, Node >= 18) | Built-in `node:test` | `package.json` | Arithmetic and math engine with native test runner |
| [`examples/python/`](python/pyproject.toml) | Python (>= 3.9) | Built-in `unittest` / `pytest` | `pyproject.toml` | Mathematical module with strict type and domain assertions |

Each example contains a complete working application, test suite, and pre-configured `.baton/` directory (`config.json` and `plan.json`) showing realistic work packets, ownership paths, and verification rules.

---

## 1. Initializing Baton in a Project

To bootstrap Baton into any existing repository or new project:

```bash
# 1. Initialize Baton configuration and ledger structure
baton init

# 2. Configure agents and roles in .baton/config.json
# Define author, reviewer, auditor, and orchestrator roles
```

During initialization:
- `.baton/config.json` establishes the project metadata, verification commands, and agent roster.
- `.baton/plan.json` defines tracks, milestones, gates, and work packets.
- The append-only event ledger is initialized under `.baton/state/` (or git common directory).
- Git worktree boundaries and branch conventions (`baton/WP-xxx`) are registered.

---

## 2. Independent Peer Review Model

Agent Baton enforces strict segregation of duties to guarantee code quality and prevent autonomous echo-chambers:

- **Author vs. Reviewer Separation**:
  - A work packet (`WP-xxx`) explicitly assigns an `agent` (author) and a distinct `reviewer`.
  - Self-approval is rejected by default (`reviewer !== author`).
- **Rotational & Specialized Review**:
  - Different agents take turns reviewing packets across tracks, ensuring that no single agent holds unchecked control over a subsystem.
- **Review Lifecycle**:
  ```text
  [ASSIGNED] -> [IN_PROGRESS] (author claims lease)
                     │
                     ▼
                 [VERIFY] (automated test suites pass)
                     │
                     ▼
                 [SUBMIT] (author submits worktree diff)
                     │
                     ▼
                 [REVIEW] (independent reviewer inspects changes)
                 ┌───┴───┐
                 ▼       ▼
             [REJECT]  [ACCEPT]
                 │       │
                 │       ▼
                 │    [MERGE] (merged to target branch)
                 ▼
       (remediation loop)
  ```
- **Escalation Protocol**: If a packet receives multiple consecutive rejections (configured via `escalateAfterRejections`), Baton transitions the packet to `BLOCKED` status and alerts the orchestrator or human overseer.

---

## 3. Scope Protection and Guard Violations

Baton safeguards repository integrity through deterministic filesystem fences:

- **Ownership Declarations (`owns`)**:
  - Each work packet specifies explicit file and glob patterns it owns (e.g. `["src/calculator.js", "test/calculator.test.js"]`).
  - Agents are granted write access **only** to paths within their packet's `owns` declaration.
- **Protected Paths**:
  - Global invariants in `.baton/config.json` protect sensitive files:
    ```json
    "protected": {
      "globs": [".env*", "secrets/**", ".git/**", "credentials.json"]
    }
    ```
- **Guard Modes (`guard.mode`)**:
  - `warn`: Alerts on out-of-scope edits while logging an event.
  - `block`: Fails closed immediately, rejecting commits, staging operations, or verification attempts that touch files outside declared ownership.
- **Guard Violation Handling**:
  - When an agent attempts an unauthorized file modification, Baton issues a `GUARD_VIOLATION` event on the ledger.
  - The violating changes must be rolled back or the plan must be formally updated by an authorized orchestrator before work can proceed.

---

## 4. Lease Timeout and Recovery

To prevent work packet deadlocks and abandoned worktrees when agents crash or go offline, Baton implements a durable lease protocol:

- **Time-to-Live (TTL) Leases**:
  - When an agent runs `baton begin WP-xxx`, it acquires a time-bounded lease (e.g., 8 hours by default).
- **Periodic Heartbeats**:
  - Active agents periodically post heartbeats to renew their lease:
    ```bash
    baton heartbeat WP-xxx --agent codex
    ```
- **Stale Lease Detection**:
  - If a lease expires without a heartbeat, the packet enters `STALE` status.
- **Automated Stale Recovery (`baton reclaim`)**:
  - Any authorized agent or orchestrator can inspect stale leases:
    ```bash
    baton reclaim WP-xxx --agent claude
    ```
  - Recovery sequence:
    1. Inspects the worktree for uncommitted or partial mutations.
    2. Archives or safely cleans dirty working state.
    3. Reclaims or reassigns the lease to an active agent.
    4. Records the takeover event in the tamper-evident ledger.

---

## 5. Offline Workflow vs. Cloud/Automated Runner

Baton is architected for maximum durability and environmental flexibility:

### Zero-Cloud, Offline-First Architecture
- **No External Daemon or Network Calls**:
  - All state is stored locally in standard JSON files and git references.
  - Commands run fully offline, with zero runtime npm dependencies.
- **Git-Native Portability**:
  - The event ledger synchronizes cleanly across peer repositories using standard `git push` and `git fetch` operations.

### Automated CI / Cloud Runner Integration
- **Deterministic Replay**:
  - In CI environments (e.g. GitHub Actions), Baton's verification commands evaluate test suites and cryptographic event signatures identically to local runs:
    ```bash
    npx baton check
    npx baton doctor
    ```
- **Non-Interactive Execution**:
  - Autonomous runners can execute verification loops, check lease health, and enforce branch protection policies headlessly without interactive prompts.

---

## Example Walkthroughs

### Running the Node Example
```bash
cd examples/node
npm test
```

### Running the Python Example
```bash
cd examples/python
python -m unittest discover -s tests -p "test_*.py"
```
