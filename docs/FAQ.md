[Agent Baton](../README.md) / [Docs](../README.md#documentation) / FAQ

# FAQ

## What is it, in one sentence?

A zero-dependency CLI that gives several AI coding agents a shared plan, exact file ownership, a verify gate,
independent review and a git-mergeable audit trail, installed into your repo with one command.

## Do I need to install anything?

Only Node 18 or newer (and git for the full experience). `npx github:BhurkeSiddhesh/agent-baton init` runs straight from
GitHub; `npx agent-baton init` will work once the package is on npm. `init` vendors a copy of baton into
`.baton/runtime/`, so after that every agent and CI job runs `node .baton/runtime/bin/baton.js ...` with no install and
no network.

## If I create a GitHub issue or type a feature request, will agents automatically start and open a PR?

**No, not in the current CLI.** A goal can become a planning prompt or an agent-produced proposal, which still needs explicit import and assignment. A worker session must be started by you or by an independently configured provider integration. `baton next` tells that running agent which packet is available; `dispatch` creates an issue and does not guarantee a remote executor runs. A separate review and verified GitHub integration are needed for a PR to be ready. See the [end-to-end walkthrough](../README.md#from-a-feature-request-to-merged-code-who-orchestrates-and-how-do-agents-pick-up-work) and [roadmap](ROADMAP.md).

## Does it call any AI or network service?

No. Baton makes no network calls and holds no credentials. `baton dispatch` runs your own `gh`, and
`baton split --run` runs your own agent CLI; both support `--dry-run` and neither is needed for normal use.

## Does it work without git?

Yes. Scope checking falls back to a file fingerprint (`snapshot` mode) and state goes to `.baton/state/`. Branch-exact
scope, `sync`, `merge`, `worktrees` and history secret scans need git.

## Does it work on Windows?

Yes: Windows, macOS and Linux, Node 18, 20 and 22 are tested in CI. Paths are normalised to forward slashes internally and
no command assumes `sh`. `init` writes `.baton/baton.cmd` next to the `sh` shim. Test output is decoded as UTF-8, so
OEM-codepage output from `cmd` may look garbled.

## Which agents are supported?

Claude Code, Codex CLI, Gemini CLI, Antigravity, Cursor, GitHub Copilot, Windsurf, Cline, Aider and OpenCode have built-in
adapters; anything else can be declared as a custom agent or used through `baton prompt`.
See [AGENTS.md](AGENTS.md).

## Will it overwrite my AGENTS.md or CLAUDE.md?

No. It adds a managed block delimited by `<!-- baton:begin vN -->` and `<!-- baton:end -->` and leaves everything else in
the file alone. Re-running replaces only the block. Standalone generated files are replaced only if you have not edited
them; otherwise a `<file>.baton-new` sidecar is written and you merge by hand.

## How do I see what init will do first?

`baton init --dry-run` prints every file and action and writes nothing.

## How do I uninstall?

`baton uninstall --dry-run`, then `baton uninstall --yes`. It removes manifest-tracked files whose content still matches
what baton wrote, strips unedited managed blocks, and removes the hook entry and `package.json` script. Files you edited are
kept and listed. Without `--keep-ledger` it also deletes `.baton/config.json`, `plan.json`, the ledger, state and views.
`.baton/agents.json` is never touched.

## How do I upgrade?

Run the newer baton: `npx github:BhurkeSiddhesh/agent-baton upgrade` (or `npx agent-baton upgrade`). It refreshes the
vendored runtime, managed blocks and adapter files, and reports what changed. `baton doctor` warns when the vendored
runtime and the package differ.

## Why can't a reviewer be the author?

Review is only worth something when it is independent. `requireDifferentReviewer` (default true) forbids a reviewer who
authored or contributed to the packet, and `baton assign` rotates reviewers so one agent does not review everything.

## What stops an agent from editing files outside its packet?

Three layers: the agent protocol (told in `AGENTS.md` and every adapter file), `baton verify` (fails on out-of-scope
and protected files, so `submit` is impossible), and optionally the guard hook (`init --hooks`, then
`guard.mode: "block"` in config) which denies the edit before it happens inside Claude Code. CI repeats the scope check for
`baton/<packet>` branches when you use `--cloud`.

## Can an agent just lie about being done?

It cannot submit without a passing verify on the exact commit, and the reviewer re-runs the checks. Findings need
evidence. The scoreboard shows rejections, rework and first-pass acceptance per agent, so unreliable sign-offs are visible.

## What if two agents edit the same file?

The plan validator rejects overlapping `owns` between packets that can run at the same time across tracks (a warning
within a track), and `begin` refuses to start a packet whose files overlap an in-progress one. Use `baton worktrees` so
agents never share a working tree.

## What does a human do?

Writes or approves the plan, opens gates (`baton gate open G1 --by human`), resolves escalations and decides when to
merge. Humans can act as orchestrator by omitting `--by`, or using `--by human`.

## Is the ledger safe to commit?

Yes. It contains packet ids, agent ids, timestamps, notes, commit hashes and findings, never file contents. Each event
has a SHA-256, and the secret scan blocks credentials from reaching a commit through a packet. Do not paste secrets into
notes: they would be stored in the ledger.

## Why one file per event?

So parallel branches never conflict. Two agents appending events create different files and git merges them. See
[CLOUD.md](CLOUD.md#why-merging-is-conflict-free).

## What happens when an agent crashes mid-packet?

Its lease expires (default 8 hours), the packet is flagged `STALE`, and any agent may `baton reclaim` it. Nothing is lost:
the claim, any commits and the bus messages are still there.

## Can the plan change during a project?

Yes, by the orchestrator: `plan add`, `plan edit`, `plan import`. Packets that have started keep their author, reviewer,
owns, track and dependencies. Use `handoff` or `reassign` to change people.

## Can I run it in a monorepo?

Yes. Put tracks on subtrees (`services/api/`, `apps/web/`) and give each track an owner; the default test command can be
overridden per packet with `test`.

## How do I add my own agent?

See [AGENTS.md](AGENTS.md#adding-a-custom-agent).

## Where do I report a bug or a security problem?

Bugs and ideas: [GitHub issues](https://github.com/BhurkeSiddhesh/agent-baton/issues). Vulnerabilities: follow
[SECURITY.md](../SECURITY.md). Stuck: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
