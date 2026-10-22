[Agent Baton](../README.md) / [Docs](../README.md#documentation) / Troubleshooting

# Troubleshooting

Start with `baton doctor`: it checks Node, git, config, plan, the test command, the vendored runtime, adapter files,
ledger integrity, agent CLIs and the guard hook, and exits 1 on errors. Then `baton check`. Add `--json` to either for
machine-readable output. Messages below are quoted from the tool.

Consult [tested platform compatibility](COMPATIBILITY.md) for Node/OS coverage, Windows shell reproduction and limitations around extended paths and Git version baselines.

## Installation

**`baton: not a baton project: .baton/config.json is missing`**
Run `baton init` first, or run the command from inside the repository (otherwise pass `--cwd <dir>`, before or after the command). Baton finds the
root by walking up to a directory with `.baton/config.json`.

**`npx` cannot find the package or fails to fetch from GitHub.**
Check Node >= 18 and network access to github.com, or clone the repository and run `node bin/baton.js init` from your
project directory. `npx agent-baton` works only after the package is published to npm.

**`init` skipped a file and wrote `<file>.baton-new`.**
You edited a generated file, so baton did not overwrite it. Diff the two, merge what you want, delete the sidecar. Use
`--force` to overwrite regardless.

**`agent X: kind "Y" has no adapter (declare it in .baton/agents.json)`**
The roster entry has a kind baton does not know. Use a built-in kind or declare a custom one, see
[AGENTS.md](AGENTS.md#adding-a-custom-agent).

**Cline adapter skipped.**
`.clinerules` exists as a file, but the adapter needs a directory. Move the file to `.clinerules/<name>.md` and re-run
`baton agents install --only cline`.

**The `.baton/runtime` is older than the package.**
`doctor` warns about this. Run `npx github:BhurkeSiddhesh/agent-baton upgrade`.

**`refusing to uninstall without confirmation`**
Not a TTY. Review with `baton uninstall --dry-run`, then pass `--yes`.

## Identity

**`unknown agent "x" (roster: claude, codex)`**
`--agent`/`--by`/`BATON_AGENT` must be a roster id (or `human`, `harness`). `baton agents list` shows the roster.

**`BATON_AGENT=claude but --agent codex was given`** (code `IDENTITY`)
The flag and the environment disagree. Unset one of them.

**`only the orchestrator (claude) or human may change the plan; acting as codex`**
Plan writes are for the orchestrator or a human. Post a `REQUEST` on the bus instead, or unset `BATON_AGENT` if you are
the human at the keyboard.

## Plan

**`refusing to write: the change introduces 1 plan error(s): WP-001: unknown track api`**
Create the track first: `baton plan track add --id api --owner codex --owns src/api/` (or declare it in `.baton/plan.json`, or `baton plan import` a file with a `tracks` array).

**`plan validate` reports overlapping `owns`.**
Two packets that can run together claim the same file. Split the file's work, add a `deps` edge so one runs after the
other, or narrow `owns`. Across tracks it is an error; in one track a warning.

**`no agent assigned` / `no reviewer assigned` warnings.**
Run `baton assign` (or `--only-unassigned`).

**`<id> is IN_PROGRESS; changing owns would break its claim, review or ownership`** (code `PACKET_STARTED`)
A started packet's `owns`, `agent`, `reviewer`, `track` and `deps` are frozen. Use `handoff`, `reassign`, or carry it over
and open a new packet.

**`split --run` produced no proposal.**
The output had no JSON object with `packets` (`NO_PROPOSAL`). The raw output is kept next to the proposal as `.raw.txt`. Use
`--dry-run` to see the exact command, make sure the agent CLI is on `PATH`, or run `baton split "<goal>" --out prompt.md`
and paste the prompt into the agent yourself, then `baton plan import` its answer.

## Starting and working

**`<id>: dependencies not yet ready: WP-00x`** (`DEPS_UNMET`)
A same-track dependency is not yet in review or accepted, or a `needs_done` dependency is not ACCEPTED.

**`<id>: human gate G1 is closed`** (`GATE_CLOSED`)
`baton gate open G1 --by human` after the decision is made.

**`<id>: file ownership overlaps in-progress packet(s) WP-00x`** (`OWNERSHIP_CLASH`)
Wait for the other packet or fix the plan so the files are disjoint.

**`<id> belongs to codex; pass --pull to take it`** (`NOT_YOURS`)
Use `begin --pull` to take it (it is announced on the bus), or ask the orchestrator to `handoff` it.

**`<id> is already in progress (by x); use "baton reclaim" if its lease is stale`**
Only reclaim after the lease expired. `baton status` shows `STALE` and the lease time. Hold on to a lease with
`baton heartbeat`.

**`<agent> is the reviewer of <id> and cannot work on it`** (`REVIEWER_CONFLICT`)
Author and reviewer must differ. `baton reassign <id> --reviewer <other> --by <orchestrator>`.

**The guard hook blocks an edit I need.**
The file is outside the packet's `owns`. Post a `REQUEST`, or have the orchestrator widen the packet (before it starts),
or add a shared file to `coordination` in config. Set `guard.mode` to `warn` to see violations without blocking.

## Verify and submit

**`Verify X: FAIL ... OUT OF SCOPE or PROTECTED`**
Revert the listed files or request them through the bus. Protected paths (env files, keys, databases) can never be
owned.

**`PROBLEM: uncommitted changes: commit first, so the tested tree is the reviewed commit`**
Commit, then verify again.

**A secret-scan hit on a harmless line.**
Add the comment `baton:allow-secret` on the same line. A real secret must be removed from history too: the scan covers
commits since the packet's base.

**`no test command configured (set test.command in .baton/config.json)`**
`init` could not detect one. Set `"test": { "command": "..." }` or `"required": false` in `.baton/config.json`, or give the
packet its own `test`.

**Tests pass locally but verify fails.**
Verify runs the command through the shell in the repository root with a timeout (`test.timeoutSeconds`, default 900).
A test that leaves new files behind fails the dirty-tree check that runs afterwards: ignore or clean those files.

**`<id>: run "baton verify <id>" successfully before requesting review`** (`NOT_VERIFIED`) and
**`HEAD moved since verify; run verify again`** (`STALE_VERIFY`)
`--no-tests` results can never be submitted, and any commit or edit after verify invalidates it. Verify again.

**`verify ... git-branch-rebased`**
The begin commit is no longer an ancestor of HEAD (you rebased), so baton used the merge base with main. This is
informational.

**Scope mode is `git-shared` and unrelated files show up.**
You are on main in a shared tree. Create a packet branch (`git checkout -b baton/<id>-slug`) or use `baton worktrees`.

## Review

**`only the assigned reviewer (codex) may record a verdict; got --by claude`**
Verdicts come from the assigned reviewer only. Orchestrator: `baton reassign`.

**`cannot accept with open BLOCKER/MAJOR findings: AUD-001`** (`OPEN_FINDINGS`)
The author resolves (`finding resolve AUD-001 --by <author> --resolution fixed`) and the filer confirms
(`finding resolve AUD-001 --by <filer> --confirm`).

**`a rejection needs a note or at least one finding`**
Pass `--note "..."` with evidence.

## Merging and git

**`main is not an ancestor of <commit>: not a fast-forward`** (`NOT_FAST_FORWARD`)
Main moved. On the packet branch run `baton sync`, then `verify`, `submit` and review again.

**`rebase of <branch> onto main hit conflicts and was aborted`**
Nothing changed. Run `git rebase main`, resolve by hand, then verify again.

**`commit or stash your changes before syncing`** / **`you are on main; sync is for track branches`**
`sync` refuses on main, detached HEAD or a dirty tree.

**`<id> has no recorded commit (shared-tree work); there is nothing to merge`**
The packet was worked on main in a shared tree, so there is no branch to merge.

**Line-ending warnings (`LF will be replaced by CRLF`) on Windows.**
Harmless git messages from `core.autocrlf`. Baton hashes ignore CRLF so it does not report files as modified; the generated
`.gitattributes` block pins the shim line endings. A rebase can rewrite line endings with `autocrlf=true`; consider
`git config core.autocrlf input`.

## Ledger and checks

**`baton check` reports a hash mismatch or edited event.**
An event file was changed after it was written. Restore it from git history (`git checkout -- .baton/ledger/<id>.json`)
or from the local store in `.git/baton/events/`, then `baton ledger verify`. Events of kind `ack` mark a known anomaly as acknowledged
(it is then reported as a warning); there is no CLI command for writing one yet.

**`the ledger was written by a newer baton`**
Upgrade the runtime: `npx github:BhurkeSiddhesh/agent-baton upgrade`.

**Local and mirror copies disagree** (`missing from the tracked mirror`)
`baton ledger export` copies local events into `.baton/ledger/`; `baton ledger import` does the reverse.

**Another process holds the lock.**
Baton uses a lockfile around local ledger writes. Only a dead PID **verified on this host**, or an incomplete lock file past its grace period, is recovered automatically with a diagnostic. A live PID lock is never broken because it is old; locks from an unverified remote host require manual inspection. If a lock persists, confirm the holder host/PID and stop or await the owner before removing the file. On shared/network filesystems use a dedicated coordinator: this advisory local lock is not distributed consensus.

<a id="cloud"></a>
## Cloud

**The cloud agent cannot see state.**
It sees only what is committed. Make sure `.baton/` (including `.baton/ledger/`) is pushed and `ledger.mirror` is true.

**CI says `baton check` failed on a PR.**
Run `baton check` locally on the branch. Usually a plan error or an edited ledger file.

**CI does not find the packet.**
The branch must be `baton/<packet-id>` or `baton/<packet-id>-<slug>`.

**`the GitHub CLI "gh" is not installed or not on PATH`** (`GH_MISSING`) /
**`gh issue create failed`** (`GH_FAILED`)
Install `gh` and run `gh auth login`. If the label is missing: `gh label create baton`. Preview with `baton dispatch <id> --dry-run`.

**`@claude` does nothing.**
The Claude GitHub app must be installed and the repository secret `ANTHROPIC_API_KEY` set; the workflow must exist on the
default branch. See [CLOUD.md](CLOUD.md#claude-code-in-actions).

## Still stuck

Run `baton doctor --json` and `baton check --json`, and open an issue at
https://github.com/BhurkeSiddhesh/agent-baton/issues with the output (remove anything private first). For a security
problem, see [SECURITY.md](../SECURITY.md).
