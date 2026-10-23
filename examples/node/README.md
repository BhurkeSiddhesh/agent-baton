# Example: Node.js Integration with Agent Baton

This example demonstrates how an idiomatic Node.js ESM project integrates seamlessly with Agent Baton for multi-agent software engineering workflows.

## Project Structure

```text
examples/node/
├── .baton/
│   ├── config.json      # Baton project configuration & agent roster
│   └── plan.json        # Work packets, tracks, and verification gates
├── src/
│   └── calculator.js    # Feature implementation (ESM)
├── test/
│   └── calculator.test.js # Native node:test suite
├── package.json         # Package manifest with test script
└── README.md            # This documentation
```

## Running Tests

The project utilizes Node's built-in test runner (`node:test`), requiring zero external dependencies:

```bash
npm test
# or directly:
node --test test/**/*.test.js
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
   Make edits only within owned files (`src/calculator.js`, `test/calculator.test.js`).
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
