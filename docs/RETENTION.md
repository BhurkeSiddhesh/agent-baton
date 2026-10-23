[Agent Baton](../README.md) / [Docs](../README.md#documentation) / Ledger Retention & Archival

# Safe Ledger Retention and Archival

Agent Baton uses an append-only, event-sourced coordination ledger. Every packet transition, verification pass, code review, finding, and bus coordination message is recorded as an immutable JSON event with cryptographic checksums.

Over long-running multi-agent projects, hundreds or thousands of events accumulate. This document specifies the ledger lifecycle, event accumulation metrics, safe retention horizons, archive bundle specifications, restoration procedures, and privacy tradeoffs of committing agent metadata to Git mirrors.

---

## 1. Ledger Lifecycle

The Baton ledger operates on a dual-store architecture:

1. **Local Authoritative Store**: Located at `<git common dir>/baton/events/` (or `<root>/.baton/state/events/` in non-git repos). This store is local to the machine/worktree cluster and is locked during writes with POSIX/Windows file locks (`.baton/state/lock`).
2. **Tracked Git Mirror**: Located at `<root>/.baton/ledger/`. When `config.ledger.mirror` is enabled (the default), valid local events are mirrored to this directory so that teammates and remote AI agents can synchronize coordination state via standard Git fetches and merges (`git pull`, `baton ledger import`, `baton ledger reconcile`).

State is derived purely by replaying events over `.baton/plan.json` via `derive(plan, events)`:
```
PLANNED -> IN_PROGRESS -> READY_FOR_REVIEW -> ACCEPTED | ACCEPTED_WITH_FIXES | REJECTED
```

Each event file is named `<ts-prefix>-<random/seq-suffix>.json` (for example `20261023T101500Z-a1b2c3.json`) and carries:
- `id`: Deterministic append-ordered event identifier.
- `ts`: ISO 8601 UTC timestamp (monotonic, clamped to prevent backwards drift).
- `rev`: Sequential revision counter per stream.
- `parents`: Direct causal parent event IDs in the revision stream DAG.
- `sha`: SHA-256 hash of the event's canonical JSON (excluding `sha` and `sig`).

---

## 2. Event Accumulation Metrics & Compaction Triggers

### 2.1 Accumulation Velocity
In active multi-agent engineering workflows, event generation follows predictable ratios:
- **Per Packet**: 4–8 events (`begin`, `verify`, `ready`, `reviewer`, `verdict`, `merged`, optional `heartbeat` or `handoff`).
- **Per Audit Finding**: 2–3 events (`finding`, `finding_resolved`, confirmation).
- **Per Bus Message**: 1 event per coordination broadcast or claim.

A feature track containing 50 packets will generate 300–600 JSON files. Over multiple sprints, an unpruned ledger can reach tens of thousands of loose files.

### 2.2 Operational Costs of Inode Accumulation
- **Git Tree Bloat**: Every commit tracking `.baton/ledger/` records tree objects for all historical JSON files, slowing down `git status`, `git checkout`, and branch switches.
- **File System Inode Pressure**: Large directories with loose small files impact I/O performance on Windows NTFS and Linux ext4.
- **Replay Latency**: `readEvents` parses and validates hashes for all events across both stores on startup.

### 2.3 Recommended Compaction Triggers
Archival and pruning should be triggered at safe boundaries:
- **Milestone Completion**: When all packets under a milestone (`M1`, `M2`) have reached terminal `ACCEPTED` status.
- **Time Horizons**: Archiving events older than 30, 60, or 90 days (`--before <iso>`).
- **Ledger Size Threshold**: When the active event count in `.baton/ledger/` exceeds 1,000 events.

---

## 3. Safe Retention Horizons & Protection Invariants

Archiving or pruning an event ledger carries significant risk if live operations are truncated. Baton enforces four **strict retention invariants** that fail closed or automatically protect live records:

### Invariant 1: Active Packets Are Never Archived or Pruned
Any packet whose state is not in a sealed terminal status (`ACCEPTED`, `ACCEPTED_WITH_FIXES`) is considered **active**. Specifically:
- `IN_PROGRESS`
- `BLOCKED`
- `READY_FOR_REVIEW`
- `REJECTED`
- `CARRIED_OVER`
- `PLANNED` (with historical progress)

All events belonging to active packets are excluded from archival candidates and cannot be pruned from the active ledger.

### Invariant 2: Active Claims and Leases Are Strictly Guarded
Packets held under active leases or begin claims cannot be truncated. Any `begin` event with an active lease, any current claimant lock, and any unreleased `CLAIM` message on the bus is protected.

### Invariant 3: Unresolved Findings Block Archival
Audit findings with severity `BLOCKER`, `MAJOR`, or `MINOR` that remain in `open` or `resolved` (unconfirmed) status must stay in the active ledger. Both the finding events (`finding`, `finding_resolved`) and all events for the target packet are protected until the original filer confirms closure.

### Invariant 4: Causal DAG Continuity (No Broken Ancestry)
The Baton ledger forms a directed acyclic graph (DAG) where events point to `parents`. If historical event `E1` is archived and would be pruned, but a retained active event `E2` depends on `E1` as an ancestor, **`E1` is protected from pruning**. Pruning `E1` would break causal replay and cause `baton ledger verify` to report `missing causal parent`. Baton only prunes events whose entire downstream dependency tree has also been safely sealed and archived.

---

## 4. Archive Format Specification

Archived events are bundled into a self-contained, tamper-evident archive file adhering to the `baton-ledger-archive` format (version 1).

### 4.1 Canonical JSON Archive Structure
```json
{
  "format": "baton-ledger-archive",
  "version": 1,
  "archive_id": "ARCH-20261023T190000Z-a1b2c3",
  "created_at": "2026-10-23T19:00:00Z",
  "before": "2026-10-01T00:00:00Z",
  "generator": "baton ledger archive",
  "counts": {
    "events": 42,
    "manifest": 42
  },
  "manifest": [
    {
      "id": "20261020T100000Z-000001",
      "sha": "a1b2c3d4...",
      "ts": "2026-10-20T10:00:00Z",
      "kind": "begin",
      "packet": "WP-001"
    }
  ],
  "events": [
    {
      "id": "20261020T100000Z-000001",
      "ts": "2026-10-20T10:00:00Z",
      "packet": "WP-001",
      "kind": "begin",
      "to": "IN_PROGRESS",
      "by": "codex",
      "note": "start WP-001",
      "data": { "base": "c0ffee" },
      "hv": 1,
      "rev": 1,
      "parents": [],
      "sha": "a1b2c3d4..."
    }
  ],
  "checksum": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
}
```

### 4.2 Integrity Checksums
- **Event-Level**: Every individual event in `events` retains its canonical `sha` matching `eventSha(ev)`.
- **Archive-Level**: The top-level `checksum` is the SHA-256 of `canonicalJson(archive.events)`.
- **Compression**: When the archive path ends with `.gz` or `.tar.gz`, the bundle is compressed with gzip (`zlib.gzipSync`). Restoration transparently detects the gzip magic header (`0x1f 0x8b`) and decompresses on the fly.

---

## 5. Archival and Restoration Procedures

### 5.1 Creating an Archive (Dry-Run First)
Simulate archival to inspect eligible historical events and verify live protection counts:
```bash
baton ledger archive --before 2026-10-01T00:00:00Z --dry-run
```
Output:
```text
DRY RUN: no changes written to disk
archived 120 event(s) into .baton/archives/ledger-20261023T190000Z-a1b2c3.json
protected 15 live event(s) from archival
active ledger preserved unchanged (use --prune --confirm to prune)
```

### 5.2 Archiving Sealed Events (Without Pruning)
Creates a verifiable archive bundle while leaving the active ledger intact:
```bash
baton ledger archive --before 2026-10-01T00:00:00Z --out .baton/archives/sprint-1.json
```

### 5.3 Pruning Sealed Events from Active Ledger
Pruning removes the archived event files from `.baton/ledger/` and local `.baton/state/events/`. Pruning is strictly **opt-in** and requires explicit `--confirm`:
```bash
baton ledger archive --before 2026-10-01T00:00:00Z --out .baton/archives/sprint-1.json.gz --prune --confirm
```
Output:
```text
archived 120 event(s) into .baton/archives/sprint-1.json.gz (checksum: 8f4a1...)
protected 15 live event(s) from archival
pruned 120 event(s) from active ledger
```

Verify active store health after pruning:
```bash
baton ledger verify
# ledger ok
```

### 5.4 Restoring from an Archive
To restore historical events for an audit, score calculation, or retroactive inspection:
```bash
# 1. Preview restoration
baton ledger restore .baton/archives/sprint-1.json.gz --dry-run

# 2. Execute restoration
baton ledger restore .baton/archives/sprint-1.json.gz
# restored 120 event(s) from .baton/archives/sprint-1.json.gz (0 already present)
```

### 5.5 Fail-Closed Tamper Detection
Restoring an archive automatically validates:
1. Valid JSON and archive schema version 1.
2. Global archive SHA-256 checksum agreement.
3. Every event's individual SHA-256 signature and event schema validity.
4. Agreement with any existing local records (conflicting modifications fail immediately).

If any byte is modified or corrupted, restoration aborts without touching local state:
```text
Error [BatonError]: archive integrity check failed: sha mismatch on event 20261020T100000Z-000001
```

---

## 6. Privacy & Security Tradeoffs of Git Mirrors

When `config.ledger.mirror` is enabled, ledger events are committed into `.baton/ledger/` and pushed to Git remotes. While this enables decentralized multi-agent synchronization without a centralized database, teams must weigh the privacy and compliance implications:

| Factor | Git-Mirrored Ledger | Local-Only / Archived Ledger |
|---|---|---|
| **Auditability** | Complete public commit history of all agent decisions and verdicts. | Kept locally or in restricted cold storage archives. |
| **Secret Exposure** | If an agent includes an API token or password in an event `note` or `finding`, it enters Git commit history and is difficult to purge. | Isolated to local machine or air-gapped archive bundles. |
| **Privacy / PII** | Developer names, GitHub usernames, and timestamps are permanently mirrored in Git commit graphs. | Can be scrubbed or retained within private operational boundaries. |
| **Right to Erasure (GDPR)** | Git commit histories cannot be mutated without force-pushing and rewriting branch trees for all contributors. | Archival files can be updated or redacted under compliance governance. |

### Recommendations:
1. **Never pass credentials in notes**: Ensure agents use environment variables or secret vaults. `baton verify` and `baton guard` run automated secret pattern scanners to block commits with credentials.
2. **Opt-out for sensitive projects**: For private repositories where agent commentary should not be mirrored to git remotes, set:
   ```json
   {
     "ledger": {
       "mirror": false
     }
   }
   ```
3. **Commit archives to cold-storage branches or release assets**: Keep active `.baton/ledger/` lean by periodically pruning sealed events and attaching verifiable `.json.gz` archives to GitHub releases or dedicated compliance storage.
