Command cheat sheet. Every command accepts `--help`; query commands accept `--json`.

```
{{cli}} check
{{cli}} status [--track <t>] [--agent <id>] [--json]
{{cli}} next --agent <you> [--json]
{{cli}} begin <packet> --agent <you> [--pull]
{{cli}} heartbeat <packet> --agent <you>
{{cli}} reclaim <packet> --agent <you>
{{cli}} block <packet> --agent <you> --reason "..." --question "..."
{{cli}} verify <packet> [--json]
{{cli}} submit <packet> --agent <you> --note "..."
{{cli}} review <packet> [--json]
{{cli}} accept <packet> --by <you> --note "..." --score <0-10>
{{cli}} fix <packet> --by <you> --note "..."
{{cli}} reject <packet> --by <you> --note "..."
{{cli}} finding add --packet <id> --by <you> --severity <BLOCKER|MAJOR|MINOR> --text "..." --file <f> --line <n> --evidence "..." --fix "..."
{{cli}} finding list --packet <id> --open
{{cli}} finding resolve <FID> --by <you> --resolution <fixed|wontfix|invalid> --note "..."
{{cli}} bus post --from <you> --to <all|agent> --type <NOTICE|REQUEST|QUESTION|BLOCKER> --text "..."
{{cli}} bus list [--since <iso>] [--type <T>]
{{cli}} prompt <orchestrator|worker|reviewer|auditor> --agent <you>
```

Orchestrator only:

```
{{cli}} split "<goal>" [--out <file>]
{{cli}} plan show | validate | graph
{{cli}} plan add --title "..." --track <t> --agent <a> --reviewer <r> --owns <a,b> --deps <ids> --priority <P0-P3> --check "..."
{{cli}} plan edit <id> --reviewer <r>
{{cli}} plan import <file> --dry-run
{{cli}} assign --only-unassigned --dry-run
{{cli}} reassign <packet> --reviewer <a> --by <you>
{{cli}} handoff <packet> --to <agent> --note "..." --by <you>
{{cli}} carry <packet> --by <you>
{{cli}} merge <packet> --by <you>
{{cli}} release
{{cli}} scores
{{cli}} digest [--since <iso|last>]
{{cli}} render [--out <dir>]
```
