[Agent Baton](../README.md) / [Docs](../README.md#documentation) / Cloud agents

# Cloud agents

Local agents and cloud agents (Claude Code in GitHub Actions, Copilot coding agent, Codex cloud, anything that works in a
fresh clone) follow the same protocol and share state through the tracked ledger mirror. Baton itself makes no network
calls: the only network-adjacent commands, `dispatch` and `split --run`, shell out to your own `gh` and agent CLIs.

## How state travels

The ledger is stored twice:

- the **local shared store** in the git common directory (`.git/baton/`), which makes claims visible immediately to
  every worktree of one clone;
- the **tracked mirror** `.baton/ledger/`, one JSON file per event, written on every append while
  `config.ledger.mirror` is true (the default).

A cloud agent starts in a fresh clone, which has no local store. It reads the mirror alone and sees full history. When it
appends events (`begin`, `verify`, `submit`, bus messages), the new files appear under `.baton/ledger/`, and it commits
them with its work. Those paths are coordination paths, so they never count as scope violations.

### Why merging is conflict-free

Every event is its own file with a unique, time-sortable id (`YYYYMMDDTHHMMSSZ-<6 hex>`). Two branches that both add
events add different files; git merges them without conflicts. Nothing ever edits an existing event. Each file also
carries a SHA-256 of its own content, so `baton check` and `baton ledger verify` detect tampering. A deleted file cannot
be detected from one copy, which is the reason for the second copy in the local store.

### Syncing a local clone with merged cloud work

After you pull or merge branches that carry events:

```bash
baton ledger verify      # hashes, and local/mirror agreement
baton ledger import      # copy valid events from .baton/ledger/ into the local store
baton ledger export      # the other way: copy local events missing from the mirror
```

`baton status`, `next` and the rest read the union of both stores, so even without `import` the derived state is right;
`import` makes the local store complete. `baton check` warns about unsynced copies.

## Branch naming

Work on a branch named `baton/<packet-id>-<slug>`, for example `baton/WP-007-csv-export`. The prefix comes from
`config.branches.packetPrefix` (default `baton/`). It matters for three reasons:

1. `verify` is exact on a non-main branch (`git-branch` mode: everything since the begin commit).
2. The CI workflow resolves the packet from the branch name: `baton/<id>` or `baton/<id>-...` matched against plan ids.
   The CI template assumes the prefix stays `baton/`.
3. Reviewers and `baton merge` use the recorded commit of that branch.

Track branches (`track/<track-id>`, from `baton worktrees --create`) are separate: they give each track a long-lived
branch and directory for local agents.

## Dispatching a packet

```bash
baton dispatch WP-007 --dry-run                     # print the command and issue body, change nothing
baton dispatch WP-007 --to claude                   # create the issue; an authorized human must comment @claude to start
baton dispatch WP-007 --to copilot                  # assigns the issue to Copilot instead of an @mention
baton dispatch WP-007 --to codex --repo me/project  # mention @codex
baton dispatch WP-007                               # --to any (default)
```

`dispatch` runs `gh issue create --body-file -` with the label `baton`; create the label once:
`gh label create baton`. The issue body is the packet brief: title, description, owned files, reads, done checks,
dependencies and the exact commands the agent must run. The orchestrator posts a `NOTICE` on the bus (not on
`--dry-run`). Authenticate `gh` yourself; baton never sees a token.

## GitHub workflows (`init --cloud`)

`baton init --cloud` writes four files under `.github/` (re-running is safe, existing edited files get a `.baton-new`
sidecar):

| File | Trigger | What it does |
|---|---|---|
| `.github/workflows/baton-ci.yml` | pull requests, pushes to main | `baton check`; for a `baton/<packet>` branch also `verify --no-tests` (scope guard and secret scan) and your test command; renders `STATUS.md` into the job summary |
| `.github/workflows/baton-claude.yml` | `@claude` in an OWNER/MEMBER/COLLABORATOR issue or PR-review comment only | runs a commit-pinned Claude action with `BATON_AGENT=claude` and a system prompt that tells it to follow `AGENTS.md`, begin a packet, stay in scope, verify and submit |
| `.github/workflows/baton-dispatch.yml` | issue labelled `baton` | comments the cloud-agent instructions (read `AGENTS.md`, `check`, `begin --pull`, stay in `owns`, `verify`, `submit`, open a PR from `baton/<packet>`) |
| `.github/PULL_REQUEST_TEMPLATE.md` | pull requests | sign-off checklist: packet id, pasted verify output, findings; written only if you have none |

### Claude Code in Actions

Prerequisites: install the Claude GitHub app on the repository and add the repository secret `ANTHROPIC_API_KEY`
(Settings, Secrets and variables, Actions). The workflow references the secret and never inlines it. Then comment
`@claude take WP-007` on an issue from a trusted repository member/collaborator. `baton dispatch WP-007 --to claude` **only creates an issue**; a trusted person must comment afterward to trigger the agent. The comment author must also have actual GitHub write access (enforced by Claude Code Action). Opening an issue with `@claude` in its body or title, or commenting from a FIRST_TIME_CONTRIBUTOR/NONE association, does not start the write-capable job.

### Copilot coding agent

Assign an issue to Copilot (or `baton dispatch <id> --to copilot`). Copilot reads `.github/copilot-instructions.md` and
`AGENTS.md`, both written by `init` when `copilot` is in the roster. Its branch should follow the `baton/` prefix; if
it does not, rename it or add the packet id to the PR so a human can link it.

### Codex cloud

Codex reads `AGENTS.md`. Mention `@codex` through `dispatch --to codex` or start a task manually, and give it the same
instructions as the issue body. Set `BATON_AGENT=codex` in the environment settings so every command is attributed.

### Any other cloud agent

It only needs: a clone with `.baton/`, Node 18+, the packet brief, and its roster id in `BATON_AGENT`. Nothing needs to
be installed because the runtime is vendored in `.baton/runtime/`.

## A cloud packet end to end

1. Orchestrator: `baton dispatch WP-007 --to claude` creates an issue with the brief. A trusted repository member comments `@claude take WP-007` before cloud execution begins.
2. The cloud agent checks out a branch `baton/WP-007-csv-export`, runs `baton check`, then
   `baton begin WP-007 --agent claude --pull` if the packet is assigned to someone else (announced on the bus).
3. It edits only the packet's files, commits, runs `baton verify WP-007`, then `baton submit WP-007 --agent claude`.
4. It pushes the branch with the new `.baton/ledger/*.json` files and opens a pull request with the verify output.
5. CI runs `baton check` and the scope guard for that branch.
6. The assigned reviewer (a *different* agent, possibly local) fetches the branch, runs `baton ledger import`, then
   `baton review WP-007` and `baton accept|fix|reject WP-007 --by <reviewer>`. The verdict is another ledger file that
   goes onto the branch or main.
7. The orchestrator runs `baton merge WP-007 --by <orchestrator>` or merges through the PR; main then carries the events.

## Generated workflow security boundary

`init --cloud` generates pinned GitHub Actions dependencies (recorded SHA and matching release version) to avoid tag drift. Update SHAs only after reviewing upstream release notes and re-running integration tests; these are snapshots and require periodic security maintenance. The Claude trigger runs only for `issue_comment` and `pull_request_review_comment` events with `OWNER`, `MEMBER` or `COLLABORATOR` association and an explicit `@claude` mention. Its token and `ANTHROPIC_API_KEY` remain available **only within that authorized job**; do not add `pull_request_target`, `workflow_run`, fork checkout, or arbitrary user-controlled shell interpolation. `id-token: write` is required for the provider action's GitHub authentication workflow, not for Baton's offline core. An association is not a GitHub permission proof; the provider action performs an additional write-permission check. The workflow cannot stop a trusted maintainer from relaying malicious content to an agent; restrict runner secrets and require separate code review and branch protection.

## Limits to know

- Two copies of the ledger can briefly disagree until `ledger import`/`export`; the union is always authoritative.
- If main moves while a packet is in review, `merge` refuses (fast-forward only). `baton sync` rebases the branch; then
  verify and review again.
- Cloud agents run with the permissions you give the workflow. The workflow files request only the permissions they
  need and keep secrets in GitHub secrets.
- The Cursor guard hook and the Claude Code hook are local-editor features; in the cloud, `verify` and the CI check are
  the enforcement.

See also: [WORKFLOW.md](WORKFLOW.md), [AGENTS.md](AGENTS.md), [TROUBLESHOOTING.md](TROUBLESHOOTING.md#cloud).

## Dispatch prerequisites and attribution safety

For the **destination GitHub repository**, first run `gh auth login` and create the label once with
`gh label create baton --repo owner/name --color 0969da` (replace owner/name with the destination; skip if already
present). If dispatching without `--repo`, you may omit `--repo` from the label command when already inside the
actual destination repository. `baton init --cloud` writes workflow
files but does not create repository labels. Run `baton review WP-001` or inspect the plan's assignment before
`baton dispatch WP-001 --to <provider>`. The provider must match the packet's **assigned author's provider kind**;
`dispatch` refuses a mismatch even during dry-run and retains the exact assigned ID in the issue brief.
For a custom roster ID like `claude-a` with `kind: claude`, `--to claude` can generate the brief, but your
runner must set `BATON_AGENT=claude-a`. The generated `baton-claude` workflow currently hard-codes `claude`;
customize it before using it with custom IDs. To change author, use an authorized `baton handoff` and
ensure the assigned reviewer is different (reassign if necessary). A GitHub issue or `@claude` mention alone
does not confirm a runner has executed the packet.
