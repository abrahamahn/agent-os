# Checkpoints, artifacts, and evidence

**Status:** `EVIDENCE/MIGRATION ORACLE` — retained pre-separation research input; active owner is the Agent OS repository
**Reviewed:** 2026-08-26
**Dossier status:** `DRAFT` — migrate into the standard dossier before evidence review
**Owner / required reviewers:** unassigned; assign domain, product, and specialist reviewers before evidence review
**Source cutoff:** 2026-08-26 current Notion scope plus reviewed historical Agent OS artifact proposals; repository and current tooling evidence otherwise pending
**Historical architecture admission:** `FOUNDATION-REQUIRED` — pre-separation classification; not active architecture
**Historical research depth:** Tier 1 — implementation-grade

**Product horizon at capture:** `CURRENT` for internal Agent OS

## Purpose

Study how an attempt preserves progress, outputs, validation provenance, and reviewable evidence without confusing files, logs, commits, builds, and claims of completion.

## Behaviors to study

- checkpoint create, resume, supersede, expire, and garbage-collect;
- artifact declare, produce, hash/identify, store, relate, promote, and retire;
- validation command/environment/input/output evidence;
- source revision, dependency/environment fingerprint, and exact-SHA reuse;
- partial/failed/ambiguous output and recovery;
- review comment, finding, response, acceptance, and provenance;
- sensitive artifact classification, access, retention, and deletion.

## Candidate invariants

- Evidence identifies the exact artifact/source/environment it supports.
- A checkpoint is resumable execution state, not proof of correctness.
- Artifact mutation creates a new identity or invalidates dependent evidence.
- Validation evidence is not reused when relevant fingerprints differ.
- Secrets/personal data are excluded or governed explicitly.
- Accepted/integrated/released states remain distinguishable.

## Historical preservation lessons to revalidate

**Status:** `EVIDENCE/MIGRATION ORACLE`, not accepted Agent OS storage architecture.

- A candidate is not durably captured merely because it exists inside a worker's temporary workspace. Before cleanup, the controller must preserve it in an independently reachable store and verify its exact content identity and completeness.
- Reviewers and integrators resolve the preserved candidate, not a worker-supplied path or mutable checkout.
- Legacy controller records, old pass labels, task bindings, and paths remain untrusted until reconstructed from durable candidate and review evidence. Missing or ambiguous history is recorded, not guessed.
- Validation evidence states the exact candidate, check, dependencies, environment, result, and time. A changed candidate or relevant environment creates new evidence or an explicit compatible-reuse decision.
- One useful historical identity candidate combines the exact candidate revision, stable check name, exact command fingerprint, declared dependency fingerprint, and declared environment fingerprint. Requesting worker/manager names are provenance, not part of the result identity, so the same valid evidence can be shared without pretending that a different owner changed the tested bytes.
- Only a matching successful result is automatically reusable. A matching active run causes another requester to wait or subscribe; failure, blocked environment, and cancellation remain history but permit a new attempt. Time alone does not invalidate evidence unless the accepted design explicitly makes time an input.
- Duplicate prevention must happen before an expensive resource is reserved. A run becomes `running` only after it receives its execution lease; every failure, cancellation, or abandoned execution must resolve both the resource job and its linked evidence record without inventing a pass.
- Failure reporting must distinguish product/test failure from unavailable infrastructure and broken tooling so the correct owner can respond. The exact old labels are not accepted, but the distinction is required.

### Recovered controller-substrate lead

One historical reconciliation identified an implementation substrate at exact application commit `63d122673f88f672cdb08a24300b837f588f8084`. It reported legal task-transition checks, exact-SHA authority/candidate/review validation, worktree discovery/refusal, bounded no-shell dispatch, permission preservation, structured role-specific capture, duplicate-dispatch exclusion, and focused tests. This is an `EVIDENCE/MIGRATION ORACLE` lead only: inspect that exact commit and qualify reachability before any capability is treated as current or reusable.

The same reconciliation identified the missing durable bridge as:

```text
captured output
→ idempotent verified import
→ immutable execution receipt
→ task/session reconciliation
→ durable pending next action and bounded context
→ newly authorized dispatch
```

Each edge needs its own identity, failure/ambiguity state, authorization, retry behavior, and evidence. Import cannot trust invalid or timed-out capture, reconciliation cannot invent an external effect, and routing cannot turn a builder result into reviewer acceptance.

The removed Git-bundle, bare-store, ref, JSON-schema, and directory choices are comparison evidence only.

### Recovered durable-handoff lead

A historical preservation audit identified exact legacy controller tip `2a08b2e81f78788c75c841f934a64dcb010523de` as the strongest self-contained local-controller/handoff oracle. It reported crash-safe receipt storage, idempotent capture import, exact-candidate review workspaces, durable pending actions, reviewer routing, bounded correction loops, restart recovery, and stale-dispatch refusal. Those are inspection leads only: exact reachability, behavior, tests, dependencies, and supersession by the newer host-only orchestrator must be revalidated before reuse or retirement.

Historical sources: [`quality-control-plane.md`](https://github.com/abrahamahn/ganbate-docs/blob/ff86cb89041558ee192feaebdade28e0d9a25cc8/archive/original/5cb7bfb4/docs/dev/quality-control-plane.md) and [`validation-evidence.md`](https://github.com/abrahamahn/ganbate-docs/blob/ff86cb89041558ee192feaebdade28e0d9a25cc8/archive/original/5cb7bfb4/docs/dev/validation-evidence.md). The controller-substrate lead came from [`AOS_C0_RECONCILIATION.md`](https://github.com/abrahamahn/ganbate-docs/blob/ff86cb89041558ee192feaebdade28e0d9a25cc8/archive/original/b12b3e0a/docs/agent/AOS_C0_RECONCILIATION.md). The durable-handoff tip and comparison came from [`PRESERVE_BRANCH_SALVAGE.md`](https://github.com/abrahamahn/ganbate-docs/blob/ff86cb89041558ee192feaebdade28e0d9a25cc8/archive/original/e510f2c3/docs/audits/PRESERVE_BRANCH_SALVAGE.md).

## Questions

1. Which artifact identities are content hashes, repository revisions, external IDs, or logical names?
2. What evidence is durable versus disposable diagnostics?
3. How are large build/test artifacts retained cost-effectively?
4. Which review provenance must survive task/worktree retirement?
5. How are generated outputs tied to authoritative inputs?

## Expected outputs

- checkpoint/artifact/evidence taxonomy and lifecycle;
- provenance and invalidation rules;
- access/retention requirements;
- exact completion/acceptance evidence model.
