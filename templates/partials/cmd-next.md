Pick up the next Baton packet for this agent.

1. Run `{{cli}} check`. Stop and report if it fails.
2. Run `{{cli}} next --agent <you>`. If it names a packet, run `{{cli}} begin <packet> --agent <you>`.
3. Read the packet with `{{cli}} plan show --json`: `description`, `reads`, `owns`, `done_checks`.
4. Implement inside `owns` only. When every done check is true: `{{cli}} verify <packet>`, then `{{cli}} submit <packet> --agent <you> --note "..."`.
5. If the queue is empty, switch to audit mode (`{{cli}} next --agent <you>` lists targets).
