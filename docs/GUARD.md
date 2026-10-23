# Hook Guard Security & Dialect Guide

**Status:** Current implementation (v0.1.x)  
**Reference command:** `baton guard`  
**Area:** src/commands/guard.js, src/lib/glob.js

## 1. Overview

`baton guard` is an in-process, real-time tool-call hook interceptor designed to run in front of agent file-editing tools in AI coding environments (such as Claude Code, Cursor, and custom agent runtimes).

When configured, the hook inspects each proposed tool call payload on `stdin`, determines which file paths the tool would touch, resolves and normalizes those paths against the repository root, and verifies them against the active agent's `IN_PROGRESS` packet ownership in `.baton/plan.json`.

If a tool call attempts to modify files outside the agent's assigned scope or touches protected paths (such as `.git/`, `.env`, or credential stores), the guard warns or blocks the operation before the edit is performed.

---

## 2. Hook Dialects

`baton guard` supports three hook communication dialects via `--hook <dialect>`:

| Dialect | Flag | Contract | Typical Environment |
|---|---|---|---|
| **Claude Code** | `--hook claude` | If blocked: exits with code `2` and writes rejection guidance to `stderr`. Claude Code cancels tool execution and feeds `stderr` back to the model. | Claude Code `PreToolUse` hook (`.claude/settings.json`) |
| **Cursor** | `--hook cursor` | Emits JSON on `stdout`: `{"permission":"allow"}` or `{"permission":"deny","user_message":"...","agent_message":"..."}`. If denied, exits with code `2`. | Cursor agent hook integration |
| **Generic** | `--hook generic` | Exits with code `0` on allow, or exit code `2` with an explanatory message on `stderr` on block. | Custom orchestrators, pre-commit hooks, CI/CD runners |

---

## 3. Configuration & Enforcement Modes

The guard's behavior is configured in `.baton/config.json` under `guard`:

```json
{
  "guard": {
    "mode": "block",
    "failClosed": true
  }
}
```

### Modes (`guard.mode`)

- **`off`**: The guard is disabled. All tool calls are allowed without inspection.
- **`warn`** (default): Non-blocking advisory mode.
  - Edits to files owned by the agent's active packet: allowed silently.
  - Edits outside owned scope: allowed, but a warning is logged to `stderr`.
  - Unidentified actors (no agent specified): allowed.
  - Protected paths: a warning is emitted to `stderr`.
  - Unparsable JSON or unknown payload shapes: **fails open** with a warning on `stderr`.
- **`block`**: Enforcing mode.
  - Edits to files owned by the agent's active packet: allowed (exit `0`).
  - Coordination files (`.baton/ledger/`, `.baton/state/`, `.baton/views/`, and configured coordination paths): allowed (exit `0`).
  - Edits outside owned scope: **blocked** (exit `2`).
  - Protected paths: **unconditionally blocked** (exit `2`), regardless of packet ownership or agent identity.
  - Unparsable JSON or unknown payload shapes: **fails closed** (exit `2`).

### Fail-Open vs. Fail-Closed Behavior (`guard.failClosed`)

- When `guard.mode === 'block'`, `failClosed` defaults to `true`. Invalid JSON on `stdin` or unrecognized/corrupted tool payload shapes exit `2` and block execution.
- When `guard.mode === 'warn'`, `failClosed` defaults to `false`. Invalid JSON or unrecognized payload shapes emit a warning on `stderr` and exit `0` (allowing tool execution).
- `guard.failClosed` can be explicitly set in configuration to override the mode default.

---

## 4. Protected Paths

Protected paths are sensitive locations that must never be modified by automated agents:
- `.git/` directory and internal Git metadata
- Secrets and credentials: `.env`, `.env.*` (excluding `.env.example`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `*credentials*.json`, `client_secret*.json`, `token*.json`
- Local databases: `*.sqlite`, `*.sqlite3`, `*.db`
- Directories named `secrets/`
- User-defined protected patterns in `.baton/config.json` under `protected.globs`

### Unconditional Denial

In `block` mode, **protected paths are unconditionally denied**. Even if a packet in `plan.json` specifies broad or wildcard ownership (such as `owns: ["**"]` or `owns: [".env"]`), or if an agent runs under a privileged profile, the guard rejects writes to protected paths with an explicit message that protected paths cannot be edited.

---

## 5. Path Normalization & Anti-Traversal Hardening

To prevent directory traversal and evasion vectors, `baton guard` applies comprehensive multi-layer path normalization:

### 1. URL & Double-Encoded Traversals
Adversaries or unaligned agents may attempt to bypass regex/path filters by percent-encoding path separators or traversal sequences:
- Sequences like `%2e%2e%2f` (`../`), `%252e%252e%252f` (double-encoded `../`), `%2e%2e%5c` (`..\`), and `%2500` (double-encoded NUL byte) are iteratively decoded before lexical resolution.
- Any decoded path containing a NUL byte (`\0`) is immediately denied.

### 2. Windows UNC & Extended-Length Paths
- Windows extended-length prefixes (`\\?\` and `\\.\`) are safely mapped:
  - Extended drive paths (e.g., `\\?\C:\repo\file` or `\\.\C:\repo\file`) are converted to standard drive paths (`C:/repo/file`).
  - Extended UNC and device namespaces (e.g., `\\?\UNC\...`, `\\.\pipe\...`, `\\.\PhysicalDrive0`, `\\?\Volume{...}`) are rejected with `device or extended-length path form is not allowed`.
- Local UNC administrative shares (e.g., `//localhost/C$/...` or `//127.0.0.1/C$/...`) are mapped to the local drive letter.
- Remote network shares are identified and treated as outside the repository.

### 3. NTFS Alternate Data Streams (ADS)
On NTFS filesystems, files can contain secondary named data streams accessed via colons (e.g., `file.js:hidden`, `file.js::$DATA`, `dir:stream`).
- The guard inspects every path segment across all platforms. Any segment containing a colon `:` (outside the root drive specifier `^[a-zA-Z]:`) is denied with `path uses an NTFS alternate data stream`.

### 4. Symlinks & Directory Junctions
- Paths are resolved using `fs.realpathSync.native` across the longest existing path prefix (`realish`).
- Dangling symlinks and junctions (pointing to non-existent targets) are denied.
- Symlinks or junctions escaping the repository boundary are denied with `path resolves through a symlink to a location outside the repository`.
- Symlinks or junctions within the repository that point to protected paths (e.g., a symlink to `.git` or `.env`) are caught and blocked during canonical path verification.

### 5. Redundant Trailing Slashes, Dots, and Spaces
- On Windows/NTFS, Win32 APIs automatically strip trailing dots and spaces from filenames (e.g., `export.js.` and `export.js   ` open `export.js`).
- The guard strips trailing dots and spaces from filename segments to ensure identical resolution.
- Invalid dot sequences (such as `...` or `....`) are rejected.

---

## 6. Supported Tool Call Shapes

`baton guard` extracts targets from Claude, Cursor, and generic payloads, including:
- Top-level string fields: `file_path`, `filePath`, `path`, `file`, `notebook_path`, `target_file`, `source_file`, `dest_file`, `destination`, `target`, `filename`, `fileName`, `old_path`, `new_path`.
- URL schemes: `file://` URIs (e.g., `file:///C:/repo/src/api/export.js`).
- Batched edits: `files: [...]`, `edits: [...]`, `changes: [...]`, `documents: [...]`, `items: [...]`.
- Nested file objects: `{ file: { path: "..." } }`, `{ target: { file_path: "..." } }`, `{ edits: [{ file: { path: "..." } }] }`.

---

## 7. Known Bypass Surfaces & Limitations

> [!WARNING]
> **Baton guard is an advisory tool-call interceptor, not an operating system sandbox or security container.**
> The guard intercepts only editor-level tool calls routed through its hook. It does not control the OS kernel, process execution, or file system permissions.

The following bypass surfaces are inherent to user-space tool hooks and must be mitigated through external controls:

### 1. Direct Shell Execution & Process Spawning
- If an agent has access to a shell tool (`bash`, `sh`, `zsh`, `cmd`, `powershell`, `exec`), the agent can run commands, compilers, or scripts that directly create, modify, or delete files on disk without invoking an editor file tool.
- *Mitigation:* Configure execution profiles (`permissionProfiles`) with `allowShell: false` for untrusted or worker agents, or execute agents inside isolated containers/disposable worktrees.

### 2. Shell Redirection & Pipelines
- Inside a shell, standard I/O redirection (`echo "data" > src/unowned.js`, `cat < in >> file`, `tee file`) operates at the OS file descriptor level and is invisible to editor tool hooks.
- *Mitigation:* Disallow shell tools or restrict shell environments to read-only container mounts.

### 3. Background Jobs & Detached Processes
- Background processes, daemons, or sub-agents spawned during a task run independently of the editor's synchronous tool-call cycle and cannot be intercepted by `baton guard`.
- *Mitigation:* Enforce process tree termination at test/task completion; run tasks in containerized sandboxes.

### 4. Direct Git Operations
- Git commands such as `git checkout`, `git restore`, `git reset`, `git clean`, `git apply`, `git cherry-pick`, and `git merge` mutate files in the working directory directly via the `git` binary.
- *Mitigation:* While `baton guard` does not intercept `git` CLI calls, Baton's post-execution gate `baton verify` checks the Git working tree diff and rejects unowned/out-of-scope changes before submission.

### 5. External Scripts, Build Systems, and Compilers
- Running build systems (`npm run build`, `make`, `cargo build`, `webpack`), code generators, or linters may write generated files, caches, or binaries across the repository.
- *Mitigation:* Use declared build outputs or ensure build commands run with constrained working directories.

### 6. Unhooked Editor Extensions & Language Servers
- IDE features like Language Server Protocol (LSP) code actions, automated formatting plugins, refactoring extensions, or direct file explorer actions do not pass through the agent's tool-call hook.
- *Mitigation:* Run automated agents in headless CLI environments with explicit hook configurations.

### 7. Files Outside the Repository Boundary
- Paths that reside outside the repository root are intentionally not guarded by `baton guard` (e.g., temporary system files in `/tmp` or `%TEMP%`).
- *Mitigation:* Isolate runner environments so agents have no access to host filesystem assets outside the project workspace.
