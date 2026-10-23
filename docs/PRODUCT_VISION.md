# Agent Baton product vision

## North star

Agent Baton turns a human product goal into verified working software through one durable conversation with a lead
orchestrator. The human directs outcomes and approves exceptional decisions; Baton owns the routine planning,
execution, review, repair and integration loop.

The system is complete only when evidence satisfies the original goal-level acceptance contract. A worker message,
green unit test or accepted packet is progress, not proof that the product goal is complete.

## The target experience

A user can start with either a new idea or an existing repository:

```text
Human goal
  → repository/environment inspection
  → product and engineering plan
  → dependency-aware packets and acceptance criteria
  → parallel workers in isolated environments
  → deterministic verification and independent review
  → repair loops and serial integration
  → application execution, browser/API acceptance and release checks
  → goal evaluator
       ↳ incomplete: diagnose, replan and continue
       ↳ blocked: ask the human one actionable question
       ↳ satisfied: deliver evidence and stop
```

The orchestrator can take a packet when that shortens the critical path, but it must enter the same scoped worker
lifecycle as every other agent. It cannot review or approve its own contribution.

## Product modes

### Greenfield mode

Turn an idea into a repository and an executable delivery plan. The orchestrator captures product constraints,
chooses an architecture, creates milestones, establishes the development environment and iterates toward a runnable
product. Material business, security and deployment choices remain human gates.

### Feature mode

Inspect an existing codebase, derive the change surface and interfaces, decompose a feature into non-conflicting
packets, implement it, integrate it and verify the behavior against the existing system.

### Repair mode

Reproduce a defect, preserve evidence, diagnose the cause, implement and independently review a repair, run
regression checks and confirm that the original reproduction no longer fails.

### Audit and remediation mode

Inspect without modifying the audited scope, record evidence-backed findings, create authorized remediation packets
and verify fixes in fresh review contexts.

## Architecture

### Deterministic controller

The controller is the durable authority for mechanics that must survive model turns and process restarts:

- scheduling, dependency readiness and concurrency;
- claims, fencing tokens, leases and heartbeats;
- timers, event-driven wakeups and retry backoff;
- worktree, sandbox and process lifecycle;
- budgets, rate limits, cancellation and escalation;
- credential brokering and approval enforcement;
- event persistence, recovery and observability.

An agent must never be kept alive merely to wait. The controller persists the wait condition and wakes the right role
when a worker completes, a dependency becomes ready, a review is due, a timer fires or a human responds.

### Lead orchestrator agent

The lead agent owns judgment:

- interpret the user's goal and identify material ambiguity;
- inspect the repository, environment and available tools;
- create and revise the dependency graph;
- choose worker and reviewer capabilities;
- diagnose failures and decide whether to retry, redesign or escalate;
- continuously compare integrated results with the original goal;
- communicate concise status, decisions and requests to the human.

### Workers, reviewers and integrator

Workers receive bounded packets, declared tools, owned paths, acceptance criteria, budget and a stop condition. A
different identity reviews the exact submitted revision. Accepted revisions enter a serialized integration queue and
lose approval if their code or relevant base changes. High-risk actions can require a human or enterprise policy gate.

### Tool and environment plane

Runner adapters expose capabilities rather than pretending all agents are equivalent. A run may use shell tools,
browser automation, computer use, MCP servers, cloud APIs, databases and deployment tools only when the environment
and policy explicitly allow them. Every material tool action is associated with an execution identity and audit event.

## Completion and persistence rules

The loop continues while useful, authorized progress remains. It stops only when:

1. all required goal criteria have current evidence and the goal evaluator passes;
2. a human decision or privileged approval is required;
3. a time, token or monetary budget is exhausted;
4. a deterministic blocker cannot be resolved with available tools;
5. repeated attempts cease producing new information; or
6. the user pauses or cancels the run.

Retries must be bounded and must change the inputs, strategy or available evidence. "Keep working" is not permission
for infinite spend, repeated destructive actions or silent expansion of the goal.

## Human operating model

The primary interface is the orchestrator, backed by an operator console. The human can inspect the plan, live work,
evidence, costs and decisions; pause or redirect the run; answer a question; approve a protected action; or cancel a
goal. Normal packet transitions should not require manual terminal choreography.

## Current boundary

The v0.1.0 CLI implements much of the governance substrate: plans, packet ownership, leases, verification, review,
findings, handoff, merge rules and a Git-mergeable ledger. Automatic agent processes, durable scheduling, goal-level
evaluation, browser acceptance and enterprise control-plane capabilities remain roadmap work. Documentation and demos
must preserve this boundary until the relevant issues are implemented and verified.

## Product success measures

- percentage of goals completed without routine human orchestration;
- accepted work on first independent review;
- elapsed and active human time from goal to integrated result;
- stale worker recovery and duplicate-dispatch rate;
- escaped defects and reverted agent changes;
- cost per accepted goal and per accepted packet;
- percentage of completion claims with reproducible evidence;
- time to diagnose and resume interrupted runs.
