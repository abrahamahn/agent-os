# Legacy Agent OS V2 implementation evidence

**Status:** `EVIDENCE/MIGRATION ORACLE` — reviewed historical implementation evidence; not current runtime or architecture authority
**Reviewed:** 2026-08-26
**Source snapshot:** [commit-pinned `archive/original/b12b3e0a` review corpus](https://github.com/abrahamahn/ganbate-docs/tree/ff86cb89041558ee192feaebdade28e0d9a25cc8/archive/original/b12b3e0a)
**Historical implementation base named by the source:** `63d122673f88f672cdb08a24300b837f588f8084`

## Purpose

Preserve the useful operational lessons from the historical Agent Bootstrap V1, Agent OS V2, and AOS-C0 reconciliation documents before their redundant archive copies are removed.

This page does **not** adopt the old CLI commands, A-number assignments, wave names, repository paths, JSON schemas, `/tmp/ganbate-*` layout, or Git-resident mutable-state design. Those details are historical evidence only. Current Agent OS behavior and target architecture must be established in this repository from current evidence.

## Durable lessons worth carrying forward

### Logical role identity is not process or display identity

A long-lived organizational role should survive terminal restarts, reordered founder-facing display slots, new agent sessions, and runner replacement. Task history, review independence, authority, and evidence should not depend on which terminal number happens to be visible.

### Discover real state; do not infer it from workspace existence

The historical bootstrap reconstructed state by inspecting actual Git worktrees, branch, HEAD, dirty state, assignment bindings, authority, and task status. A worktree existing on disk was explicitly **not** treated as proof that an agent process was running.

Target research should preserve the behavioral requirement:

- runtime/execution state is explicit and evidence-backed;
- dirty, stale, wrong-branch, wrong-base, missing-authority, or ambiguous assignment states fail closed;
- the controller reports uncertainty rather than guessing through it.

### Revalidate immediately before dispatch

Historical dispatch reran discovery immediately before starting a process rather than trusting an earlier status screen. Branch, worktree, authority, dependency, review, or resource state may change between planning and execution.

### Planning and execution are separate operations

The old controller could render a launch/resume plan without starting anything. A separate bounded dispatcher performed execution only after the plan was reviewed/revalidated. Read/status operations must never accidentally launch an agent, broaden permissions, mutate task state, approve a review, integrate a candidate, or grant release/production authority.

### Many independent agent sessions, one supervising control plane

Each agent session/process was independently owned execution with its own conversation, worktree, permissions, failure lifecycle, and resource use. The controller supervised and routed them; it did not treat one conversation as durable shared state.

### Exact candidate identity and independent review matter

Historical state transitions distinguished builder completion, candidate commit, review, integration, acceptance, release, and production verification. Reviews were tied to the exact candidate SHA and builder, reviewer, and integrator roles were expected to remain independent.

Useful requirements:

- a review applies only to the exact artifact it inspected;
- a correction creates a new candidate identity and needs fresh qualifying review;
- stale or ancestor evidence cannot silently approve changed bytes;
- task completion is not integration, release, or production proof.

### Bounded dispatch must not silently expand authority

The historical dispatcher was designed around direct process launch rather than shell interpolation, role-specific sandbox/approval policy, duplicate-dispatch prevention, time/output bounds, and captured result artifacts. The transferable requirement is that orchestration must preserve the caller's explicit capability boundary and fail closed on unauthorized privilege expansion.

## Historical implementation substrate reported by AOS-C0

The AOS-C0 reconciliation identified historical base `63d122673f88f672cdb08a24300b837f588f8084` and reported useful safety substrate:

- explicit task-state transitions and legal-transition checks;
- exact full-SHA authority/candidate/review validation;
- dependencies, owned/forbidden paths, and serialized integration ordering;
- Git worktree/branch/base discovery and refusal behavior;
- bounded process dispatch with no shell;
- permission-expansion refusal;
- structured session capture with timeout and output-size bounds;
- distinct builder/reviewer/integrator result shapes;
- duplicate-dispatch locking; and
- focused controller/dispatcher tests.

These are claims about that historical implementation lineage, not current facts. Reuse requires exact-source reinspection and characterization against current Agent OS.

## The important unfinished bridge

The strongest recovered gap was the manual handoff after a process finishes:

```text
CAPTURED
→ verified import
→ durable execution receipt
→ task/session reconciliation
→ pending next-action routing
→ reviewer context packet
→ bounded reviewer dispatch
```

Automation must preserve import idempotency and stable attempt identity, exact artifact/result provenance, ambiguous/invalid/timed-out states, independent review, explicit founder/product/security/release gates, and recovery when an external side effect may have happened but acknowledgement is uncertain.

## Historical couplings to avoid rebuilding blindly

The old implementation was tightly coupled to Ganbate-era details including command naming, mutable controller state under repository docs, A-slot/wave role assumptions, hard-coded specification/review roots, `/tmp/ganbate-*` runtime paths, a direct Codex executable assumption, and repository-local `pnpm agents:*` entry points. These are migration seams, not requirements.

## Historical artifact protocol and blocker-routing lessons

### Specification authority review is distinct from implementation review

The task/specification granting work its scope and acceptance contract may itself require independent review. That is distinct from later candidate review.

### Unrelated blockers receive narrow ownership

A blocker outside the current task's owned scope should stop only the affected criterion and be routed to a separately bounded owner/task. Resolution requires its own evidence; the parent then performs required rebuild/rebase/revalidation.

### Mission-control summaries are derived views, not primary truth

Founder briefs and shared dashboards should be derived or single-writer projections over authoritative task/attempt/evidence state. Unknown or stale state remains unknown.

### A handoff is an evidence-bearing review request, not approval

A useful builder handoff identifies the exact candidate, changed behavior, validation commands/results, skipped/blocked checks, known risks, integration-only glue, and rollback or forward-only constraints. `READY` means ready for independent review, not approved.

### Evidence artifacts have explicit writers

Task specification, builder handoff, independent review, and integration records should have explicit ownership rather than many agents mutating one shared truth representation.

### Task authorization freezes the execution-critical contract

Before execution, a task contract should identify stable task identity, one observable objective, exact accepted base, owned and forbidden scope, dependencies, acceptance criteria, required validation, independent review ownership, integration ordering where relevant, and task-specific stop conditions. Material scope or authority change creates a newly reviewed contract rather than mutating history in place.

### Mission control distinguishes fact, observation, inference, and unknown

Founder-facing reports should distinguish durable repository fact, runtime observation, inference with named basis, and unknown due to absent/stale/conflicting evidence. Missing evidence must not be filled from memory.

## Current research destinations

Use this page as historical input to the maintained Agent OS research rather than as a competing design:

- [Agents, goals, tasks, attempts, and workflows](agents-runs-workflows.md)
- [Capabilities, policies, and approvals](capabilities-policies-approvals.md)
- [Checkpoints, artifacts, and evidence](checkpoints-artifacts-evidence.md)
- [Execution isolation](execution-isolation.md)
- [Review, integration, and completion](review-integration-completion.md)
- [Agent OS acceptance](../acceptance.md)

## Re-review trigger

Reinspect the historical implementation rather than relying on this summary if current work proposes code reuse, a compatible controller migration, or a claim that a historical safety behavior still exists. Pin the exact source revision and characterize it with focused tests before treating recovered behavior as current fact.
