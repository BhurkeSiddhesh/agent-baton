# Agent workflow (Agent Baton {{baton.version}})

{{#if project.name}}{{project.name}} coordinates AI coding agents with Agent Baton.{{else}}This repository coordinates AI coding agents with Agent Baton.{{/if}} Several agents work in one tree or in parallel branches. This document is the human-readable form of the protocol in AGENTS.md. The command prefix is `{{cli}}`.

## 1. Concepts

- **Agent**: a roster entry with an id and roles (orchestrator, worker, reviewer, auditor).
- **Track**: a standing theme owned by one agent with a set of owned paths. Track ownership never overlaps.
- **Packet**: one unit of work with an exact `owns` list, `done_checks`, an author and a different reviewer.
- **Gate**: a human decision that blocks packets until `{{cli}} gate open <id> --by human`.
- **Ledger**: an append-only event log, one JSON file per event under `.baton/ledger/`. Status is derived by replaying events over `.baton/plan.json`. Nothing is edited in place.
- **Bus**: the readable view of message events (claims, releases, requests, notices, handoffs, verdicts): `{{cli}} bus list`.

## 2. Roster

{{> roster}}

## 3. Packet lifecycle

```
PLANNED -> IN_PROGRESS -> READY_FOR_REVIEW -> ACCEPTED
                |  ^            |  \
                v  |            |   +-> ACCEPTED_WITH_FIXES -> ACCEPTED
             BLOCKED            +-> REJECTED -> CARRIED_OVER -> IN_PROGRESS
```

- `begin` is the only way into IN_PROGRESS. It takes a lease, snapshots the tree and posts a claim.
- `submit` requires a passing, current `verify` (scope guard, protected paths, secret scan{{#if testCommand}}, `{{testCommand}}`{{/if}}).
- Only the assigned reviewer records a verdict, never the author or a contributor.
- ACCEPTED is refused while BLOCKER or MAJOR findings are open.
- After repeated rejections the packet is flagged ESCALATE and returns to the orchestrator.
- Flags: STALE (lease expired), NO_LEASE, AT_RISK, ESCALATE, GATE_CLOSED.

## 4. Daily flow

{{> protocol}}

## 5. Planning

The orchestrator (`{{orchestrator}}`) turns a goal into packets:

```
{{cli}} split "<goal>" --out .baton/proposals/prompt.md
{{cli}} plan import .baton/proposals/<name>.json --dry-run
{{cli}} plan import .baton/proposals/<name>.json
{{cli}} assign --only-unassigned
{{cli}} check
```

`split` prints a prompt; the agent that answers it returns one JSON proposal. Nothing is applied until `plan import` runs. Review the proposal first.

## 6. Branches and worktrees

Packets run on `baton/<packet>` branches when branches are in use. `{{cli}} worktrees --create` makes one worktree per track. `{{cli}} sync` rebases a track branch onto main. `{{cli}} merge <packet> --by <orchestrator>` fast-forwards main to an accepted commit only.

## 7. Cloud agents

State is shared through the tracked ledger mirror, so a fresh clone sees full history. `{{cli}} dispatch <packet>` creates a GitHub issue labelled `baton` so a cloud agent can pick the packet up. CI runs `{{cli}} check` and `{{cli}} verify` on `baton/` branches.

## 8. Rules

{{> rules}}

## 9. Views and scoring

`{{cli}} render` writes STATUS.md, BUS.md, SCOREBOARD.md and PLAN.md to `.baton/views/`. `{{cli}} scores` ranks agents on first-pass acceptance, review quality and findings. `{{cli}} release` shows milestone progress and open gates.

## 10. Commands

{{> commands}}
