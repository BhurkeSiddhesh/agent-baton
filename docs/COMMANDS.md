[Agent Baton](../README.md) / [Docs](../README.md#documentation) / Commands

# Commands

Reference for every command, generated from the real `--help` output of baton 0.1.0. Below, `baton` is
shorthand for `node .baton/runtime/bin/baton.js` (or `npx agent-baton` outside an installed repo).

## Conventions

- `baton <command> --help` (or `-h`) prints the same help you see here; `baton help <command>` also works.
- `--cwd <dir>` runs as if started in `<dir>`. `--version` / `-v` prints the version.
- Query commands take `--json` and print exactly one JSON document on stdout; errors go to stderr.
- Colour is used only when stdout is a TTY and `NO_COLOR` is unset or empty.
- Identity: `--agent <id>` (alias `-a`) or the environment variable `BATON_AGENT`. Commands that record a decision
  take `--by` with `--agent` as an alias. Ids come from the roster plus `human` and `harness`.
- Exit codes: `0` ok, `1` rule violation or failed check, `2` usage error, `3` internal error.
- Environment: `BATON_AGENT` (identity), `BATON_NOW` (ISO time override, used by tests and for reproducible views),
  `BATON_TEMPLATES_DIR` (alternative templates directory), `BATON_TEMPLATE_STRICT=1` (missing template variables fail),
  `NO_COLOR`.

## Index

**Setup**

| Command | Summary |
|---|---|
| [`init`](#baton-init) | Install baton into this repository (idempotent, never overwrites your files) |
| [`upgrade`](#baton-upgrade) | Refresh the vendored runtime, managed blocks and adapter files from this baton version |
| [`doctor`](#baton-doctor) | Check the installation: node, git, config, plan, runtime, adapters, ledger, agent CLIs, hooks |
| [`agents`](#baton-agents) | List, add, remove or change roster agents and (re)write their adapter files |
| [`uninstall`](#baton-uninstall) | Remove what baton installed (only files that still match the manifest) |
| [`version`](#baton-version) | Print the baton version |

**Planning**

| Command | Summary |
|---|---|
| [`plan`](#baton-plan) | Show, validate, edit, import or graph the plan |
| [`split`](#baton-split) | Build the planning prompt for a goal, optionally run an agent CLI on it |
| [`assign`](#baton-assign) | Fill missing authors and reviewers deterministically |
| [`gate`](#baton-gate) | List, open or close human gates |
| [`prompt`](#baton-prompt) | Print a role prompt with project variables filled in |

**Queries**

| Command | Summary |
|---|---|
| [`status`](#baton-status) | Every packet with status, owner, reviewer, flags and open findings |
| [`next`](#baton-next) | What an agent should do next, in strict order |
| [`scores`](#baton-scores) | Scoreboard per agent, derived from the ledger |
| [`release`](#baton-release) | Milestone progress, due dates and closed gates |
| [`digest`](#baton-digest) | What changed since the last digest, plus what needs attention |
| [`check`](#baton-check) | Validate plan, ownership, dependencies, ledger integrity and leases |
| [`render`](#baton-render) | Write STATUS.md, BUS.md, SCOREBOARD.md and PLAN.md views |

**Working a packet**

| Command | Summary |
|---|---|
| [`begin`](#baton-begin) | Start (or restart) a packet: lease, snapshot and claim |
| [`heartbeat`](#baton-heartbeat) | Extend the lease of your in-progress packet |
| [`reclaim`](#baton-reclaim) | Take over an in-progress packet whose lease expired |
| [`block`](#baton-block) | Mark a packet BLOCKED with a reason and a question |
| [`verify`](#baton-verify) | Scope guard, secret scan and tests; writes the verify marker |
| [`submit`](#baton-submit) | Request review (needs a current passing verify) |

**Review**

| Command | Summary |
|---|---|
| [`review`](#baton-review) | Reviewer brief: packet, done checks, verify result, changed files, findings |
| [`accept`](#baton-accept) | Accept a reviewed packet (refused while BLOCKER/MAJOR findings are open) |
| [`fix`](#baton-fix) | Accept with fixes: the author must resolve the findings |
| [`reject`](#baton-reject) | Reject a reviewed packet (needs a note or at least one finding) |
| [`finding`](#baton-finding) | File, list and resolve audit findings |
| [`reassign`](#baton-reassign) | Change the reviewer of an undecided packet (orchestrator) |
| [`handoff`](#baton-handoff) | Hand a packet to another author (releases it when in progress) |
| [`carry`](#baton-carry) | Carry a REJECTED packet over for another attempt (orchestrator) |

**Coordination and git**

| Command | Summary |
|---|---|
| [`bus`](#baton-bus) | Post and read bus messages (claims, requests, notices, verdicts) |
| [`guard`](#baton-guard) | Tool-call hook: allow or deny an edit by the agent's packet ownership |
| [`worktrees`](#baton-worktrees) | List (or create) one git worktree per track so agents never share a tree |
| [`sync`](#baton-sync) | Rebase the current track branch onto main |
| [`merge`](#baton-merge) | Fast-forward main to an ACCEPTED packet commit (never creates merge commits) |
| [`dispatch`](#baton-dispatch) | Create a GitHub issue from a packet brief so a cloud agent can pick it up |
| [`ledger`](#baton-ledger) | Import, export and verify the event ledger |

`help` shows help for baton or one command.

## Setup

### baton init

```text
baton init [--agents auto|all|claude,codex,...] [--name n] [--test-cmd "..."] [--yes] [--force] [--dry-run] [--no-vendor] [--cloud] [--hooks] [--no-git-ignore]

Install baton into this repository (idempotent, never overwrites your files)

Detects the stack, test command and installed agent CLIs, then writes .baton/ (config, plan, vendored runtime, manifest), a managed block in AGENTS.md, and thin adapter files for every agent in the roster. Re-running is safe: managed blocks are replaced in place, generated files are only replaced when you have not edited them (otherwise a <file>.baton-new sidecar is written).

Options:
      --agents <v>     auto (default), all, or a comma list of adapter ids
      --name <v>       project name
      --test-cmd <v>   command that runs the project tests (default: detected)
  -y, --yes            accept detected defaults without asking
      --force          overwrite generated files even if you edited them
      --dry-run        print exactly what would be written; write nothing
      --no-vendor      do not copy the runtime into .baton/runtime (use a global "baton")
      --cloud          also write CI and cloud-agent workflows under .github/
      --hooks          merge the guard hook into .claude/settings.json
      --no-git-ignore  leave .gitignore and .gitattributes alone
      --docs           also write docs/BATON.md (written automatically when docs/ exists)
      --json           print one JSON document
  -h, --help           show this help

Examples:
  baton init
  baton init --agents claude,codex,gemini --yes
  baton init --dry-run
  baton init --cloud --hooks
```

### baton upgrade

```text
baton upgrade [--dry-run] [--force] [--json]

Refresh the vendored runtime, managed blocks and adapter files from this baton version

Run it with the newer baton package (for example "npx agent-baton upgrade"). Files you edited are kept and a <file>.baton-new sidecar is written.

Options:
      --dry-run   print what would change; write nothing
      --force     overwrite generated files even if you edited them
      --json      print one JSON document
  -h, --help      show this help
```

### baton doctor

```text
baton doctor [--json]

Check the installation: node, git, config, plan, runtime, adapters, ledger, agent CLIs, hooks

Exits 1 when any check is an error; warnings and notes exit 0.

Options:
      --json      print one JSON document
  -h, --help      show this help
```

### baton agents

```text
baton agents list|add|remove|set|install [<id>] [--name n --kind k --roles a,b --strengths a,b --orchestrator] [--only id] [--force] [--dry-run] [--json]

List, add, remove or change roster agents and (re)write their adapter files

Options:
      --id <v>         agent id (lowercase, a-z 0-9 _ -); may also be given as a positional
      --name <v>       display name
      --kind <v>       adapter id (claude, codex, gemini, ..., or custom)
      --roles <v>      comma list of orchestrator, worker, reviewer, auditor
      --strengths <v>  comma list of strengths used by "baton assign"
      --orchestrator   make this agent the orchestrator
      --only <v>       install: only this agent's adapter files
      --force          remove: even if the plan references the agent; install: overwrite edited files
      --dry-run        print what would change; write nothing
      --json           print one JSON document
  -h, --help           show this help

Examples:
  baton agents list
  baton agents add gemini --roles worker,reviewer --strengths frontend,docs
  baton agents set codex --roles worker,reviewer,auditor
  baton agents remove gemini
  baton agents install --only claude
```

### baton uninstall

```text
baton uninstall [--keep-ledger] [--yes] [--dry-run] [--json]

Remove what baton installed (only files that still match the manifest)

Removes manifest-tracked files whose content still matches what baton wrote, strips managed blocks you did not edit and removes the baton hook and package.json script. Files you edited are kept and listed. The ledger, config and plan are deleted unless --keep-ledger is given. .baton/agents.json (yours) is never touched.

Options:
      --keep-ledger  keep .baton/ledger, config.json and plan.json (the history and the plan)
  -y, --yes          do not ask for confirmation
      --dry-run      print what would be removed; remove nothing
      --json         print one JSON document
  -h, --help         show this help
```

### baton version

```text
baton version [--json]

Print the baton version

Options:
      --json      print a JSON document
  -h, --help      show this help
```

## Planning

### baton plan

```text
baton plan <show|validate|add|edit|rm|import|graph> [id|file] [options]

Show, validate, edit, import or graph the plan

show [id]                  print the plan (or one packet in full)
validate                   check the plan against the roster and ownership rules (exit 1 on errors)
add --title T --owns a,b   add a packet (id assigned unless --id)
edit <id> [flags]          change only the flags given; "none" clears track/agent/reviewer/milestone/gate/test/deps/owns lists
rm <id> [--force]          remove a packet that never started (--force also drops dependencies on it)
import <file|-> [--merge|--replace] [--dry-run]   apply a plan or a proposal {"packets":[...]}
graph [--mermaid]          dependency graph as ASCII or Mermaid
Plan writes are for the orchestrator or human: set --by, or BATON_AGENT, to your id.

Options:
      --json               machine-readable output
      --by <v>             acting agent (orchestrator or human)
      --id <v>             add: explicit packet id
      --title <v>          
      --track <v>          
      --agent <v>          author of the packet
      --reviewer <v>       
      --owns <v>...        owned paths, comma separated or repeated
      --reads <v>...       
      --deps <v>...        
      --needs-done <v>...  packets that must be ACCEPTED before this one starts
      --priority <v>       P0|P1|P2|P3
      --milestone <v>      
      --description <v>    
      --check <v>...       done check (repeatable; on edit replaces the list)
      --stretch            
      --no-stretch         edit: make the packet non-stretch
      --gate <v>           
      --gate-mode <v>      start|live_only
      --test <v>           per-packet test command
      --force              
      --merge              import: add to the existing plan (default)
      --replace            import: replace packets (and any lists the file provides)
      --dry-run            
      --mermaid            
  -h, --help               show this help

Examples:
  baton plan add --title "CSV exporter" --track api --owns src/api/export.js --priority P0 --check "tests green"
  baton plan edit WP-003 --reviewer gemini --deps WP-001
  baton plan import .baton/proposals/20261013T101500Z.json --dry-run
```

### baton split

```text
baton split "<goal>" [--run <claude|codex|gemini|command>] [--out file] [--dry-run]

Build the planning prompt for a goal, optionally run an agent CLI on it

Builds the orchestrator prompt (goal, repo tree, roster, rules, plan schema) from templates/prompts/split.md.
Without --run the prompt is printed (or written to --out). With --run the named agent CLI is started non-interactively,
the prompt goes to its stdin, the first JSON object of its output is validated as a proposal and saved to
.baton/proposals/<timestamp>.json. Nothing is applied: run "baton plan import <file>" to apply it.
Known runners: claude ("claude -p"), codex ("codex exec -"), gemini ("gemini -p ..."). Any other value is run as a shell command.

Options:
      --run <v>      agent CLI to run: claude|codex|gemini or a custom command
      --out <v>      write the prompt to this file
      --dry-run      with --run: print the command and do not execute it
      --timeout <n>  with --run: seconds to wait for the agent (default: 900)
      --json         
  -h, --help         show this help

Examples:
  baton split "Ship invoice export" --out prompt.md
  baton split "Ship invoice export" --run claude --dry-run
  baton split "Ship invoice export" --run claude
```

### baton assign

```text
baton assign [--dry-run] [--only-unassigned] [--by <orchestrator>]

Fill missing authors and reviewers deterministically

For every packet that has not started: picks an author (track owner, strength overlap with the packet text, lowest load)
and a reviewer (reviewer role, never the author or a contributor, fewest reviews so far, rotating).
By default conflicts (reviewer equals author, missing role) are repaired too; --only-unassigned only fills blanks.

Options:
      --dry-run          show the assignments without writing
      --only-unassigned  fill blanks only; never change an existing value
      --by <v>           acting agent (orchestrator or human)
      --json             
  -h, --help             show this help
```

### baton gate

```text
baton gate <list|open|close> [id] --by <actor> [--note "..."] [--json]

List, open or close human gates

Gates are human decisions that block packets until opened. Only the gate owner or "human" may open or close one.

Options:
      --by <v>    who opens or closes the gate (the owner, or human)
      --note <v>  
      --json      
  -h, --help      show this help

Examples:
  baton gate list
  baton gate open G1 --by human --note "key provisioned"
```

### baton prompt

```text
baton prompt <orchestrator|worker|reviewer|auditor|split> [--agent <id>] [goal]

Print a role prompt with project variables filled in

For agents without native slash commands: paste or pipe the output into the agent. "split" accepts the goal as extra words.

Options:
  -a, --agent <v>  agent the prompt is for
      --json       
  -h, --help       show this help

Examples:
  baton prompt worker --agent codex
  baton prompt split "Ship invoice export"
```

## Queries

### baton status

```text
baton status [--track <id>] [--agent <id>] [--json]

Every packet with status, owner, reviewer, flags and open findings

Options:
      --track <v>  only this track
  -a, --agent <v>  only packets this agent authors, reviews or holds
      --json       
  -h, --help       show this help

Examples:
  baton status
  baton status --agent codex --json
```

### baton next

```text
baton next --agent <id> [--json]

What an agent should do next, in strict order

Order: 1 reviews awaiting you, 2 your rework (REJECTED, ACCEPTED_WITH_FIXES, CARRIED_OVER),
3 ready packets assigned to you or unassigned on your tracks (P0 first), 4 stretch packets, 5 audit targets,
then a HORIZON EXHAUSTED notice when there is no build work left for you.

Options:
  -a, --agent <v>  agent asking (or set BATON_AGENT)
      --json       
  -h, --help       show this help

Examples:
  baton next --agent codex
  baton next --agent claude --json
```

### baton scores

```text
baton scores [--json]

Scoreboard per agent, derived from the ledger

Started, ready, accepted, rejected, rework, first-pass rate, reviews given, findings filed and findings against each agent.

Options:
      --json      
  -h, --help      show this help
```

### baton release

```text
baton release [--json]

Milestone progress, due dates and closed gates

Accepted packets count as done; packets in review are shown separately; stretch packets are excluded.

Options:
      --json      
  -h, --help      show this help
```

### baton digest

```text
baton digest [--since <iso|last|all>] [--no-mark] [--json]

What changed since the last digest, plus what needs attention

The orchestrator's day-open and day-close report. "--since last" (the default) covers events after the previous digest;
the position is remembered in the local state directory. An explicit --since <iso> never moves the marker.

Options:
      --since <v>  ISO timestamp, "last" (default) or "all"
      --mark       remember this digest as the new "last" (use --no-mark to peek) (default: true)
      --json       
  -h, --help       show this help
```

### baton check

```text
baton check [--json]

Validate plan, ownership, dependencies, ledger integrity and leases

Exit 1 when any error is found. Warnings (unassigned packets, stale leases, unsynced ledger copies) do not fail the check.

Options:
      --json      
  -h, --help      show this help
```

### baton render

```text
baton render [--out <dir>] [--json]

Write STATUS.md, BUS.md, SCOREBOARD.md and PLAN.md views

Generated, git-ignored views of the ledger. Default directory: .baton/views/. Safe to run at any time.

Options:
      --out <v>   output directory (default .baton/views)
      --json      
  -h, --help      show this help
```

## Working a packet

### baton begin

```text
baton begin <packet> --agent <id> [--pull] [--json]

Start (or restart) a packet: lease, snapshot and claim

Options:
  -a, --agent <v>  acting agent id (or BATON_AGENT)
      --pull       take a packet assigned to another agent (announced on the bus)
      --json       print a JSON document
  -h, --help       show this help
```

### baton heartbeat

```text
baton heartbeat <packet> --agent <id> [--json]

Extend the lease of your in-progress packet

Options:
  -a, --agent <v>  acting agent id (or BATON_AGENT)
      --json       print a JSON document
  -h, --help       show this help
```

### baton reclaim

```text
baton reclaim <packet> --agent <id> [--json]

Take over an in-progress packet whose lease expired

Options:
  -a, --agent <v>  acting agent id (or BATON_AGENT)
      --json       print a JSON document
  -h, --help       show this help
```

### baton block

```text
baton block <packet> --agent <id> --reason "..." [--question "..."] [--json]

Mark a packet BLOCKED with a reason and a question

Options:
  -a, --agent <v>     acting agent id (or BATON_AGENT)
      --reason <v>    why the packet cannot proceed (required)
      --question <v>  the specific question that unblocks it
      --json          print a JSON document
  -h, --help          show this help
```

### baton verify

```text
baton verify <packet> [--no-tests] [--json]

Scope guard, secret scan and tests; writes the verify marker

Checks the files this packet changed against its owned paths (protected paths and other packets' files are violations),
scans them for secrets (plus commit history on a branch), runs the test command and records a verify marker and event.
Scope modes: git-branch (HEAD on a non-main branch), git-shared (on main), snapshot (no git).
"baton submit" needs a passing, current marker. --no-tests only checks scope and secrets and can never be submitted.

Options:
      --no-tests  skip the test command (the result is never submittable)
      --json      print one JSON document
  -h, --help      show this help
```

### baton submit

```text
baton submit <packet> --agent <id> [--note "..."] [--json]

Request review (needs a current passing verify)

Options:
  -a, --agent <v>  acting agent id (or BATON_AGENT)
      --note <v>   sign-off note for the reviewer
      --json       print a JSON document
  -h, --help       show this help
```

## Review

### baton review

```text
baton review <packet> [--json]

Reviewer brief: packet, done checks, verify result, changed files, findings

Options:
      --json      print a JSON document
  -h, --help      show this help
```

### baton accept

```text
baton accept <packet> --by <reviewer> [--note "..."] [--score 0-10] [--json]

Accept a reviewed packet (refused while BLOCKER/MAJOR findings are open)

Options:
      --by <v>     the assigned reviewer (or BATON_AGENT)
  -a, --agent <v>  alias of --by
      --note <v>   verdict note
      --score <n>  quality score 0-10
      --json       print a JSON document
  -h, --help       show this help
```

### baton fix

```text
baton fix <packet> --by <reviewer> [--note "..."] [--score 0-10] [--json]

Accept with fixes: the author must resolve the findings

Options:
      --by <v>     the assigned reviewer (or BATON_AGENT)
  -a, --agent <v>  alias of --by
      --note <v>   what must be fixed
      --score <n>  quality score 0-10
      --json       print a JSON document
  -h, --help       show this help
```

### baton reject

```text
baton reject <packet> --by <reviewer> --note "..." [--score 0-10] [--json]

Reject a reviewed packet (needs a note or at least one finding)

Options:
      --by <v>     the assigned reviewer (or BATON_AGENT)
  -a, --agent <v>  alias of --by
      --note <v>   why it is rejected
      --score <n>  quality score 0-10
      --json       print a JSON document
  -h, --help       show this help
```

### baton finding

```text
baton finding add --packet <id> --by <auditor> --severity BLOCKER|MAJOR|MINOR --text "..." [--file f --line n --evidence "..." --fix "..."]
       baton finding list [--packet <id>] [--open] [--json]
       baton finding resolve <FID> --by <agent> --resolution fixed|wontfix|invalid [--note "..."]   (the filer closes it with --confirm)

File, list and resolve audit findings

Options:
  -p, --packet <v>      packet id
      --by <v>          acting agent (or BATON_AGENT)
  -a, --agent <v>       alias of --by
      --severity <v>    BLOCKER | MAJOR | MINOR
      --text <v>        what is wrong
      --file <v>        file the finding is about
      --line <n>        line number
      --evidence <v>    failing command, output or file:line proof
      --fix <v>         suggested fix
      --open            list: only findings that are not closed
      --resolution <v>  resolve: fixed | wontfix | invalid
      --note <v>        resolve: note
      --confirm         resolve: the filer confirms a resolved finding (closes it)
      --json            print a JSON document
  -h, --help            show this help
```

### baton reassign

```text
baton reassign <packet> --reviewer <id> --by <orchestrator> [--json]

Change the reviewer of an undecided packet (orchestrator)

Options:
      --reviewer <v>  new reviewer id
      --by <v>        the orchestrator (or BATON_AGENT)
  -a, --agent <v>     alias of --by
      --json          print a JSON document
  -h, --help          show this help
```

### baton handoff

```text
baton handoff <packet> --to <agent> --by <agent> [--note "..."] [--json]

Hand a packet to another author (releases it when in progress)

Options:
      --to <v>     new author id
      --by <v>     current author/holder or the orchestrator (or BATON_AGENT)
  -a, --agent <v>  alias of --by
      --note <v>   context for the new author
      --json       print a JSON document
  -h, --help       show this help
```

### baton carry

```text
baton carry <packet> --by <orchestrator> [--note "..."] [--json]

Carry a REJECTED packet over for another attempt (orchestrator)

Options:
      --by <v>     the orchestrator (or BATON_AGENT)
  -a, --agent <v>  alias of --by
      --note <v>   why / what changes
      --json       print a JSON document
  -h, --help       show this help
```

## Coordination and git

### baton bus

```text
baton bus post --from <agent> [--to all|<agent>] --type NOTICE|REQUEST|QUESTION|BLOCKER --text "..." [--packet <id>]
       baton bus list [--since <iso>] [--type T] [--packet <id>] [--json]
       baton bus tail [--limit n] [--json]

Post and read bus messages (claims, requests, notices, verdicts)

Options:
      --from <v>    sender (or BATON_AGENT)
  -a, --agent <v>   alias of --from
      --to <v>      recipient: all or an agent id (default: all)
      --type <v>    message type
      --text <v>    message text
  -p, --packet <v>  packet the message is about
      --since <v>   list: only messages at or after this ISO time
      --limit <n>   tail/list: show at most n (tail default 10)
      --json        print a JSON document
  -h, --help        show this help
```

### baton guard

```text
baton guard [--agent <id>] [--hook claude|cursor|generic]   (tool-call JSON on stdin)

Tool-call hook: allow or deny an edit by the agent's packet ownership

Reads a tool-call JSON from stdin (tool_input.file_path | path | file), finds the agent's IN_PROGRESS packets and decides
by config.guard.mode: off (always allow), warn (allow, print a warning), block (exit 2 with a message on stderr).
Coordination paths and files owned by the agent's packets are always allowed; protected paths are never allowed in block mode.
Paths are resolved (.., absolute, backslashes, symlinks) and compared case-insensitively. Paths outside the repository are not guarded.
Unparsable input fails open with a warning.

Options:
  -a, --agent <v>  acting agent id (or BATON_AGENT)
      --hook <v>   payload/response dialect: claude | cursor | generic (default: generic)
  -h, --help       show this help
```

### baton worktrees

```text
baton worktrees [--create] [--base-dir <dir>] [--json]

List (or create) one git worktree per track so agents never share a tree

Each plan track gets a branch (branches.trackPrefix + track id) and a worktree directory. All worktrees share one ledger store, so claims are visible immediately.

Options:
      --create        create the missing branches and worktrees
      --base-dir <v>  parent directory for worktrees (default: <repo>-worktrees next to the repo)
      --json          print a JSON document
  -h, --help          show this help
```

### baton sync

```text
baton sync [--json]

Rebase the current track branch onto main

Refuses on main, with uncommitted work, or in detached HEAD. A conflicting rebase is aborted and the branch is left untouched. Verify again afterwards: the commit changed.

Options:
      --json      print a JSON document
  -h, --help      show this help
```

### baton merge

```text
baton merge <packet> --by <orchestrator> [--json]

Fast-forward main to an ACCEPTED packet commit (never creates merge commits)

Only ACCEPTED packets with a recorded commit, and only when main is an ancestor of that commit. If main moved, rebase with "baton sync" and review again.

Options:
      --by <v>     the orchestrator (or BATON_AGENT)
  -a, --agent <v>  alias of --by
      --json       print a JSON document
  -h, --help       show this help
```

### baton dispatch

```text
baton dispatch <packet> [--to claude|copilot|codex|any] [--repo owner/name] [--dry-run] [--json]

Create a GitHub issue from a packet brief so a cloud agent can pick it up

Runs "gh issue create" with the label "baton" (create it once: gh label create baton). --dry-run prints the command and the issue text and runs nothing.

Options:
      --to <v>    cloud agent to address: claude | copilot | codex | any (default: any)
      --repo <v>  owner/name (default: the repository of the current directory)
      --by <v>    who dispatches (default: the orchestrator)
      --dry-run   print what would run, change nothing
      --json      print a JSON document
  -h, --help      show this help
```

### baton ledger

```text
baton ledger verify [--json]            check hashes and local/mirror agreement (exit 1 on unacknowledged errors)
       baton ledger import [--from <dir>]      copy valid events from the tracked mirror (or <dir>) into the local store
       baton ledger export                     copy valid local events into the tracked mirror (.baton/ledger/)

Import, export and verify the event ledger

Options:
      --from <v>  import: directory of event files (default .baton/ledger)
      --json      print a JSON document
  -h, --help      show this help
```

## Global help

```text
baton 0.1.0: portable multi-agent orchestration

Usage: baton <command> [options]

Execution:
  accept     Accept a reviewed packet (refused while BLOCKER/MAJOR findings are open)
  begin      Start (or restart) a packet: lease, snapshot and claim
  block      Mark a packet BLOCKED with a reason and a question
  bus        Post and read bus messages (claims, requests, notices, verdicts)
  carry      Carry a REJECTED packet over for another attempt (orchestrator)
  dispatch   Create a GitHub issue from a packet brief so a cloud agent can pick it up
  finding    File, list and resolve audit findings
  fix        Accept with fixes: the author must resolve the findings
  guard      Tool-call hook: allow or deny an edit by the agent's packet ownership
  handoff    Hand a packet to another author (releases it when in progress)
  heartbeat  Extend the lease of your in-progress packet
  ledger     Import, export and verify the event ledger
  merge      Fast-forward main to an ACCEPTED packet commit (never creates merge commits)
  reassign   Change the reviewer of an undecided packet (orchestrator)
  reclaim    Take over an in-progress packet whose lease expired
  reject     Reject a reviewed packet (needs a note or at least one finding)
  review     Reviewer brief: packet, done checks, verify result, changed files, findings
  submit     Request review (needs a current passing verify)
  sync       Rebase the current track branch onto main
  verify     Scope guard, secret scan and tests; writes the verify marker
  worktrees  List (or create) one git worktree per track so agents never share a tree

Setup:
  agents     List, add, remove or change roster agents and (re)write their adapter files
  doctor     Check the installation: node, git, config, plan, runtime, adapters, ledger, agent CLIs, hooks
  init       Install baton into this repository (idempotent, never overwrites your files)
  uninstall  Remove what baton installed (only files that still match the manifest)
  upgrade    Refresh the vendored runtime, managed blocks and adapter files from this baton version

Planning:
  assign     Fill missing authors and reviewers deterministically
  check      Validate plan, ownership, dependencies, ledger integrity and leases
  digest     What changed since the last digest, plus what needs attention
  gate       List, open or close human gates
  next       What an agent should do next, in strict order
  plan       Show, validate, edit, import or graph the plan
  prompt     Print a role prompt with project variables filled in
  release    Milestone progress, due dates and closed gates
  render     Write STATUS.md, BUS.md, SCOREBOARD.md and PLAN.md views
  scores     Scoreboard per agent, derived from the ledger
  split      Build the planning prompt for a goal, optionally run an agent CLI on it
  status     Every packet with status, owner, reviewer, flags and open findings

Commands:
  help       Show help for baton or one command
  version    Print the baton version

Global options:
  --version, -v   print the version
  --cwd <dir>     run as if started in <dir>
  -h, --help      help (also: baton <command> --help)

Exit codes: 0 ok, 1 rule violation or failed check, 2 usage error, 3 internal error.
```
