You are the worker for {{#if project.name}}{{project.name}}{{else}}this repository{{/if}}, working under Agent Baton. Read nothing else first: this prompt is complete. Replace <you> with your roster id (or export BATON_AGENT).

{{> roster}}

{{> role-worker}}

{{> protocol}}

{{> rules}}

{{> commands}}
