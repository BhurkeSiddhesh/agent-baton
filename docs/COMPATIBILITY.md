[Agent Baton](../README.md) / [Docs](../README.md#documentation) / Compatibility

# Tested platform and shell compatibility

Baton requires Node 18 or newer, but the actual automated compatibility claim is narrower: supported **CI-verified Node majors** are 18, 20 and 22 on the three hosted operating systems below. Node 19, 21, 23 and later majors are not included in this tested matrix and are best-effort. No claim is made about every historical operating-system version.

| Hosted platform | Node 18 | Node 20 | Node 22 | Shell smoke |
|---|---|---|---|---|
| Ubuntu (latest GitHub runner) | Full tests | Full tests, smoke | Full tests | Bash, spaces, Unicode, CRLF |
| Windows (latest GitHub runner) | Full tests | Full tests, smoke | Full tests | PowerShell, cmd.exe and Git Bash |
| macOS (latest GitHub runner) | Full tests | Full tests, smoke | Full tests | Default shell, spaces, Unicode, CRLF |

The [CI workflow](../.github/workflows/ci.yml) supplies the nine OS/Node combinations and runs the independent compatibility fixture in the smoke job under PowerShell, cmd.exe and Git Bash on Windows. It uses a Unicode/space-containing temporary directory, CRLF source content, idempotent initialization, `doctor`, `check` and machine-readable `status` output.

**Git baseline:** Git 2.30 or newer is the declared compatibility target for branch/worktree and history operations (the core snapshot mode runs without Git). Hosted runners use their supplied installed Git; this workflow prints the actual `git --version` for each job. **Git 2.30 is not yet pinned and tested separately**; do not claim that specific minimum version has been certified until a pinned older-Git lane is implemented.

**Known limitations:** Windows long paths beyond the classic 260-character threshold depend on Windows policy and Git's `core.longpaths` setting. The smoke configures `core.longpaths=true`, but does **not** establish support for every path length, junction or UNC variant. Standard Windows process output may use a code page other than UTF-8. Alternate versions of PowerShell, Git Bash and operating systems outside the hosted runner images are not certified.

## Reproduce

From a clone with Node and Git installed:

```bash
node --version
git --version
npm test
node .github/scripts/platform-smoke.mjs
```

On Windows, invoke the final command independently from PowerShell, cmd.exe, and Git Bash. Confirm `PASS` output and compare to the [troubleshooting guide](TROUBLESHOOTING.md) if your installed shell/OS differs.

Report exact versions, shell, line-ending setting, path and full failure output (with secrets redacted) in a bug issue. Avoid relying on an unqualified `node >= 18` badge as a guarantee that all future major releases are tested.
