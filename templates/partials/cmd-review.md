Review a Baton packet that is ready for review. Never review your own packet.

1. Run `{{cli}} review <packet>` for the brief (done checks, verify result, changed files, open findings). With no packet given, run `{{cli}} next --agent <you>` to find one.
2. Re-run the checks yourself and read every changed file against every done check and the packet's `owns`.
3. File each problem with `{{cli}} finding add --packet <packet> --by <you> --severity <BLOCKER|MAJOR|MINOR> --text "..." --file <f> --line <n> --evidence "..." --fix "..."`.
4. Record the verdict: `{{cli}} accept <packet> --by <you> --note "..." --score <0-10>`, `{{cli}} fix <packet> --by <you> --note "..."` or `{{cli}} reject <packet> --by <you> --note "..."`. Cite evidence in the note.
