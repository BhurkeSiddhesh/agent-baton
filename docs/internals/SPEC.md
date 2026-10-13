# Agent Baton: design spec (source of truth for implementers)

Agent Baton is a portable, zero-dependency orchestration kit. Run one command in any repository and it installs a
multi-agent workflow: a plan split into **packets** with exact file ownership, claims and leases, a verify gate
(scope guard, secret scan, tests), cross-agent review, audit findings, a scoreboard, and adapters so every AI coding
agent (Claude Code, Codex, Gemini CLI, Antigravity, Cursor, Copilot, Windsurf, Cline, Aider, OpenCode, custom) follows
the same protocol. Local and cloud agents share state through a conflict-free, git-mergeable ledger.

It generalises a working in-house harness. **Reference implementation to port semantics from (read it):**
the original in-house `tools/harness.py` and
`docs/ORCHESTRATION.md`, `AGENTS.md`, `docs/AGENT_BUS.md`.
Do NOT copy project-specific content (creator analytics, YouTube, Python). Keep the *mechanics*.

## 0. Hard constraints

- Node >= 18, ESM (`"type":"module"`), **zero runtime dependencies**, plain JavaScript with JSDoc (no TypeScript, no build step).
- Works on **Windows, macOS, Linux**. Always normalise paths to forward slashes internally (`toPosix`). Never assume `sh`.
  Spawn processes with `child_process.spawnSync` (argument arrays, no shell) except the user's test command (run through the shell).
  Handle CRLF in inputs. No `rm -rf`/`cp` shelling; use `fs`.
- Tests with `node:test` + `node:assert/strict`, in `tests/`, named `*.test.js`. Tests create temp dirs (`fs.mkdtempSync(os.tmpdir())`),
  may run `git` (it is installed), never touch the network, never touch the real home dir or this repo's `.baton/`.
- No secrets, no network access in the tool itself. The only network-adjacent features (`dispatch`, `split --run`) shell out to the
  user's own `gh` / agent CLIs and must support `--dry-run`.
- Every file the tool writes into a user repo is idempotent and non-destructive (see section 7).
- Output: human text by default; `--json` on every query command prints exactly one JSON document on stdout (nothing else).
  Errors go to stderr. Exit codes: `0` ok, `1` rule violation or failed check (`BatonError`), `2` usage error, `3` internal error.
- Style: small modules, named exports, no classes except `BatonError`. Comment only non-obvious "why".

### 0.1 Security and trust boundaries

The CLI and its adapters are **not a sandbox**: roster identities (`--agent`, `--by`, `BATON_AGENT`) are self-declared; hooks may fail open and do not mediate shell operations; the verify/test runner can execute user or plan-defined shell commands; hashes detect accidental changes but do not authenticate ledger writers; local merge acceptance does not replace required GitHub CI or review policies. Treat source, issue text, proposals, test logs and all third-party tool output as untrusted. Read [the multi-agent security model](../SECURITY_MODEL.md) for the control matrix, failure modes, and required external mitigations. Changes to runner or approval semantics must update that model.

## 1. Repository layout (this repo)

```
bin/baton.js                 entry (shebang), calls src/cli.js
src/cli.js                   arg parsing, command discovery (reads src/commands/*.js at runtime), help, error->exit code
src/commands/<name>.js       one file per command; export { name, aliases?, summary, usage, run(ctx, args) }
src/lib/*.js                 core library (section 3)
src/install/*.js             installer engine (section 7)
templates/                   everything copied/rendered into user repos (section 8)
assets/                      logo and brand SVGs
docs/                        user docs; docs/internals/ = SPEC.md, LIB_API.md
tests/                       node:test files; tests/helpers.js shared helpers
.github/                     CI for this repo, issue templates
```

Command module contract (`src/commands/*.js`): `export const name = "begin"; export const summary = "..."; export const usage = "baton begin <packet> --agent <id>"; export const options = {...}` (declarative option table: `{agent:{type:"string"}, json:{type:"boolean"}, pull:{type:"boolean"}}`) and
`export async function run(ctx, args)` where `args = {_:[positionals], ...options}` and `ctx = {cwd, root, out(text), err(text), json(obj), env, loadConfig(), loadPlan(), loadState()}` supplied by cli.js. `run` returns the exit code (default 0) or throws `BatonError`. `cli.js` parses options with its own tiny parser based on the command's declared `options` (support `--k v`, `--k=v`, `-h`, repeated flags -> arrays when `type:"string[]"`, `--no-x`).

## 2. Concepts and data

- **Agent**: a named actor with a roster id (lowercase, `[a-z0-9_-]+`), e.g. `claude`, `codex`, `antigravity`. Roles: `orchestrator`, `worker`, `reviewer`, `auditor`. Identity comes from `--agent <id>` or env `BATON_AGENT`; ids must exist in the roster (plus the reserved ids `human` and `harness`).
- **Track**: a standing theme owned by one agent with a set of owned paths. Directory ownership between tracks must not overlap (checked).
- **Packet**: a unit of work with an exact `owns` list, `done_checks`, an author (`agent`) and a `reviewer` (never the author). Stretch packets are optional extras.
- **Gate**: a human decision (e.g. "legal review", "API key provisioned") that blocks packets until `baton gate open G1 --by human`.
- **Ledger**: append-only event log, one JSON file per event (conflict-free under git merges). Live state is *derived* by replaying events over the plan.
- **Bus**: human-readable view of `message` events (claims, releases, requests, notices, handoffs, verdicts).

### 2.1 `.baton/config.json`

```json
{
  "version": 1,
  "project": { "name": "my-repo", "description": "", "stack": ["node"] },
  "orchestrator": "claude",
  "agents": [
    { "id": "claude", "name": "Claude", "kind": "claude", "roles": ["orchestrator","worker","reviewer","auditor"], "strengths": ["architecture","security","review"] },
    { "id": "codex", "name": "Codex", "kind": "codex", "roles": ["worker","reviewer","auditor"], "strengths": ["backend","tests","integration"] }
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
  "runtime": { "vendored": true, "command": "node .baton/runtime/bin.js" }
}
```
`kind` is an adapter id from the registry (section 7.2) or `custom`. `coordination` = extra repo-relative paths any packet may touch (shared files like a CHANGELOG, plus the built-in baton paths). `protected.globs` extend the built-in protected list (section 3.5).

### 2.2 `.baton/plan.json` (tracked, edited by the orchestrator via `baton plan ...`, or by hand)

```json
{
  "version": 1,
  "goal": "Ship invoice export",
  "tracks": [ { "id": "api", "owner": "codex", "theme": "HTTP API + persistence", "owns": ["src/api/", "tests/api/"] } ],
  "gates":  [ { "id": "G1", "title": "Prod API key provisioned", "owner": "human", "open": false } ],
  "milestones": [ { "id": "M1", "title": "Alpha", "due": "2026-11-01" } ],
  "packets": [
    {
      "id": "WP-001", "title": "Invoice CSV exporter", "track": "api", "agent": "codex", "reviewer": "claude",
      "owns": ["src/api/export.js", "tests/api/export.test.js"],
      "reads": ["docs/DATA_CONTRACT.md"],
      "deps": [], "needs_done": [], "gate": null, "gate_mode": "start",
      "priority": "P0", "milestone": "M1", "stretch": false,
      "test": null,
      "description": "Free text; what and why.",
      "done_checks": ["Exporter handles empty invoices", "Tests green"]
    }
  ]
}
```
Rules enforced by `validatePlan`: ids unique and `^[A-Za-z0-9][A-Za-z0-9_.-]*$`; `agent`/`reviewer`/track `owner` exist in the roster; `reviewer != agent` (when `requireDifferentReviewer`); `deps`/`needs_done` reference existing packets and form no cycle; `owns` non-empty, repo-relative, no `..`, no absolute paths, no protected paths; two packets that can run concurrently must not have overlapping `owns` unless one of them depends (transitively) on the other (this is a *warning* for packets in the same track, an *error* across tracks); track `owns` may not overlap another track's; a packet's `owns` should sit inside its track's `owns` (warning). `priority` in `P0|P1|P2|P3`. `gate_mode` is `start` (default; gate must be open to begin) or `live_only` (gate only restricts live/prod work; does not block starting). Optional per-packet `test` overrides `config.test.command`.

### 2.3 Statuses and transitions (port from the reference)

Statuses: `PLANNED, IN_PROGRESS, BLOCKED, READY_FOR_REVIEW, ACCEPTED, ACCEPTED_WITH_FIXES, REJECTED, CARRIED_OVER`.
```
PLANNED/CARRIED_OVER -> IN_PROGRESS | BLOCKED
IN_PROGRESS          -> READY_FOR_REVIEW | BLOCKED
BLOCKED              -> IN_PROGRESS
READY_FOR_REVIEW     -> ACCEPTED | ACCEPTED_WITH_FIXES | REJECTED | IN_PROGRESS   (IN_PROGRESS = author reopens, discarding the verify marker)
ACCEPTED_WITH_FIXES  -> ACCEPTED | IN_PROGRESS
REJECTED             -> CARRIED_OVER | IN_PROGRESS
ACCEPTED             -> (terminal)
```
Invariants: `IN_PROGRESS` is reachable only through `begin` (lease + snapshot + claim message). Fresh entry from `PLANNED/CARRIED_OVER/REJECTED/BLOCKED` re-runs dependency and gate checks and file-ownership clash checks against other IN_PROGRESS packets; "rework" entry from `READY_FOR_REVIEW/ACCEPTED_WITH_FIXES` skips dep/gate checks and may only be done by prior contributors. Only the assigned reviewer records a verdict, and never a contributor/author. `READY_FOR_REVIEW` requires a successful, *current* `verify` marker (git mode: clean tree and HEAD equals verified commit; snapshot mode: file fingerprint equal). `ACCEPTED` is refused while the packet has open `BLOCKER` or `MAJOR` findings. `REJECTED` requires a note or at least one finding. A same-track dependency blocks starting until the dependency is `READY_FOR_REVIEW` or accepted; cross-track dependencies never block (flag `AT_RISK`), unless listed in `needs_done` (must be `ACCEPTED`).

Flags (advisory, derived): `STALE` (lease expired), `NO_LEASE`, `AT_RISK:<dep>=<status>`, `AT_RISK:<dep>-changed`, `ESCALATE` (>= `escalateAfterRejections` rejections and not done), `GATE_CLOSED:<id>`.

### 2.4 Events (`.baton/ledger/<id>.json`, mirrored in the local shared state dir)

```json
{ "id": "20261013T101500Z-a3f9c2", "ts": "2026-10-13T10:15:00Z", "packet": "WP-001", "kind": "begin",
  "to": "IN_PROGRESS", "by": "codex", "note": "", "data": { "base": "<sha>", "lease_until": "..." }, "hv": 1, "sha": "<sha256 of canonical JSON of the event without sha>" }
```
Kinds: `begin, heartbeat, reclaim, status, ready, verdict, reviewer (reassign reviewer), handoff (reassign author), verify, merged, finding, finding_resolved, message, gate, plan (hash of plan.json at change time), init, ack`.
`packet` may be `null` for non-packet events (`gate`, `message`, `init`). Event ids sort chronologically (`YYYYMMDDTHHMMSSZ-<6 hex>`). `sha` lets `baton check` detect edited history; missing files cannot be detected (they simply never happened), which is why the ledger is also mirrored.
`message` data: `{ "type": "CLAIM|RELEASE|REQUEST|NOTICE|BLOCKER|HANDOFF|VERDICT|QUESTION", "to": "all|<agent>", "text": "..." }`.
`finding` data: `{ "fid": "AUD-001", "severity": "BLOCKER|MAJOR|MINOR", "file": "", "line": 0, "evidence": "", "fix": "", "against": "<agent>" }`; resolved by a `finding_resolved` event `{ "fid", "resolution": "fixed|wontfix|invalid" }` (resolution by the finding's author-of-fix, confirmed by the filer via `--confirm`, see commands).

### 2.5 Store locations

- **Local shared store** (immediate visibility across git worktrees): `<git common dir>/baton/` when in git (events in `events/`, verify markers in `verified/`, snapshots in `snapshots/`, `lock`). Outside git: `<root>/.baton/state/`.
- **Tracked ledger mirror**: `<root>/.baton/ledger/` (one file per event). Written alongside every append when `config.ledger.mirror` is true (default). Reading = union of both dirs de-duplicated by event id, sorted by `(ts,id)`. Cloud agents and fresh clones therefore see full history from the tracked mirror alone. `baton ledger import|export|verify` expose it.
- Everything under `<root>/.baton/state/` and `.baton/views/` is gitignored; `.baton/{config.json,plan.json,ledger/,runtime/,manifest.json}` are tracked.

## 3. Core library (`src/lib/`) — built first, documented in `docs/internals/LIB_API.md`

| Module | Responsibility |
|---|---|
| `errors.js` | `BatonError(message,{code,hint})`, `UsageError` |
| `util.js` | `utcnow()` (honours `BATON_NOW` ISO override for tests), `stamp(d)`, `toPosix`, `sha256`, `canonicalJson` (sorted keys), `readJson/writeJsonAtomic/writeFileAtomic`, `ensureDir`, `walk(root,{skipDirs})`, `slugify`, `fingerprint(root)` |
| `git.js` | `git(root,args,{input})`, `gitOut`, `gitOk`, `isGit`, `repoRoot`, `commonDir`, `currentBranch`, `headCommit`, `isDirty`, `changedFiles(root, base)` (committed since base + staged + unstaged + untracked), `mainRef`, `listWorktrees`; every call uses `-c core.quotePath=false`; never throws when git is missing (returns null) |
| `lock.js` | `withLock(dir, fn, {timeoutMs=20000})`: exclusive lockfile via `fs.openSync(path,'wx')`, pid+timestamp inside, stale lock (older than 60 s with dead pid or 5 min) is broken with a note; always releases in `finally` |
| `glob.js` | `matchPath(pattern, path)` (`*`, `**`, `?`, trailing `/` = directory prefix, literal), `patternsOverlap(a,b)`, `ownedBy(path, owns)`, `isProtected(path, extraGlobs)`; deterministic, tested heavily |
| `config.js` | `findRoot(cwd)` (walk up to a dir containing `.baton/config.json`; else git top level; else cwd), `loadConfig`, `saveConfig`, `defaultConfig(opts)`, `validateConfig` |
| `plan.js` | `loadPlan`, `savePlan` (stable key order, 2-space JSON, trailing newline), `validatePlan(plan,config)->{errors,warnings}`, `nextPacketId(plan,prefix)`, graph helpers (`topoOrder`, `hasCycle`, `transitiveDeps`) |
| `store.js` | `stateDir(root)`, `readEvents(root)`, `appendEvent(root, partial)` (locked, writes local + mirror, computes id/ts/sha/hv), `verifyLedger(root)->problems[]`, `importLedger(root)`, `exportLedger(root)` |
| `engine.js` | constants; `derive(plan,events)->state`; `flags`; `blockingDeps`; `reviewerOf`; `transition(root,pid,to,{by,note,kind,data})` (the full rule set of 2.3); `readyPackets`; `nextFor(agent)`; `findingsOf`; `scores`; `progress` (milestones) |
| `secrets.js` | `SECRET_PATTERNS`, `scanText`, `scanFiles(root, rels)`, `scanHistory(root, base)` (git log -p added lines); ported and generalised from the reference (AWS, private keys, Google, GitHub `gh[pousr]_`, Slack `xox[abprs]-`, OpenAI/Anthropic `sk-...`, generic token/secret assignments); allow-list comment `baton:allow-secret` on the same line |
| `snapshot.js` | non-git mode: `takeSnapshot(root)` (path->sha1 map saved at `begin`), `diffSnapshot(root,pid)` |
| `context.js` | `buildContext(...)`, lazy `loadState()` returning `{config, plan, events, state}` |

Built-in protected paths (reject in `owns`, flag in `verify`): `.git/`, `.env`, `.env.*` (except `.env.example`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `*credentials*.json`, `client_secret*.json`, `token*.json`, `*.sqlite`, `*.sqlite3`, `*.db`, `secrets/`, plus `config.protected.globs`.
Built-in coordination paths (any packet may touch, never counted as scope violations): `.baton/ledger/`, `.baton/state/`, `.baton/views/`, plus `config.coordination`.

## 4. CLI surface (every command supports `-h/--help`; query commands support `--json`)

Planning and roster (**planning group**, file owner A1):
- `baton plan show [--json]`, `plan validate`, `plan add --title ... [--track --agent --reviewer --owns a,b --deps ... --priority --milestone --description --check "..."(repeatable) --stretch --gate]`, `plan edit <id> [same flags]`, `plan rm <id>` (refuses if started), `plan import <file|-> [--merge|--replace] [--dry-run]` (accepts a plan JSON or a *proposal* `{"packets":[...]}`; validates; assigns missing ids; writes `plan` event), `plan graph` (ASCII/mermaid of deps; `--mermaid`).
- `baton split "<goal>" [--run <claude|codex|gemini|custom-cmd>] [--out file]`: builds the orchestrator prompt (goal, repo tree summary, roster+strengths, rules, the exact plan JSON schema, examples) from `templates/prompts/split.md`, prints it (or writes `--out`), and with `--run` executes the named agent CLI non-interactively (`claude -p`, `codex exec`, `gemini -p`; `--dry-run` prints the command) feeding the prompt on stdin, extracts the first JSON object from its output, validates it as a proposal and saves it to `.baton/proposals/<ts>.json` (never auto-applies; print the `baton plan import` command to apply).
- `baton assign [--dry-run] [--only-unassigned]`: fills missing `agent`/`reviewer` using strengths overlap with title/description/tags, current load, and reviewer rotation (reviewer != author, spread evenly, prefer agents with the `reviewer` role); deterministic.
- `baton agents list|add|remove|set|install [--only id]`: roster management (`add --id --name --kind --roles worker,reviewer --strengths a,b`), `install` (re)writes adapter files for roster agents; `list` shows detected CLIs. (File owner B.)
- `baton gate list|open|close <id> --by <human>`.
- `baton prompt <orchestrator|worker|reviewer|auditor|split> [--agent id]`: prints the role prompt with project variables filled in, for agents without native slash commands.
- `baton status [--json] [--track t] [--agent a]`: every packet, status, owner, reviewer, flags, lease, open findings; plus counts. `baton next --agent <id> [--json]`, `baton scores [--json]`, `baton release [--json]` (milestone progress and gates), `baton digest [--since <iso|last>]` (what changed since last digest; orchestrator's day-open/close report), `baton check [--json]` (plan valid, ownership disjoint, deps acyclic, ledger integrity, protected paths, stale leases; exit 1 on errors), `baton render [--out dir]` (generated views: `STATUS.md`, `BUS.md`, `SCOREBOARD.md`, `PLAN.md` into `.baton/views/`).

Execution and review (**execution group**, file owner A2):
- `baton begin <id> --agent <a> [--pull]`, `heartbeat <id> --agent`, `reclaim <id> --agent`, `block <id> --agent --reason "..." [--question "..."]`.
- `baton verify <id> [--no-tests] [--json]`: scope guard + protected paths + secret scan (files, and history in branch mode) + tests (unless `--no-tests`; not allowed to submit then); writes the verify marker and a `verify` event. Scope modes: `git-branch` (HEAD on a non-main branch: diff base..HEAD plus dirty/untracked), `git-shared` (on main with shared tree: dirty/untracked plus commits since base), `snapshot` (no git).
- `baton submit <id> --agent <a> [--note "..."]` -> `READY_FOR_REVIEW` (requires the marker, see 2.3), posts a SIGN-OFF message with test tail and commit.
- `baton review <id> [--json]`: reviewer brief (packet, done checks, verify result, changed files, open findings, commands to run).
- `baton accept|reject|fix <id> --by <reviewer> [--note] [--score 0-10]` -> `ACCEPTED | REJECTED | ACCEPTED_WITH_FIXES`. `baton reassign <id> --reviewer <a> --by <orchestrator>`, `baton handoff <id> --to <agent> [--note] --by <agent>` (re-assign author of a not-in-progress packet or release+hand over an in-progress one with context, emits HANDOFF message), `baton carry <id> --by <orchestrator>` (`REJECTED -> CARRIED_OVER`).
- `baton finding add --packet <id> --by <auditor> --severity BLOCKER|MAJOR|MINOR --text ... [--file f --line n --evidence ... --fix ...]` (auditors file, never edit audited files), `finding list [--packet --open --json]`, `finding resolve <FID> --by <agent> --resolution fixed|wontfix|invalid [--note]` (`--confirm` by the filer closes it; only confirmed or `invalid`-by-filer findings stop blocking acceptance).
- `baton bus post --from a [--to all|a] --type NOTICE|REQUEST|QUESTION|BLOCKER --text "..."`, `bus list [--since --type --json]`, `bus tail`. Claims/releases are auto-posted by begin/submit/handoff.
- `baton guard [--agent a] [--hook claude|cursor|generic]`: reads a tool-call JSON from stdin (`tool_input.file_path`/`path`/`file`), resolves the agent's IN_PROGRESS packets, and decides allow/deny according to `config.guard.mode` (`off|warn|block`); in `block` mode exit 2 with a stderr message (Claude Code hook semantics); always allows coordination paths and files owned by the packet; never blocks when the agent has no packet in `warn`.
- `baton worktrees [--create] [--base-dir d]`, `baton sync` (rebase current track branch onto main), `baton merge <id> --by <orchestrator>` (fast-forward main to the accepted commit only; refuses otherwise), `baton dispatch <id> [--to claude|copilot|codex|any] [--repo owner/name] [--dry-run]` (creates a GitHub issue from the packet brief via `gh issue create`, label `baton`, so a cloud agent can pick it up).
- `baton ledger import|export|verify`.

Install group (file owner B): `baton init`, `baton upgrade`, `baton doctor`, `baton agents ...`, `baton version`, `baton uninstall [--keep-ledger] [--yes]` (removes only manifest-tracked files whose hash still matches).

## 5. Agent protocol (what every agent is told; the product's brain)

1. Session start: `baton check`, then `baton next --agent <me>`. The ledger decides what is READY, not memory or chat.
2. `baton begin <packet> --agent <me>` before the first write. Only touch files in the packet's `owns` (plus coordination paths). Need another file? `baton bus post --type REQUEST ...` or ask the orchestrator; never edit it.
3. Work until every Done check is true. If blocked: `baton block ...` with a *specific question*, then take a stretch packet or `baton next` again. Long work: `baton heartbeat`.
4. Sign-off: `baton verify <id>`; paste real command output into the PR/handoff note; `baton submit`. Unverified claims of completion count against the agent in `baton scores`.
5. Review is done by a different agent: `baton review <id>`, run the checks yourself, then `accept|fix|reject` with findings that carry evidence (file:line or failing command) and a suggested fix. Auditors file findings; they do not edit audited files. Authors fix findings and `resolve` them; filers confirm.
6. Rejection has a price: after `escalateAfterRejections` the packet escalates to the orchestrator.
7. Orchestrator: plans (`split`, `plan add/import`), assigns, keeps the horizon at least a few packets deep, rotates reviewers, closes the day with `baton digest`, and never overrides repo rules or human gates.
8. Never commit secrets, tokens, raw private exports; tests use fixtures. Never edit another agent's claim, message or ledger event. Never rewrite the plan except the orchestrator.
9. Empty queue -> audit mode (`baton next` lists targets).

## 6. Views and scoring

`scores`: per agent — packets started, ready, accepted, accepted_with_fixes, rejected, rework count, reviews given (and mean score given), findings filed (confirmed / invalid), findings against (open/closed), unverified-complete claims (submit without passing verify attempts impossible; count `reopen` after accept-with-fixes), first-pass acceptance rate. Pure function of the ledger.
`release`: per milestone `done/total` packets (accepted counts as done; ready-for-review counts as `in review`), due date vs today (`BATON_NOW` aware) and closed gates; overall percent.

## 7. Installer (`baton init`)

`baton init [--agents auto|all|claude,codex,...] [--name n] [--test-cmd "..."] [--yes] [--force] [--dry-run] [--no-vendor] [--cloud] [--hooks] [--no-git-ignore]`.
Behaviour: detect repo root (git top level, else cwd) and **never** write outside it; detect stack (package.json, pyproject/requirements, go.mod, Cargo.toml, pom/gradle, *.csproj/sln, Gemfile, composer.json, Makefile) and a default test command (`npm test` if a real test script exists, `python -m pytest -q`, `go test ./...`, `cargo test`, `mvn -q test`/`gradle test`, `dotnet test`, `bundle exec rake test`, `composer test`, `make test`); detect installed agent CLIs and existing agent dirs (`which`/`where` lookups for `claude codex gemini cursor-agent aider opencode copilot gh code cursor windsurf`) and pick the roster (`auto` = detected plus claude+codex when nothing is detected; interactive confirmation unless `--yes` or no TTY); write `.baton/config.json`, `.baton/plan.json` (empty starter with a sample commented packet only in docs, plan stays valid), vendor the runtime to `.baton/runtime/` (copy of `bin/`, `src/`, `package.json` stub with `"type":"module"`; so `node .baton/runtime/bin/baton.js` works with no network, zero install) plus shims `.baton/baton` (sh) and `.baton/baton.cmd` (Windows), add `"baton": "node .baton/runtime/bin/baton.js"` to package.json scripts if one exists, merge/create `AGENTS.md` (managed block), generate adapter files per agent (section 7.2) and role prompts, write `.baton/manifest.json` (every file written with sha256 and whether it is a managed block), update `.gitignore` (`.baton/state/`, `.baton/views/`) and `.gitattributes` (`.baton/ledger/** -diff linguist-generated`), write an `init` event, optionally `--cloud` (CI workflow and cloud-agent workflows, section 8.4) and `--hooks` (merge guard hook into `.claude/settings.json`), and print next steps. Re-running is idempotent. Existing user files are never overwritten: managed blocks (`<!-- baton:begin vN -->...<!-- baton:end -->`) are replaced in place; standalone generated files are replaced only if their on-disk hash equals the manifest hash (unmodified) or `--force`; otherwise skipped with a notice and a `<file>.baton-new` sidecar. `upgrade` = re-run with the newer runtime, refreshing vendored files, blocks and adapters, and reporting what changed. `doctor` verifies node version, git, test command resolvable, config/plan validity, vendored runtime version vs package version, adapter files present and unmodified, ledger integrity, detected agent CLIs with install hints, hooks configured; exit 1 on errors, 0 with warnings.

### 7.1 Template engine
Mustache-lite in `src/install/template.js`: `{{var}}` (HTML-unescaped, dotted paths), `{{#if path}}..{{else}}..{{/if}}`, `{{#each list}}..{{this}}/{{this.field}}/{{@index}}..{{/each}}`, `{{> partial}}` (from `templates/partials/<name>.md`), `{{!comment}}`. Missing variable -> empty string in non-strict mode, error in `strict` (tests use strict). No other syntax.

Variables available to every template: `project.name`, `project.description`, `cli` (the command agents run, e.g. `node .baton/runtime/bin/baton.js`), `agents` (roster array of `{id,name,kind,roles,strengths}`), `orchestrator`, `testCommand`, `role` (for per-role files: `orchestrator|worker|reviewer|auditor`), `roleTitle`, `agent` (for per-agent files: the adapter id and name), `baton.version`.

### 7.2 Adapter registry (`src/install/registry.js`; data in `templates/adapters.json`)
Each adapter: `{id, label, detect:{bins:[...],dirs:[...],files:[...]}, instructionFiles:[...], perRoleFiles:[...], commandFiles:[...], notes}`. Built-in adapters and the files they generate (all thin, pointing at AGENTS.md and `{{cli}}`):

| id | Files |
|---|---|
| `claude` | `CLAUDE.md` (managed block that imports `@AGENTS.md` and lists the baton commands), `.claude/agents/baton-<role>.md` (subagents with front matter `name, description, tools?`), `.claude/commands/baton-{plan,next,review,status,audit,digest}.md` (slash commands), `.claude/skills/baton/SKILL.md` |
| `codex` | `AGENTS.md` (shared), `.codex/agents/baton-<role>.toml` (`name`, `description`, `developer_instructions`) |
| `gemini` | `GEMINI.md` (managed block importing `@AGENTS.md`), `.gemini/commands/baton/<cmd>.toml` (`description`, `prompt`) |
| `antigravity` | `.agent/rules/baton.md`, `.agent/workflows/baton-<cmd>.md`, `.agents/skills/baton-<role>/SKILL.md` |
| `cursor` | `.cursor/rules/baton.mdc` (front matter `description, alwaysApply: true`), `.cursor/commands/baton-<cmd>.md` |
| `copilot` | `.github/copilot-instructions.md` (managed block), `.github/agents/baton-<role>.agent.md`, `.github/prompts/baton-<cmd>.prompt.md` |
| `windsurf` | `.windsurf/rules/baton.md`, `.windsurf/workflows/baton-<cmd>.md` |
| `cline` | `.clinerules/baton.md` |
| `aider` | `CONVENTIONS.md` (managed block), `.aider.conf.yml` merge of `read: [AGENTS.md, CONVENTIONS.md]` only if absent |
| `opencode` | `AGENTS.md` (native); `.opencode/agent/baton-<role>.md` |
| `custom` | user-declared in `.baton/agents.json`: `{id,label,instructionFile,templateDir}` |

Commands (`cmd`) = `plan, next, review, status, audit, digest`; roles = `orchestrator, worker, reviewer, auditor`.

## 8. Templates (`templates/`) — file owner C

```
templates/
  adapters.json                registry data (section 7.2) + per-adapter file entries:
                               { "src": "adapters/claude/subagent.md.tpl", "dest": ".claude/agents/baton-{{role}}.md", "each": "role"|"cmd"|null, "mode": "file"|"block"|"merge-json" }
  agents-block.md.tpl          the AGENTS.md managed block (the protocol, section 5, concise and imperative)
  partials/*.md                shared prose reused by prompts and adapters (role bodies, rules, command cheat-sheet)
  prompts/{orchestrator,worker,reviewer,auditor,split}.md
  adapters/<id>/...            one template per generated file
  plan.starter.json            empty valid plan
  docs/ORCHESTRATION.md.tpl    optional human-readable protocol doc dropped at docs/BATON.md (only if a docs/ dir exists or --docs)
  github/baton-ci.yml.tpl      CI: checkout, setup-node, `{{cli}} check`, scope guard/verify on baton/* branches, render job summary
  github/baton-claude.yml.tpl  optional `@claude` workflow using anthropics/claude-code-action@v1 (secrets referenced, never inlined)
  github/baton-dispatch.yml.tpl optional: on issue labelled `baton`, comment instructions for cloud agents
  github/PULL_REQUEST_TEMPLATE.md.tpl  sign-off checklist (verify output pasted, packet id, findings)
  hooks/claude-settings.json   guard hook snippet merged into .claude/settings.json
```
Prompts must be concrete, imperative and short: exact commands with the `{{cli}}` prefix, no fluff, no emoji, and must work standing alone for an agent that has read nothing else.

## 9. Quality bar

- Every command has tests (happy path and the main refusal paths). Engine rules (2.3) have table-driven tests, including the ownership-clash, reviewer-independence, stale lease reclaim, ACCEPTED-blocked-by-open-finding, and READY-requires-current-verify rules.
- An end-to-end test (`tests/e2e.test.js`) drives a temp git repo through: init -> plan add (2 tracks) -> assign -> begin -> edit file out of scope -> verify fails -> fix -> verify passes -> submit -> review -> finding -> fix -> accept -> scores/release -> check, using only the CLI via `spawnSync(process.execPath, [bin, ...])`.
- `baton init` on: an empty git repo, an existing Node project with AGENTS.md already present (content preserved), a Python project, and a non-git folder all succeed, are idempotent on re-run, and `baton doctor` passes afterwards.
