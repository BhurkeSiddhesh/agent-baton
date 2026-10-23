[Agent Baton](../README.md) / [Docs](../README.md#documentation) / Workflow

# Workflow

The complete, deterministic lifecycle of work packets in Agent Baton—from initial user feature request through planning, scoped execution, multi-stage verification, independent review, and fast-forward landing into `main`.

Terms and state invariants are defined in [CONCEPTS.md](CONCEPTS.md); full command syntax is documented in [COMMANDS.md](COMMANDS.md). In this guide, `baton` refers to `node .baton/runtime/bin/baton.js`.

<div align="center">
<img alt="Agent Baton workflow" src="../assets/diagram-workflow.svg" width="100%">
</div>

---

## Architectural Model: Offline Core vs. Cloud Roadmap

Agent Baton operates with a strict separation between its **offline, zero-dependency core CLI** and its **cloud/autonomous roadmap**:

| Architectural Domain | Current Offline Capabilities (v0.1.0) | Cloud & Autonomous Roadmap |
|---|---|---|
| **Zero Runtime Dependencies** | Standalone Node.js ESM CLI using built-in standard modules (`node:fs`, `node:child_process`, `node:crypto`). No external npm packages required at runtime. | Hosted SaaS orchestrator services, serverless execution hooks. |
| **Storage & Event Ledger** | Append-only deterministic ledger stored in the Git common directory (`.baton/state/` or git references). Zero network calls required for state reconstruction. | Multi-repository federated sync, cloud database backends, team activity streams. |
| **Concurrency & Isolation** | Physical Git worktree isolation (`baton worktrees --create`) avoiding Git index locks and dirty workspace overwrites. Local pre-tool file guards (`baton guard`). | Containerized cloud workers, ephemeral VM execution sandboxes. |
| **Planning & Dispatch** | Local CLI prompt decomposition (`baton split`), deterministic roster assignment (`baton assign`), and manual human gate controls (`baton gate`). | Remote GitHub Issue dispatch (`baton dispatch`), automated PR sync, and webhook-driven multi-agent swarms. |
| **Verification & Security** | Local diff-based secret scanner, strict file boundary validator, and test suite execution with process timeouts on clean trees. | Distributed matrix verification runners, automated security attestations. |

For remote and cloud setups, refer to [CLOUD.md](CLOUD.md), [ENTERPRISE_CLOUD.md](ENTERPRISE_CLOUD.md), and [ROADMAP.md](ROADMAP.md).

---

## The Protocol Every Agent Follows

Every agent initialized into a Baton workspace follows nine non-negotiable operational invariants (written into `AGENTS.md` and agent adapter files by `init`):

1. **Session Start**: Run `baton check`, then `baton next --agent <me>`. The ledger determines what is ready, never chat memory or guesswork.
2. **Claim Before Touch**: Run `baton begin <packet> --agent <me>` before modifying any file. Touch **only** the packet's `owns` files plus coordination paths. If another file is needed, post a `REQUEST` on the bus or ask the orchestrator. Never edit unclaimed files.
3. **Execution Invariant**: Work until every done check is true. If blocked, run `baton block` with a specific question, then run `baton next` to pick up unblocked stretch work. For long-running operations, emit `baton heartbeat`.
4. **Sign-Off Invariant**: Run `baton verify <packet>`, commit the clean state, and run `baton submit <packet>` with verifiable proof.
5. **Review Invariant**: A different agent reviews every submitted packet and records an evidence-based verdict. Authors never review their own packets.
6. **Audit Invariant**: Auditors file findings via `baton finding add` and never edit audited files. Authors fix and resolve; filers confirm.
7. **Escalation Invariant**: Repeated rejections automatically escalate to the orchestrator for re-scoping or reassignment.
8. **Landing & Publishing**: The orchestrator fast-forwards `main` onto the accepted commit, exports the final event ledger, and closes the day with `baton digest`.
9. **Idle Mode**: When the build horizon is exhausted, agents switch to audit mode.

---

## Role Hierarchy & Access Boundaries

| Role | Permitted Actions | Strict Prohibitions |
|---|---|---|
| **orchestrator** | `split`, `plan (add/edit/import/rm)`, `assign`, `reassign`, `carry`, `merge`, `dispatch`, `digest`, `worktrees` | Cannot override repo rules or bypass human gates; cannot modify the plan while acting as a worker. |
| **worker** | `begin`, edit owned files, `heartbeat`, `block`, `verify`, `submit`, fix assigned findings | Cannot touch files outside `owns`; cannot review or accept own work. |
| **reviewer** | `review`, `accept`, `fix`, `reject`, `finding add` | Must not be the author or contributor of the packet under review. |
| **auditor** | `finding add` against accepted or in-review packets | Cannot edit files under audit. |
| **human** | Opens/closes gates (`gate open/close`), acts as orchestrator, authorizes shell commands | |

Only the orchestrator or `human` may write to the plan. Omitting `--by` and `BATON_AGENT` defaults the actor to `human`.

---

## Runnable End-to-End Workflow

The complete lifecycle moves linearly through 8 well-defined stages:

```
[1. User Feature Request]
           │
           ▼
[2. Plan Proposal & Import] ──► [Human Gates & Assignment]
                                           │
                                           ▼
                                [3. Worktree & Begin]
                                           │
                                           ▼
                                [4. Implementation & Bus]
                                           │
                                           ▼
                                [5. Verify & Submit]
                                           │
                                           ▼
                                [6. Independent Review] ──► (Reject/Fix -> Rework)
                                           │
                                        (Accept)
                                           ▼
                                [7. Fast-Forward Merge] ──► [Ledger Export]
                                           │
                                           ▼
                                [8. Audit Mode & Digest]
```

---

### Stage 1: Feature Request to Structured Proposal

A workflow begins with a natural language feature request or objective: *"Add JSON invoice export endpoint"*.

#### A. Generate Planning Prompt or Proposal

```bash
# Preview planning prompt without invoking external tools
baton split "Add JSON invoice export endpoint" --out .baton/prompt.md

# Or execute an agent CLI to generate a structured proposal
baton split "Add JSON invoice export endpoint" --run claude --dry-run
baton split "Add JSON invoice export endpoint" --run claude
```

`split --run` produces a validated JSON proposal under `.baton/proposals/<timestamp>.json`.

#### B. Dry-Run and Ingest Proposal

```bash
# Validate proposal schema and check for ownership overlaps without writing
baton plan import .baton/proposals/<timestamp>.json --dry-run

# Import the validated proposal into active plan (.baton/plan.json)
baton plan import .baton/proposals/<timestamp>.json
```

#### C. Alternative: Manual Plan Authoring

```bash
# Create track with ownership boundaries
baton plan track add --id api --owner claude --owns src/api/,tests/api/ --by human

# Add a work packet to the track
baton plan add --title "JSON invoice export" --track api \
  --owns src/api/export.js,tests/api/export.test.js \
  --priority P0 \
  --check "handles empty invoices" \
  --check "validates ISO-8601 timestamps" \
  --check "tests pass" \
  --by human
```

---

### Stage 2: Plan Approval, Gates & Deterministic Assignment

Before workers pick up work, the orchestrator validates the dependency graph and assigns roles:

```bash
# Deterministically assign author and independent reviewer
baton assign --by human

# Validate plan schema, dependency DAG, track ownership bounds, and ledger integrity
baton check

# Visualize dependency graph in terminal or mermaid syntax
baton plan graph
baton plan graph --mermaid
```

#### Human Gates & Risk-Tiered Approval

Baton supports both static plan gates and dynamic, risk-tiered approval gates for operations:

##### Risk Tiers

Operations and actions are classified into four risk tiers:
- **`read-only`**: Non-mutating queries, inspections and status checks (`read`, `query`, `status`, `scores`, `check`). Never blocked by gates.
- **`normal`**: Scoped write operations within standard ownership boundaries.
- **`privileged`**: High-impact or configuration-altering actions (`deploy`, `publish`, `release`, `merge`, `config`). Requires explicit authorization by `human` or an authorized `orchestrator`.
- **`destructive`**: Data-loss or irreversible actions (`delete`, `destroy`, `rm`, `purge`, `reset`, `force-push`, `rollback`). Strictly requires explicit authorization by `human` or an authorized `orchestrator`.

##### Gate Ownership & Lifecycle

Dynamic approval gates transition through five lifecycle states:
`REQUESTED` ➔ `APPROVED` | `DENIED` | `EXPIRED` | `CANCELLED`

- **Role Enforcement**: Only `human` or an agent with the `orchestrator` role may approve `privileged` and `destructive` operations. Workers cannot approve privileged/destructive gates, and agents cannot self-approve their own privileged/destructive requests.
- **Immutable Action Context**: Approval decisions capture immutable session and commit identifiers (`session_id`, `commit`, `context_sha`). An approval cannot be repurposed for mutated parameters or arbitrary commits.
- **TTL & Expiration**: Approval requests can include a time-to-live (`--ttl <seconds>`). Once expired, approvals are invalid and cannot authorize execution.
- **Denial Semantics**: Once an operation request is denied (`DENIED`), retrying the exact same operation/commit without a newly submitted and approved gate remains strictly blocked (`APPROVAL_DENIED`).

##### Gate CLI Commands

```bash
# Request approval for a risk-tiered operation
baton gate request deploy production --risk destructive --reason "Production v1.0 release"

# List gates filtered by status
baton gate list --status REQUESTED

# Approve a gate (human or orchestrator)
baton gate approve GATE-001 --by human

# Deny a gate with an audit reason
baton gate deny GATE-001 --by human --reason "Migrations require zero-downtime compatibility"

# Check gate approval status
baton gate check GATE-001

# Inspect all plan gates and dynamic approvals
baton gate list

# Open a blocking gate with justification
baton gate open G1 --by human --note "API schema and security review approved"
```

A closed gate blocks `baton begin` by default (`gate_mode: start`).

---

### Stage 3: Multi-Agent Worktree Isolation & Lease Acquisition

To enable true parallel execution across multiple agents without Git conflicts, Baton creates dedicated worktrees:

```bash
# Create one worktree per plan track
baton worktrees --create
```

#### Directory Structure

```
your-project/                        # Integration branch root (e.g., main)
  .baton/plan.json
  .git/                              # Git common directory (shared event store)

your-project-worktrees/
  api/                               # Worktree for track 'api' (branch: track/api)
  ui/                                # Worktree for track 'ui' (branch: track/ui)
```

#### Starting the Packet

The worker navigates into their track worktree and checks the queue:

```bash
cd ../your-project-worktrees/api

# Discover next available work in strict priority order
baton next --agent codex
```

Check out a dedicated packet branch and begin:

```bash
# Create branch from the latest track/main tip
git switch -c baton/WP-001-invoice-export

# Begin packet execution
baton begin WP-001 --agent codex
```

`begin` performs the following atomic actions:
1. Validates that the agent is authorized to take the packet.
2. Checks that all prerequisite dependencies and human gates are satisfied.
3. Checks for file ownership overlaps with any currently active packet.
4. Acquires an exclusive lease and snapshots the current tree state.
5. Posts a `CLAIM` event with claimed files and do-not-touch boundaries to `docs/AGENT_BUS.md`.

---

### Stage 4: Scoped Implementation, Heartbeats & Blockers

During implementation, workers must strictly respect their file boundaries:

- Workers may modify **only** files specified in the packet's `owns` list.
- Coordination paths (`.baton/`, `docs/AGENT_BUS.md`) may be read or appended per protocol rules.
- Any attempt to modify unowned files is blocked by `baton guard` and rejected by `baton verify`.

#### Inter-Agent Requests via Bus

If an agent needs an export or change in another agent's file:

```bash
baton bus post --from codex --to claude --type REQUEST --packet WP-001 \
  --text "Please export InvoiceFormatter from src/models/invoice.js"
```

#### Lease Heartbeats

For long tasks, refresh the lease to prevent expiration:

```bash
baton heartbeat WP-001 --agent codex
```

#### Handling Blockers

If an agent is blocked by external dependencies or unanswered questions:

```bash
baton block WP-001 --agent codex --reason "missing sample fixture" --question "Where is the test fixture for canceled invoices?"

# Check queue for stretch work or other ready packets
baton next --agent codex

# Once unblocked, resume
baton begin WP-001 --agent codex
```

#### Stale Leases & Crash Recovery

If an agent crashes or goes silent past its TTL, the packet shows `STALE`. Any authorized worker may reclaim it:

```bash
baton reclaim WP-001 --agent codex
```

`reclaim` records the takeover on the bus, rolls back or inspects unverified changes, and starts a fresh lease.

---

### Stage 5: Multi-Stage Verification & Pre-Review Submission

Once implementation and tests are complete, commit the changes to the packet branch:

```bash
git add -A && git commit -m "feat(api): implement JSON invoice export"
```

Run Baton's multi-stage verification pipeline:

```bash
baton verify WP-001
```

`verify` executes 4 strict checks in sequence:
1. **Scope Guard**: Checks git diff against the packet's `owns` paths. Protected files and foreign packet files cause immediate failure.
2. **Secret Scan**: Analyzes commits and unstaged changes for AWS tokens, private keys, GitHub credentials, Slack tokens, and generic `secret=` patterns. Deliberate fixtures can be whitelisted with `baton:allow-secret`.
3. **Automated Test Suite**: Executes the test command (`config.test.command` or packet-specific `test`) inside a subprocess with timeout limits.
4. **Dirty Tree Check**: Verifies that tests did not generate untracked temporary files or modify working state.

Upon passing, `verify` writes a signed verification marker.

#### Submitting for Review

```bash
baton submit WP-001 --agent codex --note "all done checks pass; unit and integration tests green"
```

`submit` validates that HEAD exactly matches the verified commit marker, moves the packet status to `READY_FOR_REVIEW`, and posts a sign-off event with test output tail to the bus.

---

### Stage 6: Independent Review, Audit Findings & Verdicts

Baton enforces independent review: an author cannot review their own packet (`requireDifferentReviewer: true`).

The assigned reviewer checks their queue:

```bash
export BATON_AGENT=claude
baton next --agent claude
```

#### Inspecting the Review Brief

```bash
baton review WP-001
```

The review brief prints:
- Packet title, track, author, and commit SHA;
- Full git diff and checkout commands;
- Done checks with verification proofs;
- Test execution output tail;
- Any active audit findings.

The reviewer must run the tests independently on the checked-out commit.

<a id="findings"></a>
### Findings & Remediation Lifecycle

If defects or security oversights are identified during review or post-landing audits:

```bash
# 1. File a finding
baton finding add --packet WP-001 --by claude --severity MAJOR \
  --text "Date serializer omits UTC offset in invoice header" \
  --file src/api/export.js --line 42 \
  --evidence "npm test failed on timezone fixture" \
  --fix "Use toISOString() instead of toString()"

# 2. List open findings
baton finding list --packet WP-001 --open

# 3. Author fixes issue, commits, re-verifies, and resolves finding
baton finding resolve AUD-001 --by codex --resolution fixed --note "Fixed in commit 1a2b3c"

# 4. Filer confirms resolution to close it
baton finding resolve AUD-001 --by claude --confirm
```

Finding severities:
- `BLOCKER`: Prevents acceptance and blocks releases.
- `MAJOR`: Prevents packet acceptance.
- `MINOR`: Informational; does not prevent acceptance.

#### Review Verdicts

```bash
# Accept clean work
baton accept WP-001 --by claude --score 9 --note "verified tests pass on commit 1a2b3c"

# Accept with minor non-blocking fixes
baton fix WP-001 --by claude --note "minor comment cleanup in export.js"

# Reject packet and send back to author
baton reject WP-001 --by claude --note "export drops empty invoice items"
```

#### Escalation & Carry-Over

When a packet is rejected, it moves back to `IN_PROGRESS` or the author calls `begin` to rework.
After repeated rejections (`escalateAfterRejections`, default 2), the packet is flagged `ESCALATE`.
The orchestrator may carry it over to another iteration or author:

```bash
baton carry WP-001 --by claude --note "re-scoping exporter into two smaller packets"
```

---

### Stage 7: Landing, Fast-Forward Merge & Event Ledger Publishing

Once a packet is `ACCEPTED`, it is ready to land onto `main`:

```bash
# Fast-forward main to the accepted commit
baton merge WP-001 --by claude
```

`merge` performs a strict fast-forward (`git merge --ff-only`). It **never** creates merge commits.

#### Synchronizing Concurrent Branches (`baton sync`)

If `main` moved forward while another track was in progress, that track must rebase:

```bash
cd ../your-project-worktrees/ui
baton sync
```

`sync` rebases the current track branch onto `main`. If a rebase conflict occurs, it aborts cleanly and leaves the branch untouched for manual resolution. Active packets on the rebased branch must be re-verified before submission.

#### Publishing Ledger Events

Because Baton uses an append-only event ledger stored in the Git common directory, final events (acceptance, review, merge) should be committed to Git:

```bash
cd your-project                     # On the integration branch (main)
baton ledger export
baton ledger verify
git add .baton/ledger/
git commit -m "chore(baton): record WP-001 merge and acceptance in ledger"
git push origin main
```

---

### Stage 8: Audit Mode, Observability & Daily Lifecycle

When an agent calls `baton next` and all implementation packets are completed or in-progress, the agent automatically enters **Audit Mode**:

```bash
baton next --agent codex
# Returns: AUDIT TARGETS (read-only audit of accepted packets)
```

Auditors:
1. Check out accepted commits;
2. Verify tests and edge cases;
3. File findings via `baton finding add` (auditors never edit audited files);
4. The packet author provides the fix; the auditor confirms.

If all audit targets are exhausted, `next` prints `HORIZON EXHAUSTED` with instructions for the orchestrator.

#### Daily Orchestrator Maintenance

```bash
# Daily activity digest: completed packets, open blockers, items needing attention
baton digest

# Refresh markdown summary views in .baton/views/
baton render

# Check workspace release progress against milestones and gates
baton release

# View per-agent quality scorecards
baton scores
```

---

## Hands-On Tutorial: Multi-Agent Worktree Isolation

This step-by-step tutorial demonstrates how two agents (`claude` on `api` track and `gemini` on `ui` track) work concurrently on the same repository without file clobbering or git lock contention.

### 1. Repository Setup & Plan Creation

```bash
# From repository root
baton plan track add --id api --owner claude --owns src/api/,tests/api/ --by human
baton plan track add --id ui --owner gemini --owns src/ui/,tests/ui/ --by human

baton plan add --title "API endpoints" --track api --owns src/api/routes.js,tests/api/routes.test.js --by human
baton plan add --title "UI dashboard" --track ui --owns src/ui/Dashboard.js,tests/ui/Dashboard.test.js --by human

baton assign --by human
git add .baton/plan.json && git commit -m "chore: setup parallel tracks"
```

### 2. Create Isolated Worktrees

```bash
baton worktrees --create
```

Output:
```
api            track/api                created /path/to/project-worktrees/api
ui             track/ui                 created /path/to/project-worktrees/ui
Each agent: cd into its track worktree, then baton begin/verify/submit there.
```

### 3. Agent A Executes in Worktree `api`

```bash
cd ../project-worktrees/api
export BATON_AGENT=claude

# Start packet
baton begin WP-001 --agent claude

# Create API code and tests
echo "export const routes = [];" > src/api/routes.js
echo "import test from 'node:test'; test('api', () => {});" > tests/api/routes.test.js

# Commit and verify
git add src/api/ tests/api/ && git commit -m "feat(api): routes"
baton verify WP-001
baton submit WP-001 --agent claude --note "routes ready"
```

### 4. Agent B Executes Simultaneously in Worktree `ui`

Agent B works in its own separate directory with zero Git index contention:

```bash
cd ../project-worktrees/ui
export BATON_AGENT=gemini

# Start packet
baton begin WP-002 --agent gemini

# Create UI component and tests
echo "export function Dashboard() {}" > src/ui/Dashboard.js
echo "import test from 'node:test'; test('ui', () => {});" > tests/ui/Dashboard.test.js

# Commit and verify
git add src/ui/ tests/ui/ && git commit -m "feat(ui): dashboard"
baton verify WP-002
baton submit WP-002 --agent gemini --note "dashboard ready"
```

### 5. Review & Cross-Agent Landing

1. Reviewer accepts Agent A's packet:
   ```bash
   baton accept WP-001 --by gemini --score 10 --note "clean routes"
   ```
2. Orchestrator merges Agent A's packet to `main`:
   ```bash
   baton merge WP-001 --by human
   ```
3. Agent B rebases worktree `ui` cleanly onto updated `main`:
   ```bash
   cd ../project-worktrees/ui
   baton sync
   ```
4. Reviewer accepts Agent B's packet:
   ```bash
   baton accept WP-002 --by claude --score 10 --note "clean dashboard"
   baton merge WP-002 --by human
   ```

Both tracks are merged into `main` without a single Git merge conflict or dirty tree collision!

---

## Exit Codes Reference

| Exit Code | Classification | Meaning |
|---|---|---|
| `0` | Success | Command completed successfully. |
| `1` | Check Failure | A business rule, test assertion, scope constraint, or dependency check failed. |
| `2` | Usage Error | Invalid command-line arguments, missing required options, or unknown flags. |
| `3` | Internal Error | Unhandled exception or unexpected system error. |

All structured commands support `--json` output written to `stdout`. Diagnostic logs and error messages are written to `stderr`.

---

## Related Documentation

- [QUICKSTART.md](QUICKSTART.md) — 10-minute guide from zero to your first accepted packet
- [COMMANDS.md](COMMANDS.md) — Exhaustive CLI reference for every command and option
- [CONCEPTS.md](CONCEPTS.md) — Packet states, leases, dependencies, and core glossary
- [PLAN_FORMAT.md](PLAN_FORMAT.md) — Complete specification of `.baton/plan.json`
- [CLOUD.md](CLOUD.md) — GitHub Actions and cloud runner integration
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — Diagnostics, doctor checks, and common remediation patterns
- [ROADMAP.md](ROADMAP.md) — Future architecture and enterprise cloud vision
