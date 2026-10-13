[Agent Baton](../README.md) / [Docs](../README.md#documentation) / Quickstart

# Quickstart

From zero to an accepted packet in about ten minutes. You need Node 18 or newer and, for the full experience, git.

## 1. Install into a repository

```bash
cd your-repo
npx github:BhurkeSiddhesh/agent-baton init
# npx agent-baton init          # once published to npm
```

Or use a bootstrap script, which checks Node first: `sh install.sh` ([install.sh](../install.sh)) or
`powershell -File install.ps1` ([install.ps1](../install.ps1)). Both forward their arguments to `init`.

Useful flags:

| Flag | Effect |
|---|---|
| `--yes` | accept detected defaults, no prompts |
| `--dry-run` | print exactly what would be written, write nothing |
| `--agents auto\|all\|claude,codex,...` | choose the roster (default `auto`) |
| `--test-cmd "pytest -q"` | override the detected test command |
| `--cloud` | also write GitHub workflows, see [CLOUD.md](CLOUD.md) |
| `--hooks` | merge the ownership guard hook into `.claude/settings.json` |
| `--no-vendor` | do not copy the runtime; use a global `baton` |

`init` is idempotent and never overwrites your files. See [AGENTS.md](AGENTS.md#what-init-writes) for what it writes.
Check the result at any time:

```bash
node .baton/runtime/bin/baton.js doctor
```

Everything below uses `baton` as shorthand for `node .baton/runtime/bin/baton.js` (or `.baton/baton` on macOS and
Linux, `.baton\baton` on Windows). Set an identity once per shell with `export BATON_AGENT=claude` (PowerShell:
`$env:BATON_AGENT = "claude"`), or pass `--agent` each time.

## 2. Describe the work

Option A, let an agent draft the plan:

```bash
baton split "Ship invoice export" --out .baton/prompt.md  # build the planning prompt (keep it out of the repo root, or delete it before verify)
baton split "Ship invoice export" --run claude           # or run an agent CLI on it
baton plan import .baton/proposals/<timestamp>.json --dry-run
baton plan import .baton/proposals/<timestamp>.json
```

`split --run` never applies anything; it saves a validated proposal under `.baton/proposals/`. Known runners are
`claude` (`claude -p`), `codex` (`codex exec -`) and `gemini` (`gemini -p`); any other value is run as a shell command.
Add `--dry-run` to see the command first.

Option B, by hand. Create a track, then add packets (a fresh repo has no tracks, and `--track` must name an existing one):

```bash
baton plan track add --id api --owner claude --owns src/api/,tests/api/ --by human
baton plan add --title "CSV exporter" --track api --owns src/api/export.js,tests/api/export.test.js \
  --priority P0 --check "empty invoices handled" --check "tests green" --by human
baton assign --by human          # fills missing authors and reviewers
baton check                      # validates plan, ownership, dependencies, ledger
```

Without the track the write is refused with `unknown track`. Commit `.baton/plan.json` before `begin`: an uncommitted plan edit counts as out of scope for `verify`. See
[PLAN_FORMAT.md](PLAN_FORMAT.md).

Commit `.baton/` so every agent, local or cloud, sees the same plan.

## 3. Work a packet

Each agent starts a session the same way:

```bash
baton check
baton next --agent codex
```

`next` returns work in a strict order: reviews waiting for you, your rework, ready packets, stretch packets, audit
targets, then a `HORIZON EXHAUSTED` notice asking the orchestrator for more.

```bash
git checkout -b baton/WP-001-csv-export
baton begin WP-001 --agent codex          # lease, snapshot, claim on the bus
# ... edit only the files in the packet's owns list ...
git add -A && git commit -m "csv export"
baton verify WP-001                       # scope guard, secret scan, tests
baton submit WP-001 --agent codex --note "all done checks true"
```

`verify` must pass on a clean, committed tree, and `submit` requires that exact commit to have passed.

## 4. Review it

A different agent reviews:

```bash
baton review WP-001                       # brief: done checks, verify result, changed files, commands
baton accept WP-001 --by claude --score 9
# or: baton fix WP-001 --by claude --note "..."     accept with fixes
# or: baton reject WP-001 --by claude --note "..."
```

Then the orchestrator lands it: `baton merge WP-001 --by claude` fast-forwards main to the accepted commit.

## 5. Watch the whole thing

```bash
baton status          # every packet, owner, reviewer, flags
baton release         # milestone progress, due dates, gates
baton scores          # per-agent scoreboard
baton digest          # what changed since the last digest
baton render          # STATUS.md, BUS.md, SCOREBOARD.md, PLAN.md in .baton/views/
```

## Agents without slash commands

`baton prompt worker --agent codex` prints a complete role prompt (also available as `.baton/prompts/<role>.md`).
Paste or pipe it into any agent.

### Custom planning runners and shell authorization

Built-in `split --run claude|codex|gemini` commands use fixed executable/argument arrays. To invoke a **custom shell command**, first inspect `split "goal" --run "your-command" --dry-run`, then explicitly authorize execution with `--allow-shell`. Commands in test configuration or imported packet tests remain executable shell code and must be reviewed before `verify`. Untrusted issue text is never a reason to grant shell authorization.

## Next

- The full lifecycle and rules: [WORKFLOW.md](WORKFLOW.md)
- Every command and flag: [COMMANDS.md](COMMANDS.md)
- Something went wrong: [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
