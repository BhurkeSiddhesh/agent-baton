# Example: Python Integration with Agent Baton

This example demonstrates how a modern Python project integrates with Agent Baton for multi-agent software engineering workflows.

## Project Structure

```text
examples/python/
├── .baton/
│   ├── config.json       # Baton project configuration & agent roster
│   └── plan.json         # Work packets, tracks, and verification gates
├── src/
│   └── calculator.py     # Feature implementation
├── tests/
│   └── test_calculator.py # Native unittest test suite
├── pyproject.toml        # Project manifest & configuration
└── README.md             # This documentation
```

## Running Tests

Tests use Python's built-in `unittest` framework, requiring zero extra packages:

```bash
python -m unittest discover -s tests -p "test_*.py"
# or if using pytest:
pytest
```

## Baton Orchestration Flow

1. **Inspect Plan and Next Work**:
   ```bash
   baton plan
   baton next --agent codex
   ```

2. **Begin Assigned Work Packet**:
   ```bash
   baton begin WP-001 --agent codex
   ```
   This creates an isolated worktree branch for `WP-001` and acquires the lease.

3. **Develop & Verify**:
   Make edits only within owned files (`src/calculator.py`, `tests/test_calculator.py`).
   Verify all tests pass:
   ```bash
   baton verify WP-001 --agent codex
   ```

4. **Submit for Review**:
   ```bash
   baton submit WP-001 --agent codex
   ```

5. **Independent Peer Review**:
   The assigned reviewer (`claude`) examines changes and accepts or rejects:
   ```bash
   baton review WP-001 --agent claude --decision accept
   ```

6. **Merge to Main**:
   ```bash
   baton merge WP-001
   ```
