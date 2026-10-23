[Agent Baton](../README.md) / [Docs](../README.md#documentation) / Compatibility

# Tested platform and shell compatibility

Baton requires Node 18 or newer, but the actual automated compatibility claim is narrower: supported **CI-verified Node majors** are 18, 20 and 22 on the three hosted operating systems below. Node 19, 21, 23 and later majors are not included in this tested matrix and are best-effort. No claim is made about every historical operating-system version.

| Hosted platform | Node 18 | Node 20 | Node 22 | Shell smoke |
|---|---|---|---|---|
| Ubuntu (latest GitHub runner) | Full tests | Full tests, smoke | Full tests | Bash, spaces, Unicode, CRLF |
| Windows (latest GitHub runner) | Full tests | Full tests, smoke | Full tests | PowerShell, cmd.exe and Git Bash |
| macOS (latest GitHub runner) | Full tests | Full tests, smoke | Full tests | Default shell, spaces, Unicode, CRLF |

The [CI workflow](../.github/workflows/ci.yml) supplies the nine OS/Node combinations and runs the independent compatibility fixture in the smoke job under PowerShell, cmd.exe and Git Bash on Windows. It uses a Unicode/space-containing temporary directory, CRLF source content, idempotent initialization, `doctor`, `check` and machine-readable `status` output. On Windows the fixture also commits and rereads a file whose absolute path exceeds 260 characters with repository-local `core.longpaths=true`.

**Git baseline:** Git 2.30 or newer is the declared compatibility target for branch/worktree and history operations (the core snapshot mode runs without Git). A required Debian 11 container lane asserts the installed version is in the Git 2.30 series, then runs the full regression suite and compatibility fixture on Node 18. The hosted OS matrix additionally exercises the newer Git supplied by each runner.

**Known limitations:** The Windows smoke certifies an ordinary local path between 261 and 300 characters on the current hosted runner with `core.longpaths=true`. It does **not** establish support for arbitrary lengths, disabled Windows long-path policy, junctions, network shares or UNC paths. Standard Windows process output may use a code page other than UTF-8. Alternate versions of PowerShell, Git Bash and operating systems outside the hosted runner images are not certified.

## Schema and format compatibility guarantees

### Configuration and plan formats
- **Configuration (`.baton/config.json`):** Version 1 is the baseline configuration schema. New configuration fields may be introduced with sensible defaults in minor releases. Fields are never removed silently; legacy configuration shapes are either normalized on load or refused with structured, actionable diagnostic messages.
- **Plan format (`.baton/plan.json`):** Tracks packets, file ownership patterns, dependencies, and reviewer assignments. Schema migrations must preserve valid in-flight packet structures or provide an automated `baton doctor`/reconciliation migration path.

### Ledger schema and event replay
- **Format versioning (`hv: 1`):** Ledger events carry a schema version `hv: 1`. Legacy checksum-valid events lacking `hv` are supported as v0 for historical replay.
- **Structural event validation:** All new ledger writes are structurally validated against strict JSON schemas before append. Events with unrecognized future schema versions or malformed structures are quarantined during replay and cannot authorize state machine transitions.
- **Deterministic causal replay:** Ledger events encode stream revisions and causal parents. Replay order is topological and deterministic across clones regardless of wall-clock drift or delivery order.
- **Lease fencing:** In-flight packet leases carry integer generation tokens (`lease_token`). Submissions produced under superseded lease tokens fail with `STALE_LEASE_TOKEN`.
- **Clone reconciliation:** `baton ledger reconcile` merges diverged independent event streams deterministically, identifying corrupt entries, missing parents, revision collisions, and competing claims without silent loss of state.

## Adapter and installer compatibility guarantees

### Adapter registry and integration templates
- Supported agent adapter definitions are maintained in `templates/adapters.json` covering Claude Code, GitHub Copilot, Gemini CLI, Cursor, Antigravity, and OpenAI Codex.
- **Managed blocks:** Baton injects agent directives and orchestration instructions bounded by deterministic delimiters (`<!-- baton:start -->...<!-- baton:end -->`). Upgrades and re-runs of `baton init` modify only the content within these delimiters, strictly preserving external user customizations and repository rules.
- **Non-destructive lifecycle:** Tracked file state is recorded in `.baton/manifest.json` with cryptographic SHA-256 digests. Rerunning `baton init` is completely idempotent. `baton uninstall` cleans only unedited, manifest-matching files and never removes user-modified artifacts.

## CLI and exit code contract

Baton enforces a deterministic, stable exit code contract across all supported platforms and shells:

| Exit code | Meaning | Description |
|---|---|---|
| `0` | Success | Command completed successfully. When `--json` is supplied, prints exactly one valid JSON document. |
| `1` | Rule violation | Expected domain refusal (`BatonError`), such as an unowned file touch, unmet dependency, stale lease, or failed verification. |
| `2` | Usage error | Missing required arguments, unknown flags, invalid options, or malformed CLI input. |
| `3` | Internal error | Unexpected system error, I/O failure, unhandled exception, or filesystem permission denial. |

Option names, flag semantics, and exit codes remain backward-compatible within minor releases. Any change to accepted invocation forms follows the formal deprecation lifecycle documented in the [Governance and compatibility policy](GOVERNANCE.md#deprecation-and-migration).

## Reproduce

From a clone with Node and Git installed:

```bash
node --version
git --version
npm test
node .github/scripts/platform-smoke.mjs
```

On Windows, invoke the final command independently from PowerShell, cmd.exe, and Git Bash. Confirm `PASS` output and compare to the [troubleshooting guide](TROUBLESHOOTING.md) if your installed shell/OS differs.

To reproduce the minimum-Git lane exactly (Docker required):

```bash
docker run --rm -v "$PWD:/work" -w /work \
  node:18-bullseye@sha256:0d9e9a8dcd5a83ea737ed92227a6591a31ad70c8bb722b0c51aff7ae23a88b6a bash -lc \
  "git --version && git --version | grep -E '^git version 2\\.30\\.' && npm test && node .github/scripts/platform-smoke.mjs"
```

Report exact versions, shell, line-ending setting, path and full failure output (with secrets redacted) in a bug issue. Avoid relying on an unqualified `node >= 18` badge as a guarantee that all future major releases are tested.
