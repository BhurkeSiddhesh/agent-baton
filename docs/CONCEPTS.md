[Agent Baton](../README.md) / [Docs](../README.md#documentation) / Concepts

# Concepts

Agent Baton coordinates several AI coding agents (and humans) that work on one repository. Everything it knows is in
files under `.baton/`; there is no server and no database.

## Agent

A named actor with a roster id: lowercase letters, digits, `_` and `-` (for example `claude`, `codex`). The roster lives
in `.baton/config.json`. Each agent has a `kind` (an adapter id such as `claude`, or `custom`), a list of **roles** and
a list of **strengths** that `baton assign` uses to match packets.

Roles: `orchestrator`, `worker`, `reviewer`, `auditor`. One agent is the orchestrator (`config.orchestrator`).

Identity comes from `--agent <id>` (or `--by <id>`) or the environment variable `BATON_AGENT`. Ids must be in the roster,
plus two reserved ids: `human` and `harness`. For plan writes with neither set, baton treats you as a human at the
keyboard.

## Track

A standing theme owned by one agent, with a set of owned paths (for example `api` owning `src/api/` and `tests/api/`).
Directory ownership between tracks may not overlap; `baton check` enforces it. `baton worktrees` can give each track its
own branch and worktree.

## Packet

A unit of work. It has:

- an exact `owns` list of files or directories it may change (and a `reads` list for context),
- an author (`agent`) and a `reviewer` who is never the author,
- `done_checks`, a list of statements that must all be true before sign-off,
- optional `deps` (soft ordering), `needs_done` (hard: the dependency must be ACCEPTED), a `gate`, a `priority`
  (`P0` to `P3`), a `milestone`, a per-packet `test` command, and a `stretch` flag for optional extras.

Fields are described in [PLAN_FORMAT.md](PLAN_FORMAT.md).

### Statuses

`PLANNED`, `IN_PROGRESS`, `BLOCKED`, `READY_FOR_REVIEW`, `ACCEPTED`, `ACCEPTED_WITH_FIXES`, `REJECTED`, `CARRIED_OVER`.

```
PLANNED / CARRIED_OVER -> IN_PROGRESS | BLOCKED
IN_PROGRESS            -> READY_FOR_REVIEW | BLOCKED
BLOCKED                -> IN_PROGRESS
READY_FOR_REVIEW       -> ACCEPTED | ACCEPTED_WITH_FIXES | REJECTED | IN_PROGRESS (author reopens)
ACCEPTED_WITH_FIXES    -> ACCEPTED | IN_PROGRESS
REJECTED               -> CARRIED_OVER | IN_PROGRESS
ACCEPTED               -> terminal
```

`IN_PROGRESS` is reachable only through `baton begin`, which takes a lease, snapshots the tree and posts a claim.

### Flags

Advisory markers derived from the ledger and shown by `status` and `check`: `STALE` (lease expired), `NO_LEASE`,
`AT_RISK:<dep>=<status>` and `AT_RISK:<dep>-changed` (a cross-track dependency is not done or changed after you
started), `ESCALATE` (rejected `escalateAfterRejections` times and not done), `GATE_CLOSED:<id>`.

## Lease

`begin` grants a lease of `config.lease.hours` (default 8). `heartbeat` extends it. When it expires the packet is
`STALE` and another agent may `reclaim` it. This keeps a crashed or abandoned agent from holding files forever.

## Gate

A human decision that blocks packets, for example "legal review done" or "production API key provisioned". A packet
with `gate: "G1"` cannot be started until `baton gate open G1 --by human`. With `gate_mode: "live_only"` the gate does
not block starting, only live or production work. Only the gate owner or `human` may open or close a gate.

## Ledger

An append-only event log with one JSON file per event, so concurrent branches add files instead of editing a shared
file and git merges them without conflicts. Each event has a chronologically sortable id
(`YYYYMMDDTHHMMSSZ-<6 hex>`), a timestamp, the packet, a kind, the actor, a note, data and a SHA-256 of its own
canonical JSON. `baton check` and `baton ledger verify` detect an edited event. A deleted event cannot be detected
from one copy alone, which is why the ledger is stored twice (see below).

Live state (statuses, leases, findings, scores) is never stored. It is derived by replaying events over the plan.

Event kinds: `begin`, `heartbeat`, `reclaim`, `status`, `ready`, `verdict`, `reviewer`, `handoff`, `verify`, `merged`,
`finding`, `finding_resolved`, `message`, `gate`, `plan`, `init`, `ack`.

### Where it lives

- **Local shared store**: inside the git common directory (`.git/baton/`), so all worktrees of one clone see each
  other's claims immediately. Outside git it is `.baton/state/`.
- **Tracked mirror**: `.baton/ledger/`, written alongside every event when `ledger.mirror` is true (the default).
  Clones and cloud agents see full history from the mirror alone.

Reading is the union of both, de-duplicated by event id. `baton ledger import|export|verify` moves and checks events.

## Bus

The human-readable view of `message` events: claims, releases, requests, notices, blockers, handoffs, verdicts and
questions. Agents ask each other for things with `baton bus post`; `begin`, `submit`, `accept` and friends post their own
messages. `baton bus list` and `baton bus tail` read it.

## Verify marker

`baton verify` records a marker for the packet: the mode, the verified commit (or file fingerprint when there is no
git) and the result. `baton submit` accepts only a passing marker that is still current, meaning the tree is clean and
HEAD is the verified commit. Change anything after verifying and you must verify again.

## Findings

Structured audit results with a severity (`BLOCKER`, `MAJOR`, `MINOR`), evidence and a suggested fix. A packet cannot
be `ACCEPTED` while it has open BLOCKER or MAJOR findings. See [WORKFLOW.md](WORKFLOW.md#findings).

## Protected and coordination paths

**Protected** paths can never be in a packet's `owns` and are flagged by `verify` and the guard: `.git/`, `.env`,
`.env.*` (except `.env.example`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `*credentials*.json`,
`client_secret*.json`, `token*.json`, `*.sqlite`, `*.sqlite3`, `*.db`, `secrets/`, plus `protected.globs` from config.

**Coordination** paths may be touched by any packet and never count as scope violations: `.baton/ledger/`,
`.baton/state/`, `.baton/views/`, plus the `coordination` list in config (use it for shared files like a changelog).

## Scope modes

`verify` compares changed files with the packet's `owns`:

- `git-branch`: HEAD is on a non-main branch. Exact: everything changed since the begin commit.
- `git-shared`: HEAD is on main in a shared tree. Dirty files plus commits since base; files other agents are editing
  concurrently cannot be attributed, so use worktrees or branches when several agents run at once.
- `snapshot`: no git. A file fingerprint taken at `begin` is diffed.

## Where files live

| Path | Tracked | Purpose |
|---|---|---|
| `.baton/config.json` | yes | roster, test command, lease, guard mode, branches |
| `.baton/plan.json` | yes | tracks, packets, gates, milestones |
| `.baton/ledger/` | yes | event mirror |
| `.baton/runtime/` | yes | vendored copy of baton, so no install is needed |
| `.baton/manifest.json` | yes | every file baton wrote, with its SHA-256 |
| `.baton/prompts/` | yes | role prompts for agents without native commands |
| `.baton/agents.json` | yes | your custom agent declarations (never touched by baton) |
| `.baton/proposals/` | optional | plans proposed by `split --run`, not yet applied |
| `.baton/state/`, `.baton/views/` | no (git-ignored) | local state, generated views |
