# Agent Baton CI migration audit

Audit date: 2026-10-22 (Asia/Calcutta)

## Repository inventory

| Repository | Visibility | Default branch | Workflows | Runner status | Migration status |
|---|---|---|---|---|---|
| `BhurkeSiddhesh/agent-baton` | Public | `main` | `ci.yml`, `coverage.yml` | No registered runner | Blocked on safe isolation/private visibility |

The task scope was explicitly limited to this repository. No other repositories were discovered or modified.

## Build and workflow assessment

Agent Baton is a dependency-free Node.js CLI supporting Node 18 and newer. Its canonical regression command is
`npm test`; focused unit, integration, security, documentation, package-integrity, offline-install, cross-platform
smoke, coverage, and release-gate jobs also run in GitHub Actions.

| Job family | Current hosts | Windows self-hosted compatibility | Decision |
|---|---|---|---|
| Full regression matrix | Ubuntu, Windows, macOS; Node 18/20/22 | Windows rows are compatible | Candidate only for trusted push/manual Node 20 pilot; retain OS and Node coverage |
| Unit/integration | Ubuntu Node 20 | Tests can run on Windows, but native Linux coverage is intentional | Keep GitHub-hosted Linux |
| Security regressions | Ubuntu, Windows, macOS | Windows row compatible | Keep public PR execution GitHub-hosted |
| Package/offline install | Ubuntu Node 20 with Bash utilities | Linux-specific shell and `mktemp` | Keep GitHub-hosted Linux |
| Smoke | Ubuntu, Windows, macOS | Windows row compatible and exercises PowerShell/cmd/Git Bash | Candidate after safe runner exists; keep native OS rows |
| Docs and coverage | Ubuntu Node 20 | Portable with edits, but no material benefit | Keep GitHub-hosted pending pilot evidence |
| Release gates | Ubuntu and tag-only | Must not be changed during migration | Keep GitHub-hosted; no publication was added |

Both workflows already use read-only `contents` permission, timeouts, and cancellation of superseded work. There are no
deployment workflows or repository secrets required by the inspected jobs. Actions use major-version tags rather than
immutable SHAs; pinning them should be a separate focused change after validating the update process.

## Recent evidence

- Latest inspected `main` runs on 2026-10-22 succeeded for both `ci` and `coverage`.
- An earlier PR run failed in the Windows Node 18/20/22 regression rows and correctly failed its aggregate branch gate;
  a later run for the same PR succeeded. This shows the current gate and diagnostics behave as intended.
- Repository Actions permissions are enabled with all actions allowed. Default workflow token permission is read-only
  and workflows cannot approve pull requests.
- The default branch currently has no GitHub branch-protection rule. This audit did not weaken or alter protections.

Typical recent wall-clock duration was about 2.5 minutes for `ci` and under 1 minute for `coverage`, with many matrix
jobs running concurrently. A single local runner would serialize migrated jobs; therefore avoided billable minutes
cannot be claimed until a pilot run supplies actual local job duration. Public repositories generally receive free
standard GitHub-hosted Actions usage, so cost avoidance may be zero while the repository remains public.

## Host snapshot

The inspected host is 64-bit Windows with approximately 32 GB RAM, a hypervisor present, and roughly 190 GB free on
the C: drive. During validation the machine was already under high memory pressure, reinforcing the initial
`maxConcurrent: 1` limit. The toolkit requires at least 25 GB free and reports CPU, memory, disk, service, and remote
runner status.

## Blocker and completion boundary

GitHub reports this repository as **public**, while the requested architecture and toolkit require a private
repository and prohibit untrusted PR code on persistent runners. Registering the daily-use laptop would expose local
files and credentials to workflow code. Accordingly:

- management tooling, safety gates, dry-run behavior, status, health, cleanup, recovery, and documentation are built;
- no runner token was persisted and no runner was registered;
- no service, ACL, firewall, repository setting, workflow, release, or deployment was changed;
- existing required CI behavior remains intact;
- workflow migration and live pilot validation are blocked until the repository becomes private or a dedicated
  disposable VM runner is supplied.

Final status: **Partially Completed**. The outstanding actions are (1) choose private visibility or disposable VM
isolation, (2) run setup inside that boundary, (3) add a non-publishing trusted-push/manual pilot, (4) validate local
logs/artifacts/offline queuing, and only then (5) migrate the compatible Windows job subset.
