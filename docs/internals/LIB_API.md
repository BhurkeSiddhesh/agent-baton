# Core library API (`src/lib/`, `src/cli.js`)

Reference for command authors. Everything is ESM, synchronous unless stated, zero dependencies. Source of truth for
behaviour is [SPEC.md](SPEC.md); this file is the exact surface. Conventions:

- **Persisted JSON** (config, plan, events) uses snake_case exactly as in the spec (`lease_until`, `gate_mode`, `needs_done`,
  `done_checks`, `dep_commits`). **Objects returned by the library** (state, queues, scores, progress) use camelCase
  (`leaseUntil`, `depCommits`, `awaitingReview`).
- `root` is always an absolute native path of the repo root (use `ctx.root`). Returned repo paths are posix, repo-relative.
- Failures throw `BatonError` (exit 1) with a stable `.code`; command-line mistakes throw `UsageError` (exit 2). Anything else
  is an internal error (exit 3). Commands never call `process.exit`; they return the exit code.
- Time: `utcnow()` returns a `Date` and honours `BATON_NOW` (ISO string), so tests freeze the clock with that env var.

## 1. Writing a command (`src/commands/<name>.js`)

```js
export const name = 'begin';              // required
export const aliases = [];                // optional
export const summary = 'Start a packet';  // one line, shown in `baton help`
export const usage = 'baton begin <packet> --agent <id> [--pull]';
export const description = '...';         // optional long text
export const examples = ['baton begin WP-001 --agent codex'];  // optional
export const group = 'Execution';         // optional heading in `baton help`
export const hidden = false;              // optional
export const options = {
  agent: { type: 'string', alias: 'a', description: 'acting agent' },   // 'boolean' | 'string' | 'string[]' | 'number'
  pull:  { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  mode:  { type: 'string', default: 'warn' },
};
export async function run(ctx, args) { /* return exit code (default 0) or throw BatonError */ }
```

`args` is `{_: [positionals], <option>: value, <camelCaseOption>: value, help?: true}`. Booleans default to `false`, `string[]`
to `[]`, `string`/`number` to `undefined` (or `default`). Kebab names also exist camelCased (`args['dry-run']` and `args.dryRun`).
Supported syntax: `--k v`, `--k=v`, `-a v`, `-av`, clustered boolean shorts (`-ny`), `--no-k`, `--k=false`, repeated
`string[]`, `--` ends options. `-h/--help` is handled by cli.js before `run`. A string value may start with a single `-`
but not `--` (use `--k=--value`).

### `ctx` (built by `buildContext`)

| Member | Meaning |
|---|---|
| `cwd`, `root`, `env` | working dir, repo root (`BATON_ROOT` > nearest `.baton/config.json` > git top level > cwd), environment |
| `commands` | all discovered command modules (`{name, aliases, summary, usage, options, error?}`) |
| `out(text)` / `err(text)` | write text plus a newline unless it already ends with one |
| `json(obj)` | write `JSON.stringify(obj, null, 2)` and a newline. In `--json` mode call it exactly once and print nothing else |
| `loadConfig({validate?})` | `loadConfig(root)` |
| `loadPlan()` | `loadPlan(root)` |
| `loadState()` | `engine.load(root)`: `{config, plan, events, state}`. Never cached: call again after a write |
| `agent(claimed, {required?})` | `resolveAgent(config, env, claimed, opts)` |

## 2. `errors.js`

- `class BatonError(message, {code?, hint?, details?})` : `.code` default `BATON_ERROR`, `.hint` is printed after the message.
- `class UsageError extends BatonError` : code `USAGE`.
- `exitCodeFor(err) -> 0|1|2|3` as above (UsageError 2, BatonError 1, other 3).

## 3. `util.js`

| Function | Notes |
|---|---|
| `utcnow() -> Date` | honours `BATON_NOW`; invalid override throws BatonError |
| `stamp(d = utcnow()) -> string` | `YYYY-MM-DDTHH:MM:SSZ` |
| `addHours(date, h) -> Date`, `parseTime(iso) -> Date\|null` | |
| `daysUntil(iso, now = utcnow()) -> number\|null` | whole UTC days from now to the date part (negative = past) |
| `toPosix(p)` | backslashes to slashes |
| `sha256(stringOrBuffer) -> hex` | |
| `canonicalJson(value) -> string` | keys sorted recursively, no whitespace, `undefined` dropped |
| `readJson(file, [fallback])` | missing file returns `fallback` if one was passed (even `null`); otherwise throws BatonError `IO`; corrupt JSON always throws `BAD_JSON`; strips a BOM |
| `writeJsonAtomic(file, value)` | 2-space JSON + trailing newline, temp file + rename (retries on Windows EPERM/EBUSY) |
| `writeFileAtomic(file, text)` | creates parent dirs |
| `ensureDir(dir) -> dir` | recursive mkdir |
| `walk(root, {skipDirs?, skipPaths?, maxSize?}) -> string[]` | sorted posix relative file paths; symlinks skipped; defaults skip `.git`, `node_modules`, `__pycache__`, `.pytest_cache`, `.venv`, `venv`, `.ruff_cache`, `.mypy_cache`, `.tox` at any depth and `.baton/state`, `.baton/ledger`, `.baton/views` by path; files over 5 MB skipped (`maxSize: null` disables) |
| `hashTree(root, opts) -> {path: sha1}` | content hashes of the walked files |
| `fingerprint(root, opts) -> hex` | sha256 of `hashTree`; unaffected by ledger/state/views writes |
| `slugify(s)`, `list(value)` | `list` flattens `'a,b'` / `['a,b','c']` / undefined into trimmed non-empty strings |
| `decodeText(buffer) -> string` | tolerant of UTF-8/16 BOMs and UTF-16 without BOM |
| `sleepSync(ms)`, `levenshtein(a, b)` | |

## 4. `git.js` (never throws when git is missing; outside a repo everything degrades to `null`/`false`/`[]`; every call passes `-c core.quotePath=false`; plain folders are detected without spawning git)

- `git(root, args, {input?}) -> {status, stdout, stderr} | null` (null only when git cannot be spawned).
- `gitOut(root, args) -> string | null` (trimmed stdout on exit 0). `gitOk(root, args) -> boolean`.
- `isGit(root)`, `repoRoot(cwd) -> posix path | null`, `commonDir(root) -> absolute path | null` (shared by worktrees).
- `currentBranch(root) -> string|null`, `headCommit(root) -> sha|null`.
- `isDirty(root, {exclude: ['rel/path', ...]}) -> boolean`: staged, unstaged or untracked changes, ignoring excluded paths.
- `changedFiles(root, base) -> string[]`: `base..HEAD` + staged + unstaged + untracked, sorted, posix. `base` may be null.
- `mainRef(root, preferred?) -> 'main'|'master'|preferred|null` (first existing local branch).
- `listWorktrees(root) -> [{path, head, branch, bare}]`.

## 5. `lock.js`

`withLock(dir, fn, {timeoutMs = 20000, staleMs = 300000, quiet = false}) -> fn()'s result`. Exclusive `<dir>/lock` file
(`open('wx')`, JSON `{pid, ts, token}`), re-entrant inside one process, always released (also when `fn` throws; for an async `fn`
when its promise settles). A lock older than 60 s whose pid is dead, or older than 5 min, is broken with a stderr note.
Throws BatonError `LOCK_TIMEOUT` with a hint naming the file. Engine functions already lock; call `withLock(stateDir(root), ...)`
yourself only to make several reads and writes atomic.

## 6. `glob.js`

Pattern language: `*` and `?` stay inside one path segment, `**` crosses segments (`a/**/b` also matches `a/b`), a trailing `/`
means "everything under this directory" (`dir/` is sugar for `dir/**`), everything else is literal. Paths are normalised
(`\` to `/`, leading `./` removed).

- `matchPath(pattern, path) -> boolean`
- `patternsOverlap(a, b) -> boolean`: could one path match both? Conservative and symmetric.
- `ownedBy(path, owns[]) -> boolean`
- `isProtected(path, extraGlobs = []) -> boolean`: `.git`/`secrets` as any path segment, `.env`, `.env.*` (not `.env.example`), `*.pem`, `*.key`,
  `*.p12`, `*.pfx`, `id_rsa*`, `*credentials*.json`, `client_secret*.json`, `token*.json`, `*.sqlite`, `*.sqlite3`, `*.db`; extra globs without a
  `/` match the file name at any depth, others match the full path.
- `isCoordination(path, extra = []) -> boolean`; `BUILTIN_COORDINATION = ['.baton/ledger/', '.baton/state/', '.baton/views/']`; `normPath(p)`.

## 7. `config.js`

- `findRoot(cwd = process.cwd(), env = process.env) -> absolute path`.
- `configPath(root)`, `planPath(root)`.
- `defaultConfig({name, description, stack, orchestrator, agents, testCommand, testRequired, runtimeVendored}) -> config` (full object, section 2.1;
  `runtime.command` is `node .baton/runtime/bin/baton.js` when vendored, else `baton`).
- `validateConfig(cfg) -> {errors: string[], warnings: string[]}` (never throws).
- `loadConfig(root, {validate = true}) -> config`: file merged over defaults; throws `NOT_INIT` (missing), `BAD_JSON`, `BAD_CONFIG` (invalid).
- `saveConfig(root, cfg)`.
- Roster helpers: `agentIds(cfg)`, `getAgent(cfg, id)`, `hasRole(cfg, id, role)`, `isKnownActor(cfg, id)` (roster plus `human`/`harness`).
- Constants: `ROLES`, `RESERVED_AGENTS = ['human','harness']`, `AGENT_ID_RE`, `GUARD_MODES`.

## 8. `plan.js`

- `loadPlan(root) -> plan` (defaults filled: `track:null, agent:null, reviewer:null, reads:[], deps:[], needs_done:[], gate:null, gate_mode:'start',
  priority:'P2', milestone:null, stretch:false, test:null, description:'', done_checks:[]`). Throws `NO_PLAN`, `BAD_PLAN`, `BAD_JSON`.
- `savePlan(root, plan)`: stable key order, 2-space JSON, trailing newline, defaults filled. Re-saving a loaded plan is byte-identical.
- `normalizePlan(plan)`, `normalizePacket(p)`, `orderPlan(plan)`, `planHash(plan) -> sha256 of the canonical ordered plan` (put it in `plan` events).
- `validatePlan(plan, config, {done = []}) -> {errors, warnings}` (never throws; `done` = ids ignored for overlap checks). Errors: bad/duplicate ids,
  unknown agent/reviewer/track/gate/milestone/dependency, reviewer equals author (when `requireDifferentReviewer`), empty/absolute/`..`/backslash/protected
  `owns`, bad priority/gate_mode, dependency cycle, cross-track `owns` overlap of packets that can run concurrently, overlapping track ownership.
  Warnings: unassigned agent/reviewer, same-track overlap, packet path outside its track, agent not the track owner, track owns nothing.
- `nextPacketId(plan, prefix = 'WP') -> 'WP-004'`, `packetMap(plan) -> {id: packet}`.
- Graph: `findCycle(plan) -> ids[]|null`, `hasCycle(plan)`, `topoOrder(plan) -> ids[]` (throws `CYCLE`), `transitiveDeps(plan, id) -> Set` (deps and needs_done),
  `packetsOverlap(p, q) -> [[ownsA, ownsB], ...]`.
- Constants `PRIORITIES`, `GATE_MODES`, `ID_RE`.

## 9. `store.js` (ledger)

- `stateDir(root)`: `<git common dir>/baton/` in git, else `<root>/.baton/state/` (created on demand). `stateSub(root, 'verified'|'snapshots'|...)`,
  `eventsDir(root)`, `ledgerDir(root)` (= `<root>/.baton/ledger`).
- `appendEvent(root, {packet?, kind, to?, by?, note?, data?}) -> event`: under the state lock; fills `id` (`YYYYMMDDTHHMMSSZ-<6 hex>`, strictly increasing even inside one
  second), `ts`, `hv`, `rev`, `parents`, `sha`; validates the versioned event shape and writes the local file plus the optional mirror. Shape validation does not authorize lifecycle transitions: use engine functions for state changes. Throws `BAD_EVENT`, `BAD_EVENT_SCHEMA`, `LEDGER_NEWER`, or `LEDGER_CONFLICT` when causal conflicts must be reconciled before another write.
- `readEvents(root) -> event[]`: union of local and mirror, de-duplicated by id (local wins), sorted by `(ts, id)`; unreadable, checksum-invalid, schema-invalid and future-version events are quarantined from replay and reported by `verifyLedger`.
- `verifyLedger(root) -> [{id, where: 'local'|'mirror'|'both', severity: 'error'|'warn', problem, acked}]`: unreadable JSON, id/file mismatch, missing/wrong `sha`, local and
  mirror copies that differ (errors); a local event missing from the mirror (warn). `acked` is true when an `ack` event names the id. Empty array = healthy.
- `importLedger(root, fromDir = ledgerDir(root)) -> {imported: ids[], skipped: [{id, reason}]}` and `exportLedger(root) -> {exported: ids[], skipped}`: copy only valid (sha-checked) events.
- `eventSha(event)`, `validateEventSchema(event)`, `EVENT_KINDS`, `EVENT_ID_RE`, `LEDGER_VERSION` (= 1). Historical events without `hv` are treated as legacy v0 and remain readable; writers always emit v1. Unknown future versions are never replayed or imported. Migration creates new events and never silently rewrites checksum-bound history.

Event kinds: `begin, heartbeat, reclaim, status, ready, verdict, reviewer, handoff, verify, merged, finding, finding_resolved, message, gate, plan, init, ack`.
`message.data = {type, to, text}`; `gate.data = {gate, open}`; `finding.data = {fid, severity, file, line, evidence, fix, against}` with the text in `note`;
`finding_resolved.data = {fid, resolution, confirm}`; `begin.data = {base, lease_until, dep_commits}`; `ready.data = {commit, tests}`; `verify.data = {ok, commit, mode}`;
`verdict.data = {commit, score?}`; `handoff.data = {agent, from}`; `ack.data = {event}`; `plan.data = {hash}` (written by plan commands via `appendEvent`).
All kinds require string `by`; packet kinds require string `packet`; transition kinds (`begin`, `reclaim`, `status`, `ready`, `verdict`) require string `to`. A `handoff` only requires `to` when it also releases in-progress work. Required payload fields are: `heartbeat.lease_until`, `reviewer.reviewer`, `handoff.agent`, `verify.ok`, `merged.commit`, `finding.{fid,severity}`, `finding_resolved.{fid,resolution}`, `message.{type,to,text}`, `gate.{gate,open}`, `plan.hash`, and `ack.event`. Other listed payload fields are optional for v0/v1 compatibility. `status` has no kind-specific payload. Unknown payload fields are retained for additive compatibility; a future incompatible contract must increment `hv`.

## 10. `snapshot.js` (non-git scope tracking)

- `takeSnapshot(root) -> {path: sha1}`; `saveSnapshot(root, pid, agent)` (done by `engine.begin`); `hasSnapshot(root, pid)`; `snapshotFile(root, pid)`;
  `diffSnapshot(root, pid) -> string[]` (added/removed/modified since begin; throws `NO_SNAPSHOT`).

## 11. `secrets.js`

- `SECRET_PATTERNS = [{id, re}]` (AWS, private key, Google OAuth/refresh/client secret, GitHub `gh[pousr]_`, Slack `xox[abprs]-`, `sk-` keys, token/secret/password assignments).
- `scanText(label, text) -> [{label, line, pattern}]` (a line containing `baton:allow-secret` is skipped). Findings never contain the secret text.
- `scanFiles(root, rels) -> findings` (missing files and directories skipped; unreadable ones report pattern `unreadable`; handles CRLF and UTF-16).
- `scanHistory(root, base) -> findings` for added lines of `base..HEAD` (label `commit history`); `[]` when `base` is null or git fails.
- `formatSecretHit(hit) -> 'file:line: matches secret pattern id'`.

## 12. `engine.js`

### State
`derive(plan, events) -> state = {packets: {id: PacketState}, gates: {id: GateState}}`, `load(root) -> {config, plan, events, state}`, `initialState(plan)`, `applyEvent(state, ev)`, `getPacket(plan, pid)` (throws `UNKNOWN_PACKET`).

`PacketState`: `{id, status, agent (effective author), reviewer (effective), by (current holder), contributors[] (sorted agents who began or heartbeat), leaseUntil, base,
commit (set by ready), depCommits{}, rejections, lastTs, merged, verdict: {outcome, by, score, ts}|null, blockedReason}`. `GateState`: `{id, title, owner, open, by, ts, note}`.

Constants (Sets unless noted): `STATUSES[]`, `TRANSITIONS{status: Set}`, `DONE` (ACCEPTED, ACCEPTED_WITH_FIXES), `REVIEWABLE` (READY_FOR_REVIEW + DONE), `ACTIVE`, `STARTABLE`,
`REWORK`, `REVIEW_OUTCOMES`, `MESSAGE_TYPES[]` (spec types plus `SIGNOFF`), `SEVERITIES[]`, `RESOLUTIONS[]`.

### Queries
- `flags(pid, plan, state, {config, now}) -> string[]`: `NO_LEASE`, `STALE`, `AT_RISK:<dep>=<status>`, `AT_RISK:<dep>-changed` (ignored while the recorded commit was `unbuilt`), `ESCALATE`, `GATE_CLOSED:<id>`.
- `blockingDeps(packet, plan, state) -> ids[]` (same-track deps not yet reviewable, plus `needs_done` not ACCEPTED), `gateBlocks(packet, state)`, `reviewerOf(pid, state)`.
- `readyPackets(plan, state) -> packet[]` (PLANNED/CARRIED_OVER/REJECTED, deps and gate satisfied, no ownership overlap with IN_PROGRESS work).
- `nextFor(agent, plan, state, {config, now}) -> {agent, awaitingReview, reworkOwed, own, stretch, pull, unassigned, staleReclaimable, audit}`: lists of packet ids. Ranking: carried/rejected first,
  milestone due date, priority, own lane, id.
- `findingsOf(events, pid?) -> [{fid, packet, severity, file, line, evidence, fix, against, by, text, ts, status: 'open'|'resolved'|'closed', resolution, resolvedBy, closedBy}]`,
  `nextFindingId(events) -> 'AUD-001'`.
- `scores(plan, events) -> {agents: {id: {started, ready, accepted, acceptedWithFixes, rejected, rework, reopensAfterFixes, reviewsGiven, meanScoreGiven, findingsFiled, findingsConfirmed,
  findingsInvalid, findingsAgainstOpen, findingsAgainstClosed, firstPassRate}}}` (pure; `meanScoreGiven`/`firstPassRate` are `null` with no data).
- `progress(plan, state, {now}) -> {milestones: [{id, title, due, daysLeft, total, done, inReview, inProgress, blocked, notStarted, gated[], percent, overdue}], overall: {done, total, percent}, closedGates, now}`
  (stretch packets excluded; ACCEPTED is done; packets without a milestone form a last row with `id: null`).
- `auditEvents(plan, events, config) -> [{id, severity: 'error', problem, acked}]`: illegal transitions, IN_PROGRESS without `begin`, ready at an unverified commit, verdicts by a
  non-reviewer or a contributor, events for unknown packets. `baton check` should combine this with `verifyLedger`, `validatePlan` and `flags` (`STALE`).

### Mutations (all take the state lock, validate, append events, and throw BatonError with the codes shown)
| Function | Effect and refusal codes |
|---|---|
| `transition(root, pid, to, {by, note, kind, data})` | the full rule set; returns the event. `BAD_TRANSITION`, `BEGIN_ONLY`, `DEPS_UNMET`, `GATE_CLOSED`, `OWNERSHIP_CLASH`, `NO_REVIEWER`, `NOT_REVIEWER`, `REVIEWER_CONFLICT`, `OPEN_FINDINGS`, `REJECT_NEEDS_REASON`, `NOT_VERIFIED`, `DIRTY_TREE`, `STALE_VERIFY`, `IDENTITY` |
| `begin(root, pid, agent, {pull}) -> {event, pulledEarly, rework, owns, leaseUntil, base}` | lease + snapshot + CLAIM message. Also `NOT_YOURS`, `ALREADY_STARTED`, `ALREADY_DONE`, `NOT_CONTRIBUTOR`, `NOT_WORKER`, `UNKNOWN_AGENT` |
| `heartbeat(root, pid, agent) -> leaseUntil` | `NOT_IN_PROGRESS`, `HELD` |
| `reclaim(root, pid, agent) -> {event, leaseUntil}` | needs `STALE` or `NO_LEASE`; `NOT_STALE` |
| `block(root, pid, {by, reason, question})` | BLOCKED + BLOCKER message; `NEEDS_REASON`, `HELD` |
| `submit(root, pid, {by, note})` | READY_FOR_REVIEW (event kind `ready`) + SIGNOFF message |
| `verdict(root, pid, outcome, {by, note, score})` | `ACCEPTED \| ACCEPTED_WITH_FIXES \| REJECTED` + VERDICT message; `BAD_SCORE` |
| `carry(root, pid, {by, note})` | REJECTED to CARRIED_OVER, orchestrator/human only (`NOT_ORCHESTRATOR`) |
| `reassignReviewer(root, pid, reviewer, {by})` | orchestrator/human only; reviewer needs the reviewer role and must not have worked on it |
| `handoff(root, pid, {to, by, note})` | new author needs the worker role; an IN_PROGRESS packet is released to BLOCKED and the new author must `begin`; `BAD_TRANSITION` for packets under review or accepted |
| `setGate(root, gateId, open, {by, note})` | gate owner or `human` only (`NOT_GATE_OWNER`, `UNKNOWN_GATE`) |
| `postMessage(root, {from, to, type, text, packet})` | `BAD_MESSAGE`, `UNKNOWN_AGENT` |
| `addFinding(root, {packet, by, severity, text, file, line, evidence, fix, against}) -> {fid, event}` | filer needs the auditor or reviewer role and must not have worked on the packet |
| `resolveFinding(root, fid, {by, resolution, confirm, note})` | fixer records `fixed\|wontfix\|invalid`; only the filer can `confirm` (after a resolution) or close it as `invalid`; closed findings stop blocking acceptance |
| `acknowledge(root, eventId, {by, reason})` | `ack` event for a known anomaly |
| `recordVerify(root, pid, result)` | writes the verify marker `<state>/verified/<pid>.json` and a `verify` event (`by: 'harness'`) |
| `readVerifyMarker(root, pid) -> object\|null`, `verifyMarkerPath(root, pid)` | |

**Verify marker contract.** `result = {packet, ok, mode, commit, fingerprint, tests: {ran, ok, tail}, in_scope, coordination, out_of_scope, secrets, problems, ...}`. `submit` requires `ok`
and a *current* marker: modes starting with `git-branch` require a clean tree (ignoring `.baton/ledger|state|views`) and `HEAD == commit`; any other mode (`git-shared`, `snapshot`)
requires `fingerprint == util.fingerprint(root)`. Scope modes are chosen by the `verify` command; compute `fingerprint` with `util.fingerprint(root)` *after* running tests.

Identity: every mutation calls `checkIdentity(by)`: when `BATON_AGENT` is set it must equal `by`.

## 13. `context.js`

- `buildContext({cwd, env, stdout, stderr, commands, root}) -> ctx` (section 1). `memoryStream() -> {write, text(), clear()}` for in-process tests.
- `resolveAgent(config, env, claimed, {required = true}) -> id|null`: `--agent` or `BATON_AGENT`; conflict throws `IDENTITY`; unknown id `UNKNOWN_AGENT`; missing + required throws `UsageError`.

## 14. `paths.js`

`packageRoot()` (directory containing `src/` and `templates/`, derived from the module's own location, so it is correct in this repo and in `.baton/runtime/`),
`templatesDir()`, `packageVersion()` (from the package.json beside `src/`, `0.0.0` if absent).

## 15. `template.js` (Mustache-lite)

`render(template, vars, {strict = false, partials, partialsDir}) -> string`; `renderFile(file, vars, opts)`; `parse(template) -> tree` (throws `TEMPLATE` BatonError on syntax errors).

Syntax: `{{var}}` (dotted paths; arrays print joined by `, `; nothing is escaped), `{{#if path}}..{{else}}..{{/if}}` (falsy: missing, null, false, 0, `''`, `[]`), `{{#each list}}..{{/each}}`
with `{{this}}`, `{{this.field}}`, `{{@index}}` (bare names resolve in the item first, then outward), `{{> partial}}` (rendered in the current scope; loaded from the `partials` map/function, else
`templates/partials/<name>.md`; nesting limited to 20), `{{!comment}}`. Block tags, comments and partials alone on a line consume the whole line. Strict mode throws on a missing variable,
list or partial (an `#if` on a missing path is not an error). Anything else (`{{{x}}}`, `{{#unless}}`) is a syntax error.

## 16. `cli.js`

- `main(argv, {cwd, env, stdout, stderr, commandsDir}) -> Promise<exitCode>`: handles `--version`/`-v`, `--cwd <dir>`, `help [cmd]`, `<cmd> --help`, unknown command suggestions, error to exit-code mapping
  (stderr gets `baton: <message>` and `hint: ...`; internal errors print the stack when `BATON_DEBUG` is set). Never calls `process.exit`.
- `parseArgs(argv, optionTable) -> args`, `discoverCommands(dir?)`, `findCommand(commands, nameOrAlias)`, `formatGlobalHelp(commands, version)`, `formatCommandHelp(cmd)`.
- Command modules that fail to import are listed as `(failed to load)`; running one prints the import error (exit 3).

## 17. Test helpers (`tests/helpers.js`)

`makeTempRepo({git, files, config, plan, commit}) -> {root, write(rel, text), read(rel), exists(rel), git(...args), commitAll(msg), cleanup()}` (git repos use branch `main`, a local identity and one
initial commit; `config`/`plan` may be objects or `true` for the samples), `runCli(cwd, args, env) -> {status, stdout, stderr}` (real binary in a child process; baton env vars scrubbed, `env` merged
in), `runNode(cwd, args, env)`, `sampleConfig(over)` (roster claude/codex/gemini), `samplePlan(over)` (tracks api/ui, packets WP-001..WP-004, gate G1, milestone M1), `cleanEnv(extra)`, `REPO`, `BIN`.
