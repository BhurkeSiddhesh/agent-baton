Rules.

- Write only inside the packet's `owns` plus coordination paths (`.baton/ledger/`, `.baton/state/`, `.baton/views/` and the `coordination` list in `.baton/config.json`). The guard hook, `{{cli}} verify` and CI flag everything else.
- Never commit secrets, tokens, credentials or raw private data. Tests use fixtures or synthetic data. Mark a deliberate false positive with `baton:allow-secret` on the same line.
- Never edit another agent's claim, bus message or ledger event. Append through the CLI only.
- Only the orchestrator changes the plan. Only a human opens or closes gates (`--by human`).
- Never review your own packet. Never claim completion without a passing `{{cli}} verify`.
- Do not force-push or hard-reset shared branches.
