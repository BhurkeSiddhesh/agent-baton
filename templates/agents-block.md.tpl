## Agent Baton workflow

{{#if project.name}}Project: {{project.name}}.{{/if}} This repository coordinates AI coding agents with Agent Baton. Work is split into packets with exact file ownership. State lives in `.baton/` (plan, ledger, config). Command prefix: `{{cli}}`.

{{> roster}}

{{> protocol}}

{{> rules}}

{{> commands}}

Role prompts for agents without native commands: `{{cli}} prompt <orchestrator|worker|reviewer|auditor> --agent <you>`.
