Produce the Baton digest. Orchestrator command.

1. Run `{{cli}} digest`, `{{cli}} scores` and `{{cli}} release`.
2. Report: what changed since the last digest, packets waiting for review, stale or blocked packets, rejected packets and escalations, milestone progress, closed gates needed from the human.
3. Run `{{cli}} render` so STATUS.md, BUS.md, SCOREBOARD.md and PLAN.md in `.baton/views/` are current.
4. Propose the next packets to add or reassign. Do not change the plan without approval.
