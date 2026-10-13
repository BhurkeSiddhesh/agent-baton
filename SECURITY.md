# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting:
<https://github.com/BhurkeSiddhesh/agent-baton/security/advisories/new>. If that is unavailable, contact the maintainer
through the email on the GitHub profile of [BhurkeSiddhesh](https://github.com/BhurkeSiddhesh) with the subject
"agent-baton security".

Include the version (`baton version`), your OS and Node version, what you did, what you expected and what happened.
You will get an acknowledgement within a few days. Fixes are released as patch versions and credited in
[CHANGELOG.md](CHANGELOG.md) unless you prefer otherwise.

## Supported versions

See [governance and compatibility policy](docs/GOVERNANCE.md) for the security fix approval, hotfix exception, schema migration and release responsibilities. Private vulnerability reports should not be duplicated into public issue descriptions.

Only the latest released version receives security fixes while the project is below 1.0.

## Threat model and design

Agent Baton is a local, offline CLI that coordinates files in your repository. **It is not a sandbox or authenticated authorization mechanism.** Its checks mitigate accidental workflow violations, not malicious agents with the invoking user's shell or Git permissions.

The canonical [multi-agent security model](docs/SECURITY_MODEL.md) documents the assets, actor trust boundaries, attack scenarios, **enforced versus advisory** controls, deployment mitigations and residual risks. Review it before granting coding agents filesystem, network, credential or GitHub write access.

- **No network, no credentials.** The tool makes no network calls and never reads tokens. `baton dispatch` and
  `baton split --run` run your own `gh` and agent CLIs (both support `--dry-run`); their authentication is yours.
- **No runtime dependencies.** Nothing is installed besides baton itself, which reduces supply-chain exposure.
- **Writes stay inside the repository.** Every path the installer writes passes a check that refuses anything outside the
  repository root. Existing files are never overwritten unless unmodified or `--force`, and `uninstall` removes only files
  whose hash still matches the manifest.
- **Secret scan.** `baton verify` scans changed files (and commit history in branch mode) for AWS, Google, GitHub, Slack,
  OpenAI and Anthropic keys, private keys and generic token assignments. It is a safety net, not a guarantee.
- **Protected paths.** Env files, keys, certificates, credential files and databases cannot be owned by a packet.
- **Guard hook.** `baton guard` resolves `..`, absolute paths, backslashes and symlinks, denies symlinks escaping the
  repository and, on Windows, trailing dots and stream names. Invalid input fails open with a warning, so treat the hook as
  a guardrail, not a sandbox: an agent with shell access can still write files.
- **Ledger integrity.** Each event carries a SHA-256; `baton check` detects edited events. Deleted events are detectable
  only by comparing the two ledger copies. The ledger is not a signed or tamper-proof audit log against a malicious
  committer.
- **Test command.** `baton verify` runs `test.command` from `.baton/config.json` through your shell. Treat that file like
  any build script: review changes to it in pull requests.
- **Cloud workflows.** Generated GitHub workflows reference secrets (`ANTHROPIC_API_KEY`) and request minimal
  permissions; they never inline credentials. Review them before enabling.

## For contributors

Never commit secrets or personal data. Tests use fixtures and temporary directories only and never touch the network or
the home directory. See [CONTRIBUTING.md](CONTRIBUTING.md).
