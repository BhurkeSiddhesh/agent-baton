Orchestrator: `{{orchestrator}}`.{{#if testCommand}} Test command: `{{testCommand}}`.{{/if}}

Roster:

{{#each agents}}
- `{{this.id}}` ({{this.name}}): roles {{this.roles}}; strengths {{this.strengths}}
{{/each}}
