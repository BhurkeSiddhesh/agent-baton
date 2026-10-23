# Contributing

Thanks for helping. Agent Baton is a small, dependency-free Node project; the bar is correctness, clear errors and
tests. Please read the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately, see
[SECURITY.md](SECURITY.md).

## Setup

```bash
git clone https://github.com/BhurkeSiddhesh/agent-baton
cd agent-baton
node --version        # 18 or newer
npm test              # no npm install needed: there are no dependencies
node bin/baton.js --help
```

Try changes in a scratch repository, never in a repository you care about:

```bash
mkdir /tmp/scratch && cd /tmp/scratch && git init
node /path/to/agent-baton/bin/baton.js init --yes --dry-run
```

## Layout

| Path | What |
|---|---|
| `bin/baton.js` | entry point |
| `src/cli.js` | argument parsing, command discovery, help, exit codes |
| `src/commands/<name>.js` | one file per command: `name`, `summary`, `usage`, `options`, `run(ctx, args)` |
| `src/lib/` | core library: ledger, engine (state machine), plan, git, glob, secrets, templates |
| `src/install/` | installer: registry, vendoring, managed blocks, manifest, hooks |
| `templates/` | everything `init` writes into user repositories; `adapters.json` is the registry |
| `tests/` | `node:test` files named `*.test.js` |
| `docs/` | user documentation; `docs/internals/` holds the design spec, library API and brand notes |

The design spec ([docs/internals/SPEC.md](docs/internals/SPEC.md)) is the source of truth for behaviour and data formats;
[docs/internals/LIB_API.md](docs/internals/LIB_API.md) documents the library surface.

## Rules

- Zero runtime dependencies, ESM, Node >= 18, plain JavaScript with JSDoc. No build step, no TypeScript.
- Windows, macOS and Linux. Normalise paths to forward slashes internally, spawn processes with argument arrays (no
  shell) except for the user's test command, never assume `sh`, tolerate CRLF.
- No network access and no secrets in the tool.
- Everything written into a user repository is idempotent and non-destructive.
- Output: human text by default; `--json` prints exactly one JSON document. Errors go to stderr. Exit codes are
  `0` ok, `1` rule violation (`BatonError`), `2` usage error, `3` internal error.
- Small modules, named exports, no classes except `BatonError`. Comment only the non-obvious why.
- State changes go through the engine (`transition`, `begin`, `postMessage`, ...), never by writing ledger files directly.

## Tests

```bash
npm test                                # everything
node --test tests/lib-glob.test.js      # one file
```

- Use `node:test` and `node:assert/strict`. Create temporary directories with `fs.mkdtempSync(os.tmpdir())`.
- Tests may run `git`; they must not touch the network, your home directory or this repository's own `.baton/`.
- Use fixtures and synthetic data only. Never put a real credential in a test, even an expired one. Build
  secret-shaped strings at runtime.
- Every command needs a happy-path test and tests for its main refusals. Engine rules are table-driven.
- Installer changes need tests for an empty git repo, an existing project with its own `AGENTS.md` (content preserved),
  a non-git folder, and an idempotent re-run.
- The init suite copies the runtime many times and can take a few minutes on Windows.

## Documentation

- `docs/COMMANDS.md` is generated from the real `--help` output (`node .github/scripts/gen-commands.mjs`). After changing a command's usage, options or summary,
  regenerate it and check the diff.
- Docs link back to the index: each file starts with a navigation line. Relative links must resolve; the CI link check runs
  on every pull request (`node .github/scripts/check-links.mjs`).
- Plain, imperative prose. No emoji.

## Changing templates

Templates are rendered by a deliberately small engine (`{{var}}`, `{{#if}}`, `{{#each}}`, `{{> partial}}`, `{{! comment}}`).
It has no escape syntax, so GitHub Actions expressions are written `$[[ expr ]]` and converted to `${{ expr }}` after
rendering. Keep adapter files thin: they point at `AGENTS.md` and the baton command, and the protocol lives in
`templates/partials/`.

To add an adapter, add its detection and file entries to `templates/adapters.json`, its templates under
`templates/adapters/<id>/`, defaults in `src/install/registry.js`, and tests; then update
[docs/AGENTS.md](docs/AGENTS.md) and the README table.

## Pull requests

Before merging, consult the [branch and tag protection runbook](docs/BRANCH_PROTECTION.md). GitHub rulesets must be activated in repository settings; a documented gate alone cannot block an unauthorized push. The sole-maintainer recovery process must be audited.

Follow the [governance and compatibility policy](docs/GOVERNANCE.md): reference a tracked issue, disclose CLI/config/ledger compatibility and rollback impact, and include real CI evidence. A review by a different Baton roster ID alone is not proof of an independent human review. Mark partial implementation with `Refs #N`, not `Closes #N`.

### Required evidence for PR acceptance

Every pull request must satisfy the following acceptance criteria before merge authorization:
1. **Targeted branch and focused scope:** Branch from `main`, keep the diff minimal and focused on a single issue, and ensure commit messages follow conventional formats (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`).
2. **Automated test suite:** Run `npm test` locally. CI must pass cleanly across Ubuntu, Windows, and macOS on Node 18, 20, and 22, as well as the Git 2.30 Debian baseline.
3. **Negative and refusal tests:** Include explicit tests for invalid arguments, unauthorized actions, error conditions, and expected exit codes (`1` for `BatonError`, `2` for usage errors).
4. **Zero runtime dependencies:** Verify that `package.json` contains no runtime `dependencies`. Do not add third-party npm packages.
5. **Documentation and link validation:** When modifying commands, flags, or CLI summaries, regenerate command documentation (`node .github/scripts/gen-commands.mjs`) and verify links (`node .github/scripts/check-links.mjs`).
6. **Compatibility and rollback disclosure:** Document any impact on schema versions (`hv`), configuration (`.baton/config.json`), or agent adapters (`templates/adapters.json`), providing explicit rollback instructions.
7. **Changelog record:** Update [CHANGELOG.md](CHANGELOG.md) under `Unreleased` describing behavior changes, fixes, or security disclosures.
8. **PR template completion:** Complete the pull request template in full, including issue references (`Closes #N` or `Refs #N`), acceptance evidence, compatibility notes, and security review confirmations.

### Maintainer and reviewer expectations

- Maintainers triage incoming contributions, confirm roadmap alignment, review security implications, and authorize merges and releases.
- Code reviewers inspect exact diffs, verify acceptance criteria independently, and reject submissions lacking reproducible test evidence or clean CI results.
- Coding agent assignments (such as `--by <agent>`) provide coordination provenance but do not constitute authenticated code reviews. Authoritative review requires maintainer oversight.

Agent Baton is built with Agent Baton: if you use coding agents on this repository, follow `AGENTS.md`.
