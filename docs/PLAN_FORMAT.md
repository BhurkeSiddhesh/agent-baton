[Agent Baton](../README.md) / [Docs](../README.md#documentation) / Plan format

# Plan and config format

Reference for `.baton/plan.json` and `.baton/config.json`. Both are plain JSON, tracked in git, with stable key order and
two-space indentation. Edit the plan with `baton plan ...` (it validates every write and refuses a change that adds
errors) or by hand followed by `baton check`.

## plan.json

```json
{
  "version": 1,
  "goal": "Ship invoice export",
  "tracks": [
    { "id": "api", "owner": "codex", "theme": "HTTP API and persistence", "owns": ["src/api/", "tests/api/"] }
  ],
  "gates": [
    { "id": "G1", "title": "Prod API key provisioned", "owner": "human", "open": false }
  ],
  "milestones": [
    { "id": "M1", "title": "Alpha", "due": "2026-11-01" }
  ],
  "packets": [
    {
      "id": "WP-001",
      "title": "Invoice CSV exporter",
      "track": "api",
      "agent": "codex",
      "reviewer": "claude",
      "owns": ["src/api/export.js", "tests/api/export.test.js"],
      "reads": ["docs/DATA_CONTRACT.md"],
      "deps": [],
      "needs_done": [],
      "gate": null,
      "gate_mode": "start",
      "priority": "P0",
      "milestone": "M1",
      "stretch": false,
      "test": null,
      "description": "What and why, in free text.",
      "done_checks": ["Exporter handles empty invoices", "Tests green"]
    }
  ]
}
```

The empty starter written by `init` is `{ "version": 1, "goal": "", "tracks": [], "gates": [], "milestones": [], "packets": [] }`.

### Top level

| Field | Type | Notes |
|---|---|---|
| `version` | number | always `1` |
| `goal` | string | one sentence, shown in prompts and views |
| `tracks` | array | see below; create one with `baton plan track add --id <id> --owner <agent> --owns <paths>`, or declare tracks here or in an imported plan |
| `gates` | array | human decisions |
| `milestones` | array | `due` is an ISO date, compared with today (`BATON_NOW` aware) by `release` |
| `packets` | array | the work |

### Track

| Field | Notes |
|---|---|
| `id` | unique |
| `owner` | roster id; the default author for packets in the track |
| `theme` | free text |
| `owns` | repo-relative paths; may not overlap another track's |

### Gate

| Field | Notes |
|---|---|
| `id` | referenced by packets |
| `title` | what the human must decide |
| `owner` | who may open or close it (`human` or a roster id) |
| `open` | `false` until `baton gate open <id> --by <owner\|human>` |

Opening and closing are recorded as `gate` events; the live state is derived, not read from `open`.

### Packet

| Field | Required | Notes |
|---|---|---|
| `id` | yes | unique, `^[A-Za-z0-9][A-Za-z0-9_.-]*$`. `plan add` assigns the next `WP-nnn` when `--id` is omitted |
| `title` | yes | |
| `track` | no | must exist in `tracks` |
| `agent` | no | author; `baton assign` can fill it |
| `reviewer` | no | must differ from `agent` when `requireDifferentReviewer` is true; must have the reviewer role |
| `profile` | no | permission profile (`workspace-write`, `read-only`, `review-only`, `privileged`); default `workspace-write`. `privileged` requires orchestrator role |
| `owns` | yes | non-empty list of repo-relative files or directories (trailing `/` means a directory) |
| `reads` | no | files worth reading first; not enforced |
| `deps` | no | packet ids; same-track deps block starting until they are in review or accepted; cross-track deps flag `AT_RISK` |
| `needs_done` | no | packet ids that must be `ACCEPTED` before this one starts |
| `gate` | no | gate id, or `null` |
| `gate_mode` | no | `start` (default: gate must be open to begin) or `live_only` (only live or production work is restricted) |
| `priority` | no | `P0` highest to `P3`; default `P2` |
| `milestone` | no | milestone id |
| `stretch` | no | optional extra work, offered only when nothing else is ready; excluded from `release` totals |
| `test` | no | test command for this packet; overrides `config.test.command` |
| `description` | no | what and why |
| `done_checks` | no | statements that must all be true; shown to the reviewer |

`baton plan add` flag names map as: `--owns` to `owns`, `--needs-done` to `needs_done`, `--gate-mode` to `gate_mode`,
`--check` (repeatable) to `done_checks`, `--stretch` to `stretch`. See [COMMANDS.md](COMMANDS.md#baton-plan).

### Glob and path rules

`owns` entries are literal paths, directory prefixes (trailing `/`), or patterns using `*` (within a segment), `**`
(across segments) and `?`. Matching is deterministic. They must not be absolute, contain `..`, or match a protected path
(see [CONCEPTS.md](CONCEPTS.md#protected-and-coordination-paths)).

### Validation rules

`baton plan validate` and `baton check` enforce:

- unique, well-formed ids; known tracks, agents, reviewers, gates, milestones;
- reviewer is not the author; owners and reviewers have suitable roles;
- `deps` and `needs_done` exist and form no cycle;
- `owns` non-empty, repo-relative, no `..`, no protected path;
- packets that can run concurrently do not overlap in `owns`: a **warning** in the same track, an **error** across
  tracks. Overlap is allowed when one depends, transitively, on the other;
- track `owns` do not overlap another track's (error); a packet's `owns` outside its track's `owns` is a warning;
- `priority` is one of `P0` to `P3`.

Fields that identify a started packet (`owns`, `agent`, `reviewer`, `track`, `deps`) cannot be edited once it has
history, and a packet with history cannot be removed. Use `handoff`, `reassign` or a new packet.

## Proposals and import

`baton plan import <file|->` accepts any of: a full plan, `{ "plan": { ... } }`, a bare array of packets, or
`{ "packets": [ ... ] }` (a *proposal*). Default mode is `--merge`: new packets are added, colliding or missing ids are
renumbered (and dependencies inside the proposal rewritten). `--replace` swaps in the provided packets and lists but
refuses to drop a packet that already has history. `--dry-run` validates and prints the result. `-` reads stdin.

`baton split --run <agent>` writes proposals to `.baton/proposals/<timestamp>.json` even when invalid, so you can fix them
by hand, and keeps the raw agent output as `.raw.txt` on failure.

## config.json

```json
{
  "version": 1,
  "project": { "name": "my-repo", "description": "", "stack": ["node"] },
  "orchestrator": "claude",
  "agents": [
    { "id": "claude", "name": "Claude", "kind": "claude",
      "roles": ["orchestrator", "worker", "reviewer", "auditor"],
      "strengths": ["architecture", "security", "review"] },
    { "id": "codex", "name": "Codex", "kind": "codex",
      "roles": ["worker", "reviewer", "auditor"],
      "strengths": ["backend", "tests", "integration"] }
  ],
  "test": { "command": "npm test", "required": true, "timeoutSeconds": 900 },
  "protected": { "globs": [] },
  "coordination": [],
  "lease": { "hours": 8 },
  "escalateAfterRejections": 2,
  "requireDifferentReviewer": true,
  "branches": { "main": "main", "trackPrefix": "track/", "packetPrefix": "baton/" },
  "guard": { "mode": "warn" },
  "ledger": { "mirror": true },
  "runtime": { "vendored": true, "command": "node .baton/runtime/bin/baton.js" }
}
```

| Field | Meaning |
|---|---|
| `project` | name, description and detected stack; used in prompts |
| `orchestrator` | roster id allowed to write the plan, assign, carry and merge |
| `agents[]` | `id` (`[a-z0-9_-]+`), `name`, `kind` (adapter id or `custom`), `roles`, `strengths` (used by `assign`) |
| `test.command` | run by `verify` through the shell; empty means none was detected (and `required` is false) |
| `test.required` | when `false` and no test command is configured, `verify` passes without running tests; when `true`, a missing command is a problem |
| `test.timeoutSeconds` | kills the whole process tree after this long |
| `protected.globs` | extra protected paths, added to the built-in list |
| `coordination` | extra paths any packet may touch, for example `CHANGELOG.md` |
| `lease.hours` | lease length granted by `begin` and `heartbeat` |
| `escalateAfterRejections` | rejections before the `ESCALATE` flag; integer >= 1 |
| `requireDifferentReviewer` | reviewer may not be the author or a contributor |
| `branches.main` | the integration branch for `merge`, `sync` and scope modes |
| `branches.trackPrefix` | branch prefix for `worktrees` (`track/<id>`) |
| `branches.packetPrefix` | packet branch prefix, `baton/` by default; the CI template assumes `baton/` |
| `guard.mode` | `off`, `warn` (default) or `block`, used by `baton guard` and the Claude hook |
| `ledger.mirror` | write each event also to the tracked `.baton/ledger/` |
| `runtime` | whether the runtime is vendored and the command agents run |

Newer versions of baton refuse to write a ledger or config written by a newer version than their own.
