[Agent Baton](../README.md) / [Docs](../README.md#documentation) / Workflow

# Workflow

The full packet lifecycle, who may do what, and what happens when things go wrong. Terms are defined in
[CONCEPTS.md](CONCEPTS.md); every command is in [COMMANDS.md](COMMANDS.md). `baton` below means
`node .baton/runtime/bin/baton.js`.

<div align="center">
<img alt="Agent Baton workflow" src="../assets/diagram-workflow.svg" width="100%">
</div>

## The protocol every agent follows

The same nine rules are written into `AGENTS.md` and every adapter file by `init`:

1. Session start: `baton check`, then `baton next --agent <me>`. The ledger decides what is ready, not memory or chat.
2. `baton begin <packet> --agent <me>` before the first write. Touch only the packet's `owns` files plus coordination
   paths. Need another file? Post a `REQUEST` on the bus or ask the orchestrator. Never edit it.
3. Work until every done check is true. Blocked: `baton block` with a specific question, then take a stretch packet or
   run `next` again. Long work: `baton heartbeat`.
4. Sign-off: `baton verify <id>`, paste real command output into the PR or handoff note, then `baton submit`.
5. A different agent reviews and records a verdict with evidence.
6. Auditors file findings and never edit audited files. Authors fix and resolve; filers confirm.
7. Repeated rejections escalate to the orchestrator.
8. The orchestrator plans, assigns, keeps the queue deep, rotates reviewers, **commits the final ledger events onto the integration branch**, and closes the day with `digest`.
9. Empty queue: audit mode.

## Roles

| Role | Does | Must not |
|---|---|---|
| orchestrator | `split`, `plan add/edit/import/rm`, `assign`, `reassign`, `carry`, `merge`, `dispatch`, `digest`, `worktrees` | override repo rules or human gates; edit the plan while acting as a worker |
| worker | `begin`, edit owned files, `verify`, `submit`, fix findings | touch files outside `owns`; review own work |
| reviewer | `review`, `accept`, `fix`, `reject`, `finding add` | be the author or a contributor of the packet |
| auditor | `finding add` against accepted work | edit the audited files |
| human | opens and closes gates, can act as orchestrator | |

Only the orchestrator or `human` may write the plan. Setting neither `--by` nor `BATON_AGENT` counts as a human at the
keyboard.

## 1. Plan

```bash
baton split "Ship invoice export" --run claude --dry-run   # see the command
baton split "Ship invoice export" --run claude             # proposal in .baton/proposals/
baton plan import .baton/proposals/<ts>.json --dry-run     # validate without writing
baton plan import .baton/proposals/<ts>.json
baton assign                                               # fill missing authors and reviewers
baton check
```

Plan rules (enforced on every write, a change that adds errors is refused):

- ids are unique and match `^[A-Za-z0-9][A-Za-z0-9_.-]*$`;
- agents and reviewers are in the roster, and the reviewer is not the author;
- dependencies exist and have no cycle;
- `owns` is non-empty, repo-relative, without `..`, and contains no protected path;
- packets that can run concurrently must not overlap in `owns`: a warning inside one track, an error across tracks;
- track `owns` may not overlap another track's.

`baton assign` picks an author (track owner, strength overlap with the packet text, lowest load) and a reviewer (needs
the reviewer role, never the author, fewest reviews so far, rotating). It is deterministic. `--only-unassigned` fills
blanks only; otherwise it also repairs conflicts. `plan graph [--mermaid]` draws dependencies.

The orchestrator should keep the horizon at least a few packets deep; `baton digest` warns when fewer than three
packets are ready.

## 2. Start

```bash
baton begin WP-001 --agent codex
```

`begin` checks, in order: the agent may take the packet, dependencies, gates, and file-ownership clashes with other
in-progress packets. Then it takes a lease, snapshots the tree, posts a `CLAIM` and (in git) records the base commit.

Dependency rules:

- A same-track dependency blocks starting until it is `READY_FOR_REVIEW` or accepted.
- A cross-track dependency never blocks, but flags the packet `AT_RISK`.
- A dependency in `needs_done` must be `ACCEPTED` first.
- A closed `gate` blocks starting (default `gate_mode: start`).

Create the packet branch **from the current integration branch tip** (not a stale or unrelated feature branch):
`git switch main && git pull --ff-only && git switch -c baton/<packet-id>-<slug>`.
Work on a branch named `baton/<packet-id>-<slug>` (the default `branches.packetPrefix` is `baton/`). That makes
`verify` exact (`git-branch` mode) and lets the CI workflow find the packet.

`begin --pull` takes a packet assigned to someone else; it is announced on the bus.

## 3. Build and block

Stay inside `owns`. If you must change something else, post a request:

```bash
baton bus post --from codex --to claude --type REQUEST --packet WP-001 --text "need src/api/index.js exported"
```

Stuck on a question only a human or another agent can answer:

```bash
baton block WP-001 --agent codex --reason "no sample data" --question "Where is the fixture?"
baton next --agent codex          # take a stretch packet or other work
baton begin WP-001 --agent codex  # BLOCKED -> IN_PROGRESS when unblocked
```

Long work: `baton heartbeat WP-001 --agent codex` extends the lease.

### Stale leases

When a lease expires the packet shows `STALE`. Any agent may take over with `baton reclaim WP-001 --agent <me>`; the
reclaim is announced on the bus. `baton check` warns about stale leases and `baton next` lists the ones you could
reclaim.

## 4. Verify

```bash
git add -A && git commit -m "..."
baton verify WP-001
```

`verify` runs, in order of concern:

1. Scope guard: every changed file must be inside `owns` or a coordination path. Protected paths are violations. In
   `git-branch` mode another packet's file is a violation too; in `git-shared` and `snapshot` it is reported as
   foreign.
2. Secret scan of changed files, plus the added lines of commits since the base in branch modes. Patterns cover AWS
   keys, private keys, Google keys, GitHub tokens, Slack tokens, OpenAI and Anthropic `sk-` keys and generic
   `token`/`secret` assignments. A deliberate false positive is marked with `baton:allow-secret` on the same line.
3. The test command (`config.test.command`, or the packet's own `test`), run through the shell with a timeout; the last
   20 lines of output are kept.
4. A dirty-tree check after the tests, so files the tests create are caught.

It writes a verify marker and a `verify` event. `--no-tests` checks scope and secrets only and can never be submitted.

## 5. Submit

```bash
baton submit WP-001 --agent codex --note "all done checks true"
```

Requires a passing marker that is current: clean tree, HEAD equal to the verified commit. It moves the packet to
`READY_FOR_REVIEW` and posts a sign-off with the test tail and commit.

If you change anything afterwards you must verify again. The author may reopen a packet in review with `begin`, which
discards the marker.

## 6. Review

Reviews are the heart of the workflow. The rules:

- The assigned reviewer records the verdict, and never a contributor or author of the packet
  (`requireDifferentReviewer` defaults to true).
- The reviewer works from the exact reviewed commit: `baton review WP-001` prints the brief with the diff and
  checkout commands, the done checks, the verify result and open findings.
- Run the checks yourself. Do not trust the sign-off note.
- A verdict needs evidence: a `file:line` or a failing command.

```bash
baton review WP-001
baton accept WP-001 --by claude --score 9 --note "checked on 3c2e78e"
baton fix    WP-001 --by claude --note "rename X; add test for Y"      # ACCEPTED_WITH_FIXES
baton reject WP-001 --by claude --note "export drops empty invoices"   # REJECTED
baton reassign WP-001 --reviewer gemini --by claude                    # orchestrator, undecided packets only
```

- `accept` is refused while the packet has open BLOCKER or MAJOR findings.
- `reject` needs a note or at least one finding.
- `fix` (accept with fixes) leaves the packet with its author, who fixes, re-verifies, resubmits, and the reviewer then
  accepts. It may also be moved back to `IN_PROGRESS`.
- `--score 0-10` feeds the scoreboard.

### Findings

```bash
baton finding add --packet WP-001 --by codex --severity MAJOR --text "off-by-one in page loop" \
  --file src/api/export.js --line 42 --evidence "npm test -- export: 1 failing" --fix "use <= not <"
baton finding list --packet WP-001 --open
baton finding resolve AUD-001 --by claude --resolution fixed --note "see 9f1c2a0"   # the author of the fix
baton finding resolve AUD-001 --by codex --confirm                                  # the filer closes it
```

Severities: `BLOCKER`, `MAJOR`, `MINOR`. Resolutions: `fixed`, `wontfix`, `invalid`. A finding stops blocking
acceptance only when the filer confirms it, or the filer marks it `invalid`. `finding list --open` means "not closed", so it
includes findings that are resolved but not yet confirmed.

## 7. Rejection, carry-over and escalation

```
REJECTED -> IN_PROGRESS   the author reworks (begin)
REJECTED -> CARRIED_OVER  the orchestrator parks it, possibly for another author (carry)
```

```bash
baton carry WP-001 --by claude --note "split the exporter in two"
```

Each rejection counts. After `escalateAfterRejections` rejections (default 2) a packet that is not done is flagged
`ESCALATE`; `baton check` warns, `baton digest` lists it under attention and the orchestrator must decide: hand it to a
different author, change the reviewer, split it, or rewrite its done checks.

## 8. Handoff

```bash
baton handoff WP-001 --to gemini --by codex --note "export done, tests pending; fixtures in tests/fixtures"
```

For a packet that is not in progress this reassigns the author. For one in progress it releases the lease and hands over
with your context; a `HANDOFF` message goes to the bus. The orchestrator may hand off any packet. The new author then
runs `begin`.

## 9. Land it

```bash
baton merge WP-001 --by claude
```

Needs an `ACCEPTED` packet with a recorded commit, run by the orchestrator or a human. It only fast-forwards main
(`git merge --ff-only` where main is checked out, otherwise it moves the ref); it never creates merge commits and
refuses if main moved. In that case `baton sync` rebases the current branch onto main (it aborts on conflict and leaves
the branch untouched), then verify and review again.

`baton worktrees --create` gives each track its own branch (`track/<id>`) and directory, so agents never share a
working tree; all worktrees share one ledger store.

## 10. Audit mode

When `baton next` has no build work left it lists **audit targets**: finished or in-review packets worth a second look (read-only). Auditors:

1. read the accepted work and its verify result,
2. run the checks themselves,
3. file findings with `baton finding add` (never edit the audited files),
4. the author fixes and resolves, the auditor confirms.

If even audit has nothing to do, `next` prints `HORIZON EXHAUSTED` and the exact command to ask the orchestrator for
more packets.

## 11. Gates and releases

```bash
baton gate list
baton gate open G1 --by human --note "key provisioned"
baton release            # per milestone: done / in review / total, due date, gates
```

Accepted packets count as done; packets in review are counted separately; stretch packets are excluded.

## Day open and day close (orchestrator)

```bash
baton digest          # what changed since the last digest, what needs attention
baton digest --since all --no-mark
baton render          # refresh .baton/views/*.md
```

## Exit codes

`0` ok, `1` a rule was violated or a check failed, `2` usage error, `3` internal error. Errors go to stderr; `--json`
output goes to stdout as exactly one document.

## Publishing final events and working across worktrees

`merge` moves the integration branch to the reviewed implementation commit. The later verification, sign-off, verdict
and merged events remain in the Git-common-directory local store until published; they are **not** in that commit.
After merging, switch to (or use) the integration-branch worktree, run `baton ledger export` and
`baton ledger verify`, inspect `git diff --cached` after `git add .baton/ledger/`, then commit and push the
ledger-only changes. Fresh clones must see the persisted events before trusting their packet status.

Only worktrees of **one Git clone** share the local event store; `.baton/plan.json` remains branch-specific.
If an orchestrator publishes new assignments on `main`, each idle worker must update its worktree's plan from
`main` (for example `git merge --ff-only main` where legal), or use a new worktree created from updated
`main`, **before** calling `baton next`. Do not assume that events alone update packet definitions.

Accepted packets cannot be reverified after `sync`. If main moved, create and independently verify a new
replacement packet based on its current tip. The original accepted packet remains historical and **unmerged**.

For cloud dispatch, create the destination repository's `baton` label with
`gh label create baton --repo owner/name --color 0969da` (substitute the destination repository). Ensure
`--to` matches the assigned worker's provider kind and its runner uses the **exact** roster ID before dispatch. Author changes require `baton handoff` and an independent reviewer.
