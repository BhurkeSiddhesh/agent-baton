Plan work with Baton. You act as the orchestrator for this task.

1. If a goal was given: run `{{cli}} split "<goal>"`, read the prompt it prints, and answer it with exactly one JSON plan proposal. Save it to `.baton/proposals/draft.json`.
2. Run `{{cli}} plan import .baton/proposals/draft.json --dry-run`. Fix every error and warning, then show the human the packet list (id, title, agent, reviewer, owns) and wait for approval.
3. On approval run `{{cli}} plan import .baton/proposals/draft.json`, then `{{cli}} plan validate` and `{{cli}} check`.
4. If no goal was given: run `{{cli}} plan show`, `{{cli}} plan graph` and `{{cli}} status`, then report gaps, missing reviewers and the next packets to add.

Only the orchestrator changes the plan. Do not open gates.
