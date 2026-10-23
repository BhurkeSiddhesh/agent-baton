# Multi-agent security model

**Status:** Current implementation (v0.1.x); reviewed against the CLI source on 2026-10-13. This is a *threat model*, not a security certification.

**Agent Baton is not a sandbox, an identity provider, or a security boundary around a coding agent.** It coordinates work and detects certain mistakes. An agent or contributor with filesystem, shell, Git, or GitHub write access can bypass its advisory controls. Never give an untrusted agent broader permissions because Baton is installed.

This document identifies who can influence a Baton workflow, which checks execute in code, what remains advisory, and where a separate system must enforce policy. See [SECURITY.md](../SECURITY.md) for private vulnerability reporting and [the implementation spec](internals/SPEC.md) for protocol details.

## Scope, assets, and assumptions

The modeled workflow is: human feature request → optional agent-produced proposal → approved plan and packet assignment → worker in a repository/worktree → `verify` and `submit` → distinct named reviewer → `accept` → local `merge` or hosted PR integration → publication of the ledger mirror.

**Assets worth protecting:** source code and release artifacts; repository and home-directory files; credentials in the runner environment; CI secrets and GitHub permissions; trusted tests; the plan and config; packet verdicts, reviewed commit IDs and event history; availability and integrity of the integration branch.

**Threat actors / inputs:**
- A well-intentioned agent that makes a mistaken edit, follows an instruction embedded in a source file, or produces an incorrect verdict.
- An adversary who controls an issue, PR description/comment, README, retrieved document, test output, generated proposal, or other lower-trust text.
- A malicious contributor/agent able to modify worktree files, Git commits, config/plan, the ledger, or shell commands.
- A compromised agent CLI, dependency, executable on `PATH`, GitHub Action, third-party action, or GitHub token.

**Assumptions:** Baton runs with the invoking user's OS and Git permissions; actor names such as `--agent codex` and `--by human` are *caller assertions*, not authenticated identities. One Git clone's worktrees share a local store; independent clones exchange ledger events only when changes are committed and synchronized. The core CLI does not issue its own cloud credentials, but `split --run` and `dispatch` invoke externally authenticated tools, and `verify` executes the configured test command.

## Trust boundaries and crossing points

| Boundary | Lower-trust input | What Baton actually does | What it does **not** guarantee |
|---|---|---|---|
| Human → planner | Natural-language goal, issue or feature brief | `split` prepares a prompt; optional runner writes a proposal; `plan import` requires a separate action and validates plan structure | Proposal contents are not trusted facts; user approval and policy review are not automatic |
| Repository/GitHub → agents | Source, docs, PR/issue text, review comments, tool outputs | Adapters tell agents to use `AGENTS.md`, scoped packets and the protocol | Prompt injection resistance, safe tool selection, or correct interpretation of instructions |
| Orchestrator → worker | Editable config, plan, assigned `owns` paths | `check` validates plan semantics; `begin` records a lease; `verify` detects changed paths beyond scope | OS-level file isolation, authenticated actors, or containment of a worker with shell access |
| Worker → OS/processes | Filesystem writes; custom agent runners; `test.command` or packet `test` | `verify` runs tests with timeout; `guard` can warn/block selected file-edit tool calls when configured | Shell command allowlisting, process/network sandboxing, or secret isolation |
| Worker → reviewer | Commits, reported tests, sign-off, ledger events | State machine requires a different **named** reviewer; `accept` rejects open major/blocker findings | A genuinely independent human or provider identity; trustworthy evidence from a hostile runner |
| Ledger/mirror → consumers | JSON events, hashes, timestamps, recorded verdicts | `ledger verify` checks event hashes and compares local/mirror copies when present | Signatures, authorship, tamper resistance against a committer, recovery of all deleted events, or consensus across clones |
| Local merge → hosted GitHub | Accepted commit, branch tip, CI status and PR reviews | `merge` constrains local integration to an accepted, fast-forwardable commit and checks ancestry | GitHub branch protection, required hosted reviewers/checks, token permissions or platform approval |
| Generated cloud workflow → GitHub runner | Issue triggers, actions, secrets and agent tool invocations | Templates reference configured GitHub secrets and set workflow permissions | Safe execution of third-party action code, trustworthy issue content, or protection from an agent granted repository write access |

## Control inventory: enforcement vs guidance

These distinctions describe the **current implementation**, not the intended eventual policy engine.

| Control | Implemented behavior | Enforcement boundary / limitation |
|---|---|---|
| Plan path and reviewer validation | `plan import`/`check` validate packet ownership, protected paths and reviewer distinctness | Enforced for accepted plan state; a privileged writer can change files outside the plan |
| Per-packet scope | `verify` classifies changed files, checks protected/foreign paths, and blocks a passing verification on violations | Enforced **at verification**, not as real-time OS write prevention; only the files/mode observed at the gate are checked |
| Execution profiles | Packets and agents declare least-privilege profiles (`read-only`, `workspace-write`, `review-only`, `privileged`); `guard` blocks unauthorized file edits, shell execution and network access; plan validation rejects unauthorized privilege escalation | Enforced by tool hook and plan validation; does not provide OS kernel or hardware sandbox isolation. Baton discloses unsupported enforcement rather than feigning OS containerization |
| Optional edit guard | `guard` uses path normalization and checks configured ownership; mode is `off`/`warn`/`block`, default `warn` | Intercepts only supported hook tool calls; missing/unparseable JSON and non-file tools may be allowed; shell writes bypass it; paths outside repo are not guarded |
| Secret scanning | `verify` examines changed files and, on branch verification, relevant commit history for recognizable secret patterns | Heuristic detection, not DLP; misses unknown patterns, external files, environment variables and data sent directly over the network |
| Test gate | `verify` uses the project's or packet's configured test command and records a commit/fingerprint-bound marker | `spawn(..., { shell: true })` executes configured project tests with the caller's authority; imported packet tests require explicit `--allow-shell`, but tests/output can still be malicious or forged |
| Agent separation and provenance | Author and reviewer cannot be the same **roster ID** under the state machine; execution provenance records verified runtime context, declared trust levels (`github-verified`, `ci-environment`, `local-unverified`), and session IDs on all ledger events; `requireActorMatch` guards against GitHub Actions identity spoofing | `--agent`, `--by` and `BATON_AGENT` do not authenticate arbitrary local OS callers; local unverified runs are explicitly marked as such rather than pretending to provide strong authentication |
| Ledger integrity | Each event includes a SHA-256 of its content; a verifier checks inconsistent hashes/copies; sensitive replay (transitions and merge) fails closed on tampered records | Unkeyed SHA-256 hash is an integrity check, not a signature: an attacker who can rewrite events can recompute hashes; optional asymmetric attestation (`sig`) can be configured for cryptographic authenticity |
| Merge restrictions | Local `merge` requires `ACCEPTED` and ancestry compatible with a fast-forward of the reviewed commit; fails closed if any unacknowledged ledger integrity errors exist | Does not consult GitHub's mandatory CI/review policies; a user with `git push`/branch admin rights can bypass Baton entirely |
| GitHub dispatch | `dispatch` invokes `gh issue create` with argument arrays; `split --run` invokes an external agent CLI | Neither command makes the remote provider or its generated prose trusted; custom `split --run` and `verify` test strings cross a shell boundary |

**Terminology:** “enforced” above means *the relevant Baton command rejects the action when invoked with the inspected state*. It does not mean that a malicious OS user or compromised runner cannot bypass the command.

## Threat scenarios and mitigations

| ID / severity | Abuse case | Consequence | Present mitigation | Required external control / remaining gap |
|---|---|---|---|---|
| T1 — Critical | An issue, source comment or retrieved document instructs a worker to ignore `AGENTS.md` or expose credentials | Unauthorized tool use, exfiltration or malicious code | Explicit packet instructions, approval of proposed plans, post-change verification | Treat content as data; isolate untrusted agents, restrict network/secret access and require human review of privileged operations |
| T2 — Critical | A malicious plan imports `test` as a shell command; or a trusted config gains an unsafe `test.command` | Arbitrary command execution at `verify` | Packet-defined tests now require explicit `verify --allow-shell`; project-level tests still run under the caller with a timeout | Review the exact packet command before opting in; untrusted **project** config remains an executable shell boundary. Run tests without production credentials in sandboxed CI; see [#11](https://github.com/BhurkeSiddhesh/agent-baton/issues/11) |
| T3 — High | An agent edits through a shell, unsupported tool, direct Git operation, symlink or hook bypass | Files outside packet ownership are changed | Scope verification catches *observed* changes; optional hook can block known edit calls | File-system isolation and branch protection are external; treat the hook as best effort; see [#15](https://github.com/BhurkeSiddhesh/agent-baton/issues/15) |
| T4 — High | One user supplies both worker and reviewer roster IDs and self-accepts | Forged “independent” sign-off | Author/reviewer roster-ID inequality | Authenticate review via GitHub identities, CODEOWNERS and protected review policy; see [#13](https://github.com/BhurkeSiddhesh/agent-baton/issues/13) and [#14](https://github.com/BhurkeSiddhesh/agent-baton/issues/14) |
| T5 — High | A writer rewrites the ledger, recomputes event hashes or deletes all copies of an event | Fabricated approvals, missing audit history or inconsistent decisions | Hash checks, duplicate event IDs, mirror/local comparison when both exist | Git history, immutable/remote append-only logging, signed provenance, restricted write permissions; see [#29](https://github.com/BhurkeSiddhesh/agent-baton/issues/29) |
| T6 — Critical | A GitHub workflow executes attacker-controlled PR content with a write token or secret access | Repository compromise or secret disclosure | Template workflow permissions and explicit external secret references | Use read-only PR checks, avoid privileged `pull_request_target` checkout, pin actions, restrict agents' tokens, require human approval for secrets |
| T7 — High | A reviewer accepts one SHA, then a changed branch or an unverified ancestry is integrated | Review/CI bypass, unreviewed release | Local `merge` checks accepted commit and fast-forward ancestry | Require GitHub branch rules, protected tags, checks on the exact commit and stale-approval dismissal; see [#5](https://github.com/BhurkeSiddhesh/agent-baton/issues/5) and [#14](https://github.com/BhurkeSiddhesh/agent-baton/issues/14) |
| T8 — Medium | Parallel agents on separate clones believe they both own a lease before synchronizing | Conflicting edits, misattribution or lost work | Worktree-local lock and ledger replay | Shared server-side lease authority or coordinator; synchronize state before claims and integration |
| T9 — High | A fake test transcript, prompt injection in CI logs or forged tool response persuades reviewer to accept | False security assurance | Review instructions, verification marker and findings workflow | Reviewer re-runs trusted checks, inspects diff and independently verifies commit and CI provenance |

Severity assumes the attacker can influence the described input, not that the weakness is remotely exploitable in every installation.

## Minimum safe deployment policy

1. **Separate execution from authorization.** Use isolated disposable worktrees or containers for coding agents. Keep production credentials out of the working environment; pass only minimal, short-lived tokens, restrict egress and run as a non-privileged OS user.
2. **Review proposals before importing.** Inspect every `owns` path, gate, packet `test`, config `test.command` and runner command. Treat prompts, issues, generated JSON and tool output as untrusted even if generated by a familiar agent.
3. **Keep review independent outside Baton.** Require GitHub PR reviews from an actual different account for sensitive changes; restrict branch pushes, protect releases/tags, require green CI, and dismiss stale approvals. Local `--by` strings are not sufficient proof.
4. **Verify exact code.** Compare the commit SHA in the PR, Baton verification marker and protected CI results. Do not accept a pasted “tests passed” message as evidence. Re-run meaningful checks in a trusted runner.
5. **Handle events as evidence, not authority.** Run `baton ledger verify` and publish `.baton/ledger/` as part of the integration workflow. Preserve Git audit history externally. Investigate missing, duplicated or divergent events.
6. **Use the guard only as defense in depth.** `guard.mode=block` is useful for supported edit hooks, but cannot stop direct shell writes. If an agent needs untrusted execution, sandbox its *process*, not just its file-edit calls.
7. **Treat cloud workflows as executable code.** Review generated YAML, permissions, third-party actions, trigger context and secrets before enabling them; never give PR-originated/untrusted code access to high-privilege tokens.

## Reproducible security review checklist

These checks should be performed on a throwaway repository and **not** on a machine with live credentials.

- [ ] Inject an irrelevant “ignore the plan” instruction into an issue or proposal; confirm human/agent reviewers do not treat it as authoritative over repository policy.
- [ ] Try to add a packet `owns` path covering `.env` or `.git/`; check that plan validation rejects it.
- [ ] With an owned-file hook configured, test `guard.mode=warn` and `block` against an out-of-scope edit. Repeat with invalid JSON and a shell write; **document that those paths are not contained**.
- [ ] Test `verify` on an out-of-scope change; confirm the marker is not a passing, submittable verification. Check that `--no-tests` cannot authorize `submit`.
- [ ] Make an event hash mismatch in a **copy** of a ledger and run `baton ledger verify`; confirm the verifier detects it. Do not claim this authenticates event authors.
- [ ] Supply a suspicious packet test command in a proposal and confirm the reviewer flags it **before** invoking `verify`; do not execute hostile commands.
- [ ] Confirm GitHub branch rules require verified CI, true external reviews and no routine force pushes. Check workflow permissions and ensure PR-origin code cannot access deployment secrets.
- [ ] Simulate a stale PR head after review and confirm the host rejects unapproved or unchecked new commits.

## Residual risks and ownership

Until identity provenance, hosted-policy binding, stronger runner isolation and tamper-evident remote auditing are implemented, **Baton must not be used as the sole approval or containment mechanism for production changes**. No combination of local SHA-256, agent instructions, hook modes or a second agent name can establish execution trust on a host the same actor controls.

Maintain this model as commands change. A new subprocess, GitHub integration, trust boundary or ability to accept/merge work should be reflected here and in [SECURITY.md](../SECURITY.md). Follow-up implementation is tracked in [#11](https://github.com/BhurkeSiddhesh/agent-baton/issues/11), [#12](https://github.com/BhurkeSiddhesh/agent-baton/issues/12), [#13](https://github.com/BhurkeSiddhesh/agent-baton/issues/13), [#14](https://github.com/BhurkeSiddhesh/agent-baton/issues/14) and [#15](https://github.com/BhurkeSiddhesh/agent-baton/issues/15).
