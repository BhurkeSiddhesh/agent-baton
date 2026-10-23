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
