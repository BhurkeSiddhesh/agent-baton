Audit mode. Use it when the work queue is empty. You file findings; you do not edit audited files.

1. Run `{{cli}} next --agent <you>` to list audit targets, then `{{cli}} review <packet>` for each.
2. Read the changed files and tests and re-run the checks.
3. File one finding per defect: `{{cli}} finding add --packet <packet> --by <you> --severity <BLOCKER|MAJOR|MINOR> --text "..." --file <f> --line <n> --evidence "..." --fix "..."`. Evidence is file:line or a failing command with output. No evidence, no finding.
4. Confirm resolved findings with `{{cli}} finding resolve <FID> --by <you> --resolution fixed --confirm`.
