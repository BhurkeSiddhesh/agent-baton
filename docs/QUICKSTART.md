[Agent Baton](../README.md) / [Docs](../README.md#documentation) / Quickstart

# Quickstart

Run through the complete, end-to-end lifecycle of an AI coding task—from user feature request to a merged, verified feature—in about ten minutes. You need Node.js 18 or newer and Git 2.38 or newer.

---

## Capabilities: Offline Core vs. Cloud Roadmap

Agent Baton is architected as an **offline-first, zero-runtime-dependency CLI orchestrator** that can scale into cloud-hosted workflows:

| Capability Domain | Current Offline Capabilities (v0.1.0) | Cloud & Autonomous Roadmap |
|---|---|---|
| **Runtime & Dependencies** | Pure Node.js ESM built-ins (`node:fs`, `node:child_process`, `node:crypto`). Zero external npm dependencies. | Hosted serverless workers, managed SaaS control plane. |
| **State & Ledger** | Append-only event ledger stored offline in the Git common directory (`.baton/state/` or git refs). Fully verifiable offline. | Centralized cloud ledger replication, multi-repo synchronization. |
| **Agent Isolation** | Physical Git worktree isolation (`baton worktrees --create`) and local tool guard hooks (`baton guard`). | Cloud sandbox containers, isolated ephemeral GitHub Actions VMs. |
| **Dispatch & Planning** | Local CLI prompt decomposition (`baton split`), deterministic planner (`baton assign`), and local human gate management (`baton gate`). | Remote GitHub Issue dispatch (`baton dispatch`), automated PR assignment, and webhook event intake. |
| **Verification & Secrets** | Local regex secret scanner, strict scope boundary checker, and test command execution on clean working trees. | Cloud CI matrix verification, distributed remote test runners. |

For enterprise and cloud workflows, see [CLOUD.md](CLOUD.md), [ENTERPRISE_CLOUD.md](ENTERPRISE_CLOUD.md), and [ROADMAP.md](ROADMAP.md).

---

## 1. Installation & Environment Check

Install Baton directly into your target repository using `npx` or bootstrap scripts:

```bash
cd your-repo
npx github:BhurkeSiddhesh/agent-baton init --yes
# or: npx agent-baton init --yes      # once published to npm
```

Alternatively, use the bootstrap installer which checks Node compatibility first:
`sh install.sh` ([install.sh](../install.sh)) or `powershell -File install.ps1` ([install.ps1](../install.ps1)).

Key flags for `init`:
| Flag | Description |
|---|---|
| `--yes` | Accept detected project defaults without interactive prompts |
| `--dry-run` | Preview files to be written without touching the filesystem |
| `--agents auto\|all\|claude,codex,...` | Select which agent adapter files to generate (default `auto`) |
| `--test-cmd "npm test"` | Override the automatically detected test command |
| `--cloud` | Write GitHub Actions workflows for cloud agent execution (see [CLOUD.md](CLOUD.md)) |
| `--hooks` | Merge Baton's file ownership guard into `.claude/settings.json` |

Verify your environment immediately:

```bash
node .baton/runtime/bin/baton.js doctor
```

> **CLI Shortcut**: In this guide, `baton` refers to `node .baton/runtime/bin/baton.js` (or `.baton/baton` on POSIX, `.baton\baton` on Windows).
>
> Set your agent identity once per terminal session:
> ```bash
> export BATON_AGENT=codex           # Bash/Zsh
> # $env:BATON_AGENT = "codex"       # PowerShell
> ```

See [AGENTS.md](AGENTS.md#what-init-writes) for details on files created by `init`.

---

## 2. Feature Request to Proposal (Decomposition)

An end-to-end task starts with a feature request: *"Add JSON invoice export endpoint"*.

### Option A: Agent-Assisted Planning (`baton split`)

Generate an orchestration prompt or have an agent CLI draft structured work packets:

```bash
# 1. Preview the planning prompt without running external commands
baton split "Add JSON invoice export endpoint" --out .baton/prompt.md

# 2. Or let an agent CLI draft the proposal directly (dry-run to preview command)
baton split "Add JSON invoice export endpoint" --run claude --dry-run
baton split "Add JSON invoice export endpoint" --run claude
```

`split --run` writes a schema-validated proposal JSON under `.baton/proposals/<timestamp>.json`.

Inspect and import the proposal into the project plan:

```bash
# Validate without writing
baton plan import .baton/proposals/<timestamp>.json --dry-run

# Ingest into active plan
baton plan import .baton/proposals/<timestamp>.json
```

### Option B: Manual Planning (`baton plan`)

Define tracks and work packets directly using the CLI:

```bash
# 1. Create a track with file ownership boundaries
baton plan track add --id api --owner claude --owns src/api/,tests/api/ --by human

# 2. Add a work packet to the track
baton plan add --title "JSON invoice export" --track api \
  --owns src/api/export.js,tests/api/export.test.js \
  --priority P0 \
  --check "handles empty list" \
  --check "validates date format" \
  --check "tests pass" \
  --by human
```

See [PLAN_FORMAT.md](PLAN_FORMAT.md) for full plan schema details.

---

## 3. Approval, Gates & Assignment

Before any agent writes code, Baton enforces governance invariants:

```bash
# 1. Deterministically assign authors and independent reviewers
baton assign --by human

# 2. Validate plan dependencies, ownership bounds, and ledger consistency
baton check
```

If human sign-off or prerequisite credentials are required, check and open human gates:

```bash
# List all gates and their status
baton gate list

# Open a prerequisite gate
baton gate open G1 --by human --note "API schema approved by architect"
```

Commit `.baton/plan.json` so all local and remote agents share the same plan state:

```bash
git add .baton/plan.json && git commit -m "chore(baton): update plan and assignments"
```

---

## 4. Worktree Isolation & Beginning Execution

Baton isolates concurrent agents using Git worktrees so workers never collide on uncommitted files or Git index locks.

```bash
# Create dedicated worktrees for each plan track
baton worktrees --create
```

Each worker operates inside its assigned track directory:

```bash
cd ../your-repo-worktrees/api
```

Query the next assigned packet:

```bash
baton next --agent codex
```

Check out a dedicated packet branch from the integration branch and begin:

```bash
git switch -c baton/WP-001-invoice-export
baton begin WP-001 --agent codex
```

`begin` atomically validates dependencies and gates, snapshots the working tree, acquires an exclusive lease, and posts a `CLAIM` event to the inter-agent bus.

---

## 5. Scoped Implementation, Heartbeats & Blockers

During implementation, agents must edit **only** the files specified in the packet's `owns` list:

```bash
# Edit files inside owns:
# src/api/export.js
# tests/api/export.test.js
```

### Heartbeats during Long Tasks

Leases have a default expiration time to prevent deadlocks. Extend your lease periodically:

```bash
baton heartbeat WP-001 --agent codex
```

### Handling Blockers

If an agent needs clarification from a human or another agent:

```bash
# Mark blocked with a clear reason and question
baton block WP-001 --agent codex --reason "missing format spec" --question "Should dates be ISO-8601 or unix timestamps?"

# Query what to work on while blocked
baton next --agent codex

# Once unblocked, resume
baton begin WP-001 --agent codex
```

---

## 6. Multi-Stage Verification & Submission

Once code and tests are written, commit your changes before running verification:

```bash
git add -A && git commit -m "feat(api): add JSON invoice export endpoint"
```

Run Baton's multi-stage verification pipeline:

```bash
baton verify WP-001
```

`verify` enforces 4 sequential gates:
1. **Scope Guard**: Confirms every modified file is strictly within `owns` or coordination paths.
2. **Secret Scan**: Inspects diffs for API keys, bearer tokens, and private credentials.
3. **Automated Tests**: Executes the configured test suite (`npm test`, `pytest`, etc.) with timeout protection.
4. **Dirty Tree Check**: Ensures the test run left no untracked or uncommitted artifacts.

Submit the verified work for independent review:

```bash
baton submit WP-001 --agent codex --note "all done checks pass; tests green on commit 9a8b7c"
```

`submit` verifies that HEAD matches the verified commit marker and advances the packet to `READY_FOR_REVIEW`.

---

## 7. Independent Review, Findings & Acceptance

Baton enforces **two-agent separation**: the author cannot review their own packet.

Switch to the assigned reviewer:

```bash
export BATON_AGENT=claude
baton next --agent claude
```

Display the review brief:

```bash
baton review WP-001
```

The review brief outputs the exact diff, commit SHA, done checks, test results, and any open findings.

### Filing Audit Findings (if issues exist)

```bash
baton finding add --packet WP-001 --by claude --severity MAJOR \
  --text "Invoice export omits ISO-8601 timezone offset" \
  --file src/api/export.js --line 42 \
  --evidence "npm test -- failed timezone assertion" \
  --fix "Use toISOString() instead of toDateString()"
```

Open `BLOCKER` or `MAJOR` findings prevent packet acceptance.

### Recording Verdicts

```bash
# Option 1: Accept clean work
baton accept WP-001 --by claude --score 9 --note "verified tests pass and scope respected"

# Option 2: Accept with minor fixes
baton fix WP-001 --by claude --note "minor docstring formatting needed"

# Option 3: Reject and return to author for rework
baton reject WP-001 --by claude --note "failing edge cases for zero-amount invoices"
```

---

## 8. Landing, Fast-Forward Merge & Ledger Publishing

Once a packet is `ACCEPTED`, the orchestrator or human merges it into the integration branch:

```bash
# Fast-forward main to the accepted commit (never creates merge commits)
baton merge WP-001 --by claude
```

If another branch landed first and `main` has moved forward, rebase the track branch:

```bash
baton sync
```

`sync` safely rebases the current track branch onto `main`. If a merge conflict occurs, it cleanly aborts without leaving dirty state.

### Exporting and Verifying the Event Ledger

In Baton's offline model, ledger events are committed to the Git repository for durable cross-agent memory:

```bash
baton ledger export
baton ledger verify
git add .baton/ledger/ && git commit -m "chore(baton): record WP-001 completion in ledger"
```

---

## 9. Multi-Agent Worktree Isolation Tutorial

When multiple agents work on the same repository in parallel, sharing a single working directory causes git index lock collisions, uncommitted file conflicts, and clobbered diffs.

Baton solves this by assigning each track its own **Git worktree**:

```
repo-root/                   # Main repository checkout (integration branch)
  .baton/                    # Shared plan and configuration
  .git/                      # Common Git directory

repo-root-worktrees/
  api/                       # Worktree for track "api" (branch: track/api)
  ui/                        # Worktree for track "ui" (branch: track/ui)
```

### Running Two Agents in Parallel:

1. **Initialize Worktrees**:
   ```bash
   baton worktrees --create
   ```
2. **Launch Agent A (API Track)**:
   ```bash
   cd ../your-repo-worktrees/api
   export BATON_AGENT=codex
   baton begin WP-001 --agent codex
   # Agent A works independently on src/api/ without touching UI code
   ```
3. **Launch Agent B (UI Track)**:
   ```bash
   cd ../your-repo-worktrees/ui
   export BATON_AGENT=gemini
   baton begin WP-002 --agent gemini
   # Agent B works simultaneously on src/ui/ without Git index collision
   ```
4. **Common Ledger Synchronization**:
   All worktrees reference the root repository's `.git` common directory. Bus claims and packet state transitions posted by Agent A are instantly visible to Agent B via `baton status` and `baton check`.
5. **Rebasing after Merge**:
   When Agent A's packet merges to `main`, Agent B updates their branch cleanly:
   ```bash
   cd ../your-repo-worktrees/ui
   baton sync
   ```

---

## 10. Observability & Next Steps

Monitor workspace progress across all agents:

```bash
baton status          # Detailed packet status, owners, reviewers, and blockers
baton release         # Milestone completion percentage and closed gates
baton scores          # Per-agent quality scoreboard (scores, rejections, findings)
baton digest          # Activity report since last digest and items needing attention
baton render          # Render markdown views in .baton/views/ (STATUS, BUS, SCOREBOARD)
```

### Explore Further:

- [WORKFLOW.md](WORKFLOW.md) — Exhaustive lifecycle rules, roles, escalation, and protocol invariants
- [COMMANDS.md](COMMANDS.md) — Complete CLI reference with every subcommand and flag
- [PLAN_FORMAT.md](PLAN_FORMAT.md) — Plan schema, track definitions, and dependency graph syntax
- [CLOUD.md](CLOUD.md) — GitHub Actions cloud dispatch and automated CI workflows
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — Error codes, recovery procedures, and FAQ
- [ROADMAP.md](ROADMAP.md) — Upcoming features and enterprise roadmap
