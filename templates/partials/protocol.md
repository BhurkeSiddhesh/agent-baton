Baton protocol. The ledger decides what is ready, not memory or chat.

1. Session start: run `{{cli}} check`, then `{{cli}} next --agent <you>`. `<you>` is your roster id (or set `BATON_AGENT`).
2. Run `{{cli}} begin <packet> --agent <you>` before the first write. Touch only files in the packet's `owns` plus coordination paths. Need another file: `{{cli}} bus post --from <you> --type REQUEST --text "..."` or ask the orchestrator. Do not edit it.
3. Work until every done check is true. If blocked: `{{cli}} block <packet> --agent <you> --reason "..." --question "..."` with a specific question, then take a stretch packet or run `{{cli}} next --agent <you>` again. Long work: `{{cli}} heartbeat <packet> --agent <you>`.
4. Sign-off: `{{cli}} verify <packet>`, paste the real command output into the PR or handoff note, then `{{cli}} submit <packet> --agent <you> --note "..."`. Unverified completion claims count against you in `{{cli}} scores`.
5. A different agent reviews: `{{cli}} review <packet>`, run the checks yourself, then `{{cli}} accept <packet> --by <you>`, `{{cli}} fix <packet> --by <you>` or `{{cli}} reject <packet> --by <you>` with findings that carry evidence (file:line or a failing command) and a suggested fix.
6. Auditors file findings and never edit audited files. Authors fix findings and run `{{cli}} finding resolve <FID> --by <you> --resolution fixed`. The filer confirms with `--confirm`.
7. Repeated rejections escalate the packet to the orchestrator (`escalateAfterRejections` in `.baton/config.json`).
8. The orchestrator plans (`{{cli}} split`, `{{cli}} plan add`, `{{cli}} plan import`), assigns, keeps the queue a few packets deep, rotates reviewers and closes the day with `{{cli}} digest`. It never overrides repository rules or human gates.
9. Empty queue: audit mode. `{{cli}} next --agent <you>` lists audit targets.
