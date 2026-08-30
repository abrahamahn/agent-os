# Agent OS Phase B specification and proposed Phase C acceptance contract

**Status:** `EVIDENCE/MIGRATION ORACLE` — retained pre-separation acceptance input; not active Agent OS authority
**Notion input:** [07I-M](https://app.notion.com/p/3c5aa2f7b924817fb8c9d56efc764e0d)
**Active owner:** this Agent OS repository
**Reviewed:** 2026-08-26

This page preserves acceptance requirements developed before Agent OS moved to its own repository. The current Agent OS program must adopt, reject, or supersede them explicitly; their presence here does not by itself define current architecture, task state, or completion.

## Representative workloads

1. Notion/repository inventory and contradiction detection.
2. Parallel sourced research with provenance.
3. Specification review and cross-document coherence.
4. ADR and requirements-traceability review.
5. PostgreSQL/Rust architecture review.
6. Bounded reference slices, real-database proof, and correction.
7. Integration, release-candidate evidence, and retirement checks.

Synthetic tests are necessary but insufficient.

## Proposed operational acceptance evidence

Real Ganbate use should prove:

- eligible agent CLIs exchange machine-readable work without normal founder clipboard relay;
- approximately 90% of routine manual prompt/result routing is removed for representative multi-agent work;
- durable goal/task/attempt/lease/capability/approval/receipt/artifact/evidence state survives interruption;
- one-writer transitions, retry, expiry, reconciliation, and ambiguous outcomes are safe;
- independent review and correction loops are observable;
- artifacts/checks/decisions remain associated with the correct repository/product state;
- runner isolation, secrets, networking, destructive/external authority, and resource limits fail closed;
- integration distinguishes builder-complete, committed, reviewed, accepted, integrated, released, and production-verified states;
- cycle/queue time, intervention, failure, retry, recovery, cost, and resource metrics are recorded;
- bottleneck optimization preserves correctness, evidence, and review independence;
- Agent OS storage/authority remains isolated from every product/domain database;
- superseded task/orchestration authority is explicitly retired after cutover.

## Scope stop rule

Admit a feature only when it removes measured Ganbate burden or is required for correctness, recovery, safety, or evidence. Defer generic workflow features, public SaaS, marketplace/billing, speculative multitenancy, provider breadth, customer dashboards, and autonomy theater.

## Retained design-completion criterion

The pre-separation criterion proposed that Agent OS design was ready when its current-state evidence, bounded context, lifecycle/invariants, data model, trust/capability and runner architecture, storage/protocol contract, observability, migration/cutover/rollback plan, reconciliation, test strategy, performance/cost targets, and operational acceptance method were coherent enough for implementation without invented behavior.

The current Agent OS repository must accept, replace, or reject that criterion. The operational outcomes above are evidence inputs, not automatic completion claims.
