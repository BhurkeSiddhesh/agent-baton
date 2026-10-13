## Agent Baton

@AGENTS.md

Baton coordinates agents through `.baton/`. Always start with `{{cli}} check` and `{{cli}} next --agent claude`, and never write before `{{cli}} begin <packet> --agent claude`.

Slash commands: /baton-plan, /baton-next, /baton-review, /baton-status, /baton-audit, /baton-digest. Subagents: baton-orchestrator, baton-worker, baton-reviewer, baton-auditor.
