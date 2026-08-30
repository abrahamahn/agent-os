# Agents, goals, tasks, attempts, and workflows

**Status:** `EVIDENCE/MIGRATION ORACLE` — retained pre-separation research input; active owner is the Agent OS repository
**Reviewed:** 2026-08-26
**Dossier status:** `DRAFT` — migrate into the standard dossier before evidence review
**Owner / required reviewers:** unassigned; assign domain, product, and specialist reviewers before evidence review
**Source cutoff:** 2026-08-26 current Notion scope plus reviewed historical local-controller proposals; current repository and external evidence otherwise pending
**Historical architecture admission:** `FOUNDATION-REQUIRED` — pre-separation classification; not active architecture
**Historical research depth:** Tier 1 — implementation-grade

**Product horizon at capture:** `CURRENT` for internal Agent OS; separate product boundary

## Purpose

Define durable work intent and execution attempts for an internal software factory while distinguishing human goals, decomposed tasks, agent identities, workflow definitions, and ephemeral runner processes.

## Behaviors to study

- create, scope, prioritize, decompose, assign, start, pause, resume, cancel, block, complete, and reopen goals/tasks;
- select agent/capability/model/tooling and create a bounded attempt;
- lease/heartbeat, checkpoint, retry, supersede, and recover ambiguous attempts;
- dependencies, gates, fan-out/fan-in, resource budgets, and deadlines;
- human steering, clarification, override, and handoff;
- idempotent external actions and compensation;
- workflow definition/version versus running instance.

## Candidate invariants

- A goal/task expresses desired work; an attempt is one execution and cannot overwrite intent history.
- At most one accepted authority advances a task transition when exclusivity is required.
- Lease expiry does not prove an external side effect failed.
- Retry creates a distinguishable attempt and handles prior ambiguity explicitly.
- Completion is evidence-backed and does not equal acceptance/integration/release.
- Agent identity and runner process identity remain distinct.

## Historical controller and blocker leads to revalidate

**Status:** `EVIDENCE/MIGRATION ORACLE` — requirements and current-state leads, not an accepted state machine, controller, registry, CLI, filesystem layout, process launcher, or implementation plan.

- Distinguish the durable organizational role, founder-facing display slot, task assignment, resumable agent session, execution attempt, and operating-system process. Reordering a display must not rewrite work history, and the existence of a worktree or saved session does not prove a process is running.
- Discovery reconstructs effective state from durable records plus current Git/worktree/runtime observation. Missing, stale, dirty, conflicting, or ambiguous evidence fails closed; it is not repaired by guessing a branch, task, authority, or process state.
- Importing a task/wave, producing a launch plan, dispatching a process, capturing output, importing a receipt, and advancing task state are separate authorized transitions. A read/discovery action never starts work, and capture alone never grants review or completion authority.
- Evidence records and per-task indexes remain distinct: an index points to immutable candidate/review/receipt evidence and cannot replace it. Every transition validates the exact identity and evidence required by that edge rather than inferring correctness from a terminal claim.
- Founder/lead status output labels a claim as a durable repository/external-system fact, current runtime observation, inference with a named basis, or unknown because evidence is absent/stale/conflicting. A candidate remains a candidate regardless of plausibility, and an inference never silently becomes task or product authority.
- A blocker has a stable non-reused identity, evidence-backed root-cause class, affected acceptance criterion, narrow owner, and explicit scope. The blocked task does not absorb an unrelated fix; a reviewed resolution makes the parent eligible for the required rebuild/rebase/revalidation but does not approve it automatically.
- Add orchestration breadth only after measured Ganbate friction or a correctness/recovery/safety/evidence need. A database, broker, public control plane, workflow DSL, marketplace, broad provider layer, or autonomous merger is not justified by the historical local controller alone.
- Escalation presents the smallest decision needed to resume safely, the evidence/conflict behind it, the affected criterion, and the valid options. It does not ask the founder to re-decide routine routing or grant blanket authority.

The archived A-slot catalog, exact state names, JSON files, Markdown registries, commands, sandbox table, Wave-specific paths, Node controller, and `/tmp` runtime layout were not promoted.

Historical sources: [`AGENT_BOOTSTRAP_V1.md`](https://github.com/abrahamahn/ganbate-docs/blob/ff86cb89041558ee192feaebdade28e0d9a25cc8/archive/original/b12b3e0a/docs/agent/AGENT_BOOTSTRAP_V1.md), [`AGENT_OS_V2.md`](https://github.com/abrahamahn/ganbate-docs/blob/ff86cb89041558ee192feaebdade28e0d9a25cc8/archive/original/b12b3e0a/docs/agent/AGENT_OS_V2.md), and [`BLOCKERS.md`](https://github.com/abrahamahn/ganbate-docs/blob/ff86cb89041558ee192feaebdade28e0d9a25cc8/archive/original/b12b3e0a/docs/agent/BLOCKERS.md). The evidence-labeling and minimal-escalation lead came from [`A0_MISSION_CONTROL.md`](https://github.com/abrahamahn/ganbate-docs/blob/ff86cb89041558ee192feaebdade28e0d9a25cc8/archive/original/b12b3e0a/docs/agent/prompts/A0_MISSION_CONTROL.md).

## Questions

1. Which workflows need durable state versus simple queued jobs?
2. How are human and agent authority combined without unclear ownership?
3. What is the minimal generic lifecycle before domain-specific workflow types are justified?
4. How are external-system idempotency and ambiguous completion represented?
5. Which Agent OS facts may be shared with repository/product planning?

## Expected outputs

- work-intent/attempt/lease lifecycle;
- cancellation/retry/ambiguity semantics;
- human/agent/runner authority map;
- separation from product-domain state.
