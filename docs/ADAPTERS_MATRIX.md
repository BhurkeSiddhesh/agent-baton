[Agent Baton](../README.md) / [Docs](../README.md#documentation) / Adapter Capability Matrix

# Agent Adapter Capability Matrix

This document provides the definitive, tested capability matrix for all agent adapters supported by Agent Baton. It establishes an auditable contract detailing the precise capabilities, file footprints, hook enforcement mechanisms, supported roles, cloud/CI readiness, and inherent runtime limitations of each adapter.

Baton adheres to a **truth-in-advertising** architectural principle: instruction-only adapters (such as Cursor, Windsurf, or Cline) are never misrepresented as autonomous background execution daemons. Baton provides the deterministic coordination, packet scoping, and ledger verification substrate; the agent runtime supplies the execution engine.

---

## High-Level Capability Overview

| Adapter | Vendor | Execution Category | Executable Runner CLI | Unattended Daemon | Supported Roles (O / W / R / A) | Hook Enforcement Dialect | Cloud / CI Readiness | Offline CLI Core |
|---|---|---|:---:|:---:|:---:|---|:---:|:---:|
| **Claude Code** (`claude`) | Anthropic | Interactive CLI Agent | Yes (`claude`) | No | Yes / Yes / Yes / Yes | `claude` (PreToolUse) | Medium-High | Yes |
| **Codex CLI** (`codex`) | OpenAI | Scriptable CLI Agent | Yes (`codex`) | No | Yes / Yes / Yes / Yes | `generic` (Shell / Env) | High | Yes |
| **Gemini CLI** (`gemini`) | Google | Interactive CLI Agent | Yes (`gemini`) | No | Yes / Yes / Yes / Yes | `generic` (Shell / Env) | Medium | Yes |
| **Google Antigravity** (`antigravity`) | Google DeepMind | Multi-Agent Runtime & IDE | Yes (`antigravity`) | Yes | Yes / Yes / Yes / Yes | `generic` + Rules & Bus | High | Yes |
| **Cursor** (`cursor`) | Anysphere | IDE Extension / Editor | No (Editor-driven) | No | Yes / Yes / Yes / Yes | `cursor` (JSON permissions) | Low | Yes |
| **GitHub Copilot** (`copilot`) | GitHub / Microsoft | IDE & Cloud Workflow | Partial (Cloud / CI) | No (Local) | Yes / Yes / Yes / Yes | `generic` (CI status checks) | High | Yes |
| **Windsurf** (`windsurf`) | Codeium | IDE Extension / Editor | No (Editor-driven) | No | Yes / Yes / Yes / Yes | `generic` (Post-step check) | Low | Yes |
| **Cline** (`cline`) | Cline Community | VS Code Extension | No (Editor-driven) | No | No / Yes / Yes / No | `generic` (Prompt & verify) | Low | Yes |
| **OpenCode** (`opencode`) | OpenCode Project | Scriptable CLI Agent | Yes (`opencode`) | No | Yes / Yes / Yes / Yes | `generic` (Shell / Env) | High | Yes |
| **Aider** (`aider`) | Paul Gauthier | Pair-Programming CLI | Yes (`aider`) | No | No / Yes / Yes / No | `generic` (Pre-commit / verify) | Medium | Yes |
| **Custom Agent** (`custom`) | User-defined | Extensible / Custom | Configurable | No | Yes / Yes / Yes / Yes | `generic` (Wrapper / verify) | Medium | Yes |

*Legend: O = Orchestrator, W = Worker, R = Reviewer, A = Auditor.*

---

## Architectural Taxonomy

To prevent architectural drift and misleading guarantees, Baton categorizes adapters across two distinct operational axes:

### 1. Instruction Surface vs. Executable Runner
- **Instruction Surface Only:** The adapter generates rule files, system prompts, or workflow definitions (e.g., `.cursor/rules/baton.mdc`, `.windsurf/rules/baton.md`, `.clinerules/baton.md`). These instruct an interactive human-in-the-loop AI editor how to behave within the Baton protocol. The adapter does not provide a standalone headless process runner to execute arbitrary scripts unattended.
- **Executable Runner Support:** The adapter interacts with an installed command-line executable (e.g., `claude`, `codex`, `gemini`, `opencode`) that can be invoked directly from the terminal or invoked programmatically in automation scripts.

### 2. Interactive Assistant vs. Unattended Background Daemon
- **Interactive Assistant / Batch CLI:** Requires explicit human activation, terminal command entry, or discrete task invocation. The process executes a single turn or interactive session and exits. It does not monitor external state or self-dispatch packets without an external controller.
- **Unattended Background Daemon:** Possesses an autonomous runtime engine capable of resident background execution, reactive message-driven wakeups, asynchronous subagent dispatch, and self-healing stale claim takeovers (e.g., Google Antigravity operating under the Durable Agent Constitution and Inter-Agent Bus).

---

## Hook Enforcement Mechanisms

Baton's `baton guard` command enforces packet ownership and least-privilege permission profiles at the tool-call boundary. It supports three distinct hook dialects specified via `--hook <dialect>`:

```
                                      +------------------------------------+
                                      |         Tool Call Invocation       |
                                      +------------------------------------+
                                                        |
                                                        v
                                          +--------------------------+
                                          | baton guard --hook <id> |
                                          +--------------------------+
                                                        |
                    +-----------------------------------+-----------------------------------+
                    |                                   |                                   |
                    v                                   v                                   v
          [ dialect: claude ]                  [ dialect: cursor ]                 [ dialect: generic ]
   stdin: Tool-call payload JSON        stdin: Tool-call payload JSON        stdin: Tool-call payload JSON
   - mode: "block" & violation:         - mode: "block" & violation:         - mode: "block" & violation:
     Write error to stderr               Emit JSON to stdout:                 Write error to stderr
     Exit status: 2                      { "permission": "deny", ... }        Exit status: 2
   - Allow: exit status 0                Exit status: 2                     - Allow: exit status 0
                                        - Allow: { "permission": "allow" }
```

### 1. `claude` Dialect
- **Target:** Claude Code configuration in `.claude/settings.json`.
- **Trigger:** Configured under `hooks.PreToolUse` for `Edit|Write|MultiEdit`.
- **Protocol:** Consumes tool-call JSON via `stdin`. On denial in `block` mode, writes `baton guard: blocked: ...` to `stderr` and exits with code `2`. Claude Code intercepts this exit code and cancels the tool invocation.

### 2. `cursor` Dialect
- **Target:** Cursor IDE composer / tool permission hooks.
- **Protocol:** Consumes tool-call JSON via `stdin`. Always emits a structured JSON response to `stdout`:
  ```json
  {
    "permission": "deny",
    "user_message": "baton guard: blocked: not owned by WP-001",
    "agent_message": "baton guard: blocked: not owned by WP-001"
  }
  ```
  Exits with code `2` on denial in `block` mode, or code `0` on approval (`"permission": "allow"`).

### 3. `generic` Dialect
- **Target:** Scripted CLI runners (Codex, OpenCode, Gemini, CI runners, pre-commit scripts).
- **Protocol:** Consumes tool-call JSON via `stdin`. On denial in `block` mode, writes a diagnostic error message to `stderr` and exits with code `2`. Standard zero exit code represents allowance.

---

## Detailed Adapter Profiles

### 1. Claude Code (`claude`)
- **Vendor:** Anthropic
- **Category:** Interactive CLI Agent
- **Instruction Surfaces:**
  - `CLAUDE.md`: Managed block importing `@AGENTS.md`.
  - `.claude/commands/baton-*.md`: Slash commands for `plan`, `next`, `review`, `status`, `audit`, `digest`.
  - `.claude/skills/baton/SKILL.md`: Skill definition providing protocol instructions.
- **Executable Runner Support:** Yes (`claude` CLI).
- **Unattended Daemon:** No. Interactive CLI session requiring user prompt or scripted headless invocation.
- **Role Support:**
  - `orchestrator`: Supported (`.claude/agents/baton-orchestrator.md`)
  - `worker`: Supported (`.claude/agents/baton-worker.md`)
  - `reviewer`: Supported (`.claude/agents/baton-reviewer.md`)
  - `auditor`: Supported (`.claude/agents/baton-auditor.md`)
- **Hook Enforcement:** Native `PreToolUse` hook in `.claude/settings.json` targeting file write and edit tools.
- **Cloud / CI Readiness:** Medium-High. Can be invoked in headless CI environments with `ANTHROPIC_API_KEY` and non-interactive flags.
- **Offline CLI Execution:** Baton core operates 100% offline. Model inference requires network access to Anthropic's API.
- **Limitations:** File-level hook does not prevent arbitrary shell commands unless restricted by the assigned Baton permission profile.

### 2. Codex CLI (`codex`)
- **Vendor:** OpenAI
- **Category:** Scriptable CLI Agent
- **Instruction Surfaces:**
  - `AGENTS.md`: Native instruction file.
  - `.codex/agents/baton-*.toml`: Custom agent definitions for `orchestrator`, `worker`, `reviewer`, `auditor`.
- **Executable Runner Support:** Yes (`codex` CLI).
- **Unattended Daemon:** No. Designed for batch or interactive task execution.
- **Role Support:** All four roles supported via structured TOML agent configurations.
- **Hook Enforcement:** Generic shell/environment wrapper (`BATON_AGENT=codex baton guard --hook generic`) and post-step `baton verify` gate.
- **Cloud / CI Readiness:** High. Clean CLI interface makes it directly scriptable in CI/CD runner pipelines.
- **Offline CLI Execution:** Baton core operates 100% offline.
- **Limitations:** Lacks an active pre-tool-call interception hook in the stock CLI; boundary enforcement depends on wrapper execution and verification gates.

### 3. Gemini CLI (`gemini`)
- **Vendor:** Google
- **Category:** Interactive CLI Agent
- **Instruction Surfaces:**
  - `GEMINI.md`: Managed block importing `@AGENTS.md`.
  - `.gemini/commands/baton/*.toml`: Command definitions for `plan`, `next`, `review`, `status`, `audit`, `digest`.
- **Executable Runner Support:** Yes (`gemini` CLI).
- **Unattended Daemon:** No.
- **Role Support:** Full command-driven role participation (`plan` for orchestrator, `next` for worker, `review` for reviewer, `audit` for auditor).
- **Hook Enforcement:** Generic wrapper and verify gates.
- **Cloud / CI Readiness:** Medium. Compatible with automated headless runner steps.
- **Offline CLI Execution:** Baton core operates 100% offline.
- **Limitations:** No built-in tool call interception hook in CLI; relies on post-step verify gates.

### 4. Google Antigravity (`antigravity`)
- **Vendor:** Google DeepMind
- **Category:** Multi-Agent Autonomous IDE & Agent Runtime
- **Instruction Surfaces:**
  - `.agent/rules/baton.md`: Constitutional operating rules.
  - `.agent/workflows/baton-*.md`: Workflow procedures for standard baton commands.
  - `.agents/skills/baton-*/SKILL.md`: Dedicated skills for `orchestrator`, `worker`, `reviewer`, and `auditor`.
- **Executable Runner Support:** Yes (Native Antigravity agent runtime).
- **Unattended Daemon:** Yes. Native background task execution, concurrent subagent orchestration, and reactive wakeup over `docs/AGENT_BUS.md`.
- **Role Support:** Native first-class support for all four roles via specialized subagents.
- **Hook Enforcement:** Constitutional rule compliance, AGENT_BUS claim enforcement, tool call validation, and `baton guard` execution.
- **Cloud / CI Readiness:** High. Containerized and cloud execution compatible.
- **Offline CLI Execution:** Baton core operates 100% offline.
- **Limitations:** Full multi-agent concurrent dispatch requires an Antigravity-compatible runtime environment.

### 5. Cursor (`cursor`)
- **Vendor:** Anysphere
- **Category:** IDE Extension / AI Code Editor
- **Instruction Surfaces:**
  - `.cursor/rules/baton.mdc`: Always-on rules configuration (`alwaysApply: true`).
  - `.cursor/commands/baton-*.md`: Command templates for baton tasks.
- **Executable Runner Support:** No. Operates strictly within the Cursor IDE editor interface.
- **Unattended Daemon:** No. Requires human-in-the-loop interaction in the editor.
- **Role Support:** Supports worker and reviewer directly; orchestrator and auditor via guided command templates.
- **Hook Enforcement:** `cursor` dialect JSON permission protocol (`baton guard --hook cursor`).
- **Cloud / CI Readiness:** Low. Desktop GUI application; cannot run headless in standard CI runners.
- **Offline CLI Execution:** Baton CLI commands run offline in the integrated terminal.
- **Limitations:** Instruction-only surface in local repository; not a background daemon.

### 6. GitHub Copilot (`copilot`)
- **Vendor:** GitHub / Microsoft
- **Category:** IDE Extension & Cloud Workflow
- **Instruction Surfaces:**
  - `.github/copilot-instructions.md`: Repository-wide instruction file.
  - `.github/agents/baton-*.agent.md`: Agent role definitions.
  - `.github/prompts/baton-*.prompt.md`: Structured prompt files for baton actions.
- **Executable Runner Support:** Partial. Local IDE extension is interactive; cloud dispatch runs via GitHub Actions and webhooks.
- **Unattended Daemon:** No local daemon. Cloud automations are event-driven.
- **Role Support:** All four roles supported via `.github/agents/*.agent.md`.
- **Hook Enforcement:** Generic CI check enforcement (`.github/workflows/baton-ci.yml`), branch protection gates, and PR review status checks.
- **Cloud / CI Readiness:** High. Deep integration with GitHub Actions and PR review workflows.
- **Offline CLI Execution:** Baton CLI runs offline. Copilot AI requires GitHub connectivity.
- **Limitations:** Local editor extension does not intercept tool calls pre-execution; boundary enforcement is managed at the CI gate.

### 7. Windsurf (`windsurf`)
- **Vendor:** Codeium
- **Category:** IDE Extension / AI Code Editor
- **Instruction Surfaces:**
  - `.windsurf/rules/baton.md`: Rule definition.
  - `.windsurf/workflows/baton-*.md`: Workflow definitions for baton commands.
- **Executable Runner Support:** No. Interactive editor interface.
- **Unattended Daemon:** No.
- **Role Support:** Worker and reviewer flows supported; orchestrator/auditor instruction-assisted.
- **Hook Enforcement:** Generic post-step verification (`baton verify`).
- **Cloud / CI Readiness:** Low. Desktop GUI application.
- **Offline CLI Execution:** Baton CLI runs offline in terminal.
- **Limitations:** Instruction surface only; no headless runner or background daemon.

### 8. Cline (`cline`)
- **Vendor:** Cline Community
- **Category:** VS Code Extension
- **Instruction Surfaces:**
  - `.clinerules/baton.md`: Single consolidated rules definition.
- **Executable Runner Support:** No standalone CLI. Operates within VS Code extension runtime.
- **Unattended Daemon:** No.
- **Role Support:** Worker and reviewer guided by instructions; orchestrator and auditor not partitioned into distinct agents.
- **Hook Enforcement:** Instruction-guided tool use and post-edit `baton verify`.
- **Cloud / CI Readiness:** Low. Tied to interactive VS Code GUI environment.
- **Offline CLI Execution:** Baton CLI runs offline.
- **Limitations:** Instruction surface only; single rule file without role partitioning.

### 9. OpenCode (`opencode`)
- **Vendor:** OpenCode Project
- **Category:** Scriptable CLI Agent
- **Instruction Surfaces:**
  - `AGENTS.md`: Native instruction file.
  - `.opencode/agent/baton-*.md`: Subagent definitions for all four roles.
- **Executable Runner Support:** Yes (`opencode` CLI).
- **Unattended Daemon:** No. Batch / CLI process.
- **Role Support:** All four roles explicitly defined.
- **Hook Enforcement:** Generic shell/environment wrapper and verify gates.
- **Cloud / CI Readiness:** High. Scriptable in CI runner containers.
- **Offline CLI Execution:** Baton core operates 100% offline.
- **Limitations:** No native PreToolUse interception hook; relies on wrapper and verification checks.

### 10. Aider (`aider`)
- **Vendor:** Paul Gauthier
- **Category:** Pair-Programming CLI
- **Instruction Surfaces:**
  - `CONVENTIONS.md`: Coding conventions block.
  - `.aider.conf.yml`: Aider configuration file.
- **Executable Runner Support:** Yes (`aider` CLI).
- **Unattended Daemon:** No. Interactive/scripted pair-programming session.
- **Role Support:** Worker and reviewer. Orchestrator and auditor are not natively supported.
- **Hook Enforcement:** Git pre-commit hooks and `baton verify`.
- **Cloud / CI Readiness:** Medium. Can be scripted in CI with `--message` and `--yes` flags.
- **Offline CLI Execution:** Baton core is fully offline.
- **Limitations:** Focused on direct git-oriented file modifications; lacks multi-agent subagent definitions.

### 11. Custom Agent (`custom`)
- **Vendor:** User-defined
- **Category:** Extensible Generic Agent
- **Instruction Surfaces:**
  - `AGENTS.md`: Shared protocol block.
  - `.baton/prompts/{orchestrator,worker,reviewer,auditor}.md`: Generic role prompts.
- **Executable Runner Support:** Dependent on user runner implementation.
- **Unattended Daemon:** No.
- **Role Support:** All four roles supported via generic prompt files.
- **Hook Enforcement:** `baton guard --hook generic` and `baton verify`.
- **Cloud / CI Readiness:** Medium. Dependent on user CI automation.
- **Offline CLI Execution:** Baton core is 100% offline.
- **Limitations:** Requires manual integration with external agent runner.

---

## Machine-Readable Specification

The full machine-readable schema and dataset matching this matrix is maintained in [`templates/matrix.json`](../templates/matrix.json). Automated tests in [`tests/adapter-matrix.test.js`](../tests/adapter-matrix.test.js) validate that every adapter in `templates/adapters.json` maintains parity with the matrix specifications.

---

## Related Documentation
- [Agents Overview](AGENTS.md): Setup, roster configuration, and generated template details.
- [Security Model](SECURITY_MODEL.md): Guard hooks, permission profiles, and boundary enforcement.
- [Compatibility Policy](COMPATIBILITY.md): Tested operating system, Node.js, and shell matrix.
- [Cloud & CI Workflows](CLOUD.md): GitHub Actions integration and cloud dispatch mechanics.
- [Governance Policy](GOVERNANCE.md): Project maintainership, RFC processes, and release authorization.
