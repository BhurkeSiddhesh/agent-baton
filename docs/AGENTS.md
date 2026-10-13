[Agent Baton](../README.md) / [Docs](../README.md#documentation) / Agents

# Agents

How each supported agent is set up, which files `baton init` writes for it, and how to add an agent baton does not know.
All generated files are thin: they point at `AGENTS.md` and at the baton command, so the protocol lives in one place.
`{cli}` below is the command prefix, `node .baton/runtime/bin/baton.js` by default (set in `config.runtime.command`).

## Choosing the roster

```bash
baton init --agents auto                    # default: detected agents (pads to two, see below)
baton init --agents all                     # every built-in adapter
baton init --agents claude,codex,gemini     # explicit list (never padded)
baton agents list                           # roster plus detected CLIs and install hints
baton agents add gemini --roles worker,reviewer --strengths frontend,docs
baton agents set codex --roles worker,reviewer,auditor
baton agents remove gemini                  # refused if the plan references it, unless --force
baton agents install --only claude          # (re)write adapter files; --force overwrites edited ones
```

`auto` detects agent CLIs on `PATH` (`claude`, `codex`, `gemini`, `cursor-agent`/`cursor`, `copilot`, `windsurf`,
`aider`, `opencode`, `antigravity`) and existing agent directories or files (for example `.claude/`, `.cursor/`,
`.clinerules`). When fewer than two are found it pads the roster to claude then codex, because reviews must come from a
different agent than the author. Interactive confirmation appears only on a TTY and without `--yes`.

Default roles per kind: `claude` has all four roles; `codex` and `antigravity` are worker, reviewer and auditor; every
other built-in is worker and reviewer. Claude is the default orchestrator; change it with
`baton agents set <id> --orchestrator`, and adjust roles with `agents set <id> --roles ...`.

## What `init` writes

Always, regardless of agent:

| Path | Purpose |
|---|---|
| `AGENTS.md` | managed block (`<!-- baton:begin vN -->` ... `<!-- baton:end -->`) with the protocol, roster, rules and command cheat-sheet; your own content outside the block is preserved |
| `.baton/config.json`, `.baton/plan.json` | roster and settings; empty valid plan |
| `.baton/prompts/{orchestrator,worker,reviewer,auditor}.md` | standalone role prompts |
| `.baton/LICENSE` | upstream MIT notice for all generated adapter files (also when using `--no-vendor`) |
| `.baton/runtime/` | vendored copy (`bin/`, `src/`, `templates/`, `package.json`, `LICENSE`) so no install is needed |
| `.baton/baton`, `.baton/baton.cmd` | shell and Windows shims for the runtime |
| `.baton/manifest.json` | every file written, with SHA-256 and whether it is a managed block |
| `.gitignore`, `.gitattributes` | managed blocks: ignore `.baton/state/` and `.baton/views/`; mark the ledger generated and pin shim line endings (skipped with `--no-git-ignore`) |
| `package.json` | `"baton"` script added if the file exists |

Optional: `--hooks` merges the guard hook into `.claude/settings.json`; `--cloud` writes the GitHub workflows (see
[CLOUD.md](CLOUD.md)); `--docs` (automatic when a `docs/` folder exists) writes `docs/BATON.md`, a human-readable copy
of the protocol.

### Per agent

Roles are `orchestrator`, `worker`, `reviewer`, `auditor`. Commands are `plan`, `next`, `review`, `status`, `audit`,
`digest`.

| Agent | Files |
|---|---|
| **Claude Code** (`claude`) | `CLAUDE.md` (managed block that imports `@AGENTS.md`), `.claude/agents/baton-<role>.md` (4 subagents), `.claude/commands/baton-<cmd>.md` (6 slash commands, for example `/baton-next`), `.claude/skills/baton/SKILL.md` |
| **Codex CLI** (`codex`) | `AGENTS.md` (shared), `.codex/agents/baton-<role>.toml` (4 custom agents) |
| **Gemini CLI** (`gemini`) | `GEMINI.md` (managed block importing `@AGENTS.md`), `.gemini/commands/baton/<cmd>.toml` (6 commands, for example `/baton:next`) |
| **Antigravity** (`antigravity`) | `.agent/rules/baton.md`, `.agent/workflows/baton-<cmd>.md` (6), `.agents/skills/baton-<role>/SKILL.md` (4) |
| **Cursor** (`cursor`) | `.cursor/rules/baton.mdc` (`alwaysApply: true`), `.cursor/commands/baton-<cmd>.md` (6) |
| **GitHub Copilot** (`copilot`) | `.github/copilot-instructions.md` (managed block), `.github/agents/baton-<role>.agent.md` (4), `.github/prompts/baton-<cmd>.prompt.md` (6) |
| **Windsurf** (`windsurf`) | `.windsurf/rules/baton.md`, `.windsurf/workflows/baton-<cmd>.md` (6) |
| **Cline** (`cline`) | `.clinerules/baton.md` (skipped with a warning if `.clinerules` is a file rather than a directory) |
| **Aider** (`aider`) | `CONVENTIONS.md` (managed block), `.aider.conf.yml` only if absent |
| **OpenCode** (`opencode`) | `AGENTS.md` (native), `.opencode/agent/baton-<role>.md` (4) |

Run `baton init --dry-run --agents <ids>` to see the exact list for your roster before writing.

### Agent notes

- **Claude Code.** The subagents run the same protocol with a restricted tool list; use them from the main session
  (`use the baton-reviewer agent on WP-003`). With `--hooks`, a `PreToolUse` hook on `Edit|Write|MultiEdit` runs
  `{cli} guard --agent claude --hook claude`, which denies edits outside the packet when `guard.mode` is `block`.
  Set `BATON_AGENT=claude` if you run several agents in one shell.
- **Codex.** Reads `AGENTS.md` natively. The custom agents carry the role prompts. In cloud runs set `BATON_AGENT=codex`.
- **Gemini CLI.** Commands show up as `/baton:plan`, `/baton:next` and so on. `GEMINI.md` imports `AGENTS.md`.
- **Antigravity.** Rules, workflows and skills are workspace-scoped under `.agent/` and `.agents/`.
- **Cursor.** The rule is always on. The guard hook is not installed for Cursor; `{cli} guard --hook cursor` exists if
  you wire it into a Cursor hook yourself, and `verify` plus CI still enforce scope.
- **Copilot.** The coding agent reads `.github/copilot-instructions.md` and the agent and prompt files. Use
  `baton dispatch <id> --to copilot` to hand a packet to Copilot in the cloud, see [CLOUD.md](CLOUD.md).
- **Aider.** Add `read: [AGENTS.md, CONVENTIONS.md]` to your `.aider.conf.yml` if you already have one (baton does not
  edit an existing YAML file).
- **Anything with no adapter.** `baton prompt worker --agent <id>` prints a complete role prompt to paste or pipe in.

## Identity

An agent must identify itself on every command: `--agent <id>`, `--by <id>`, or `BATON_AGENT`. The adapter files tell the
agent to replace `<you>` with its roster id. For a tool that always runs as one agent, set the variable in its
environment (for example `BATON_AGENT: claude` in the workflow files). A roster entry's `id` need not equal its `kind`:
two Claude instances can be `claude-a` and `claude-b`, both `kind: claude`.

## Adding a custom agent

1. Add it to the roster:

   ```bash
   baton agents add aider-bot --kind custom --name "Aider bot" --roles worker --strengths python,tests
   ```

2. Declare how it reads instructions in `.baton/agents.json` (yours; baton never edits or removes it):

   ```json
   [
     {
       "id": "aider-bot",
       "label": "Aider bot",
       "instructionFile": "docs/AIDER_BOT.md",
       "templateDir": ".baton/templates/aider-bot"
     }
   ]
   ```

   - `instructionFile`: a repo-relative file that receives the baton managed block (created if missing, your own text
     outside the block is kept).
   - `templateDir`: an optional directory of `*.tpl` files. Each is rendered and written to the same relative path with
     `.tpl` removed; the file name itself may use variables.

3. Write the templates. The template language is small: `{{var}}`, `{{#if path}}...{{else}}...{{/if}}`,
   `{{#each list}}{{this}} {{this.field}} {{@index}}{{/each}}`, `{{> partial}}` and `{{! comment }}`. Variables:
   `project.name`, `project.description`, `cli`, `agents` (each with `id`, `name`, `kind`, `roles`, `strengths`),
   `orchestrator`, `testCommand`, `roles`, `cmds`, `baton.version`, and `agent` (`{id, name, kind, label}`).
   Partials come from the templates directory's `partials/` folder (`protocol`, `rules`, `commands`, `roster`, `role-*`,
   `cmd-*`); a minimal file is
   `{{> protocol}}` followed by `{{> rules}}`.

4. `baton agents install --only aider-bot` to write the files, then `baton doctor`.

An agent whose kind has no adapter and no declaration is not an error: `init` prints a notice and skips its files.

## Install hints

`baton agents list` and `baton doctor` print an install hint for every agent CLI they cannot find, for example
`npm install -g @anthropic-ai/claude-code` or `npm install -g @openai/codex`. A missing CLI is a warning, never an error.

## Removing it

`baton uninstall` removes only files whose content still matches the manifest and strips unedited managed blocks.
Edited files are kept and listed. See [FAQ.md](FAQ.md#how-do-i-uninstall).
