# Self-hosted runner operations

This toolkit manages the repository-level Windows runner intended for `BhurkeSiddhesh/agent-baton`. It is deliberately
disabled by a visibility gate while the repository is public. A persistent runner on a personal laptop must not execute
workflows from a public repository or untrusted pull requests.

## Safety model

- `setup-all.ps1` queries GitHub immediately before installation and refuses a public repository.
- Registration and removal tokens are short lived, requested through the authenticated `gh` session, held only in
  memory, and never written to configuration or logs.
- The official `actions/runner` Windows x64 archive is downloaded and checked against the SHA-256 published in the
  GitHub release before extraction.
- The runner uses a unique directory, name, service, work directory, and custom labels. The Windows service starts
  automatically and the runner directory ACL is limited to SYSTEM, Administrators, and NETWORK SERVICE.
- No inbound port or firewall rule is required. The runner makes outbound HTTPS connections to GitHub.
- One configured instance means one local job at a time. `maxConcurrent` also limits how many configured services the
  central `start.ps1` starts. This is the local control; GitHub has no repository-runner concurrency limit spanning
  unrelated repositories.
- Cleanup refuses to touch a running runner and removes only stale children of the configured `_work` directory.

For stronger isolation, run this toolkit inside a dedicated Hyper-V VM with no personal folders, credentials, browser
profiles, SSH keys, cloud CLIs, or OneDrive mounts. Take a clean VM checkpoint before registration and rebuild the VM
periodically. Do not install the runner directly into a daily-use Windows account.

## Prerequisites

1. Windows PowerShell 7, GitHub CLI, Git, and outbound HTTPS access.
2. An elevated terminal for Windows service installation and ACL changes.
3. `gh auth status` succeeds for a GitHub identity with repository administration access.
4. The repository is private. If it remains public, use GitHub-hosted runners or an ephemeral disposable VM design.
5. At least 25 GB free on the drive containing `C:\github-runners`.

No PAT belongs in `config.json`, the environment, command history, or this repository.

## Commands

Run from this directory in an elevated PowerShell 7 terminal:

```powershell
.\status.ps1
.\health-check.ps1
.\setup-all.ps1 -WhatIf
.\setup-all.ps1
.\stop.ps1 -WhatIf
.\stop.ps1
.\start.ps1
.\restart.ps1
.\cleanup.ps1 -WhatIf
.\cleanup.ps1
.\uninstall.ps1 -WhatIf
.\uninstall.ps1 -RemoveFiles
```

Every mutating command supports `-WhatIf`. `status.ps1` and `health-check.ps1` support `-Json` for monitoring. Use
Task Scheduler to call `health-check.ps1 -Json` after startup and periodically; alert on a non-zero exit code, low disk,
an offline runner, or a stopped service.

## Workflow migration gate

Do not change `runs-on` until all of these are true:

1. the repository is private or the runner is a disposable isolated VM;
2. `status.ps1` reports the expected runner online and not busy;
3. a manually dispatched, non-publishing pilot passes on
   `[self-hosted, windows, x64, agent-baton, trusted-push]`;
4. pull-request jobs remain GitHub-hosted unless PR code is proven trusted;
5. Linux and macOS compatibility jobs remain on their native GitHub-hosted images;
6. the laptop-offline case is accepted as queued, not failed, and a GitHub-hosted required check remains available.

For this repository, only a trusted `push`/manual Windows Node 20 regression job is a migration candidate. The Linux,
macOS, packaging, documentation, coverage, release-gate, and public pull-request checks remain GitHub-hosted. Never put
release or deployment credentials on this runner.

## Recovery

- Interrupted install: rerun `setup-all.ps1`; an existing local and remote registration is left intact.
- Stale GitHub registration with no local configuration: delete the stale runner in repository settings, then rerun
  setup. The installer never silently deletes a remote runner.
- Windows restart: the service startup type is Automatic; verify with `status.ps1` after sign-in.
- Runner crash: use `restart.ps1`, inspect `_diag`, then run `health-check.ps1`.
- Network loss: jobs remain queued. Restore outbound HTTPS and verify the remote status returns to `online`.
- Compromise suspicion: stop the service, revoke repository secrets, run `uninstall.ps1 -RemoveFiles`, and rebuild the
  isolated VM from a clean image.

Runner updates are not applied blindly. Stop the runner, review the official `actions/runner` release, uninstall the
old instance, and rerun setup so the new archive is verified before installation.
