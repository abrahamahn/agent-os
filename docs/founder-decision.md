# B-000A — Agent OS as a Phase B research and coordination enabler

**Status:** `CURRENT CANON`
**Decision status:** `ACCEPTED DECISION`
**Decision date:** 2026-08-24
**Last reviewed:** 2026-08-30
**Notion record:** [B-000A](https://app.notion.com/p/3c5aa2f7b92481d69694e5ab1a1db81b)

## Decision

1. Agent OS is an important research and coordination system and must be optimized for Ganbate's measured development workflow.
2. It remains a separate bounded company system with separate state, storage, and contracts.
3. The Agent OS program and repository own current-state inventory, Agent domain/data/trust/runtime architecture, implementation, migration, and acceptance.
4. Ganbate consumes Agent OS only through explicit integration/evidence boundaries and does not absorb Agent OS state or architecture into Product, Game, Value, sportsbook, or world truth.
5. Generic Agent Factory/SaaS breadth remains deferred unless measured need justifies it.

## Repository placement update — 2026-08-30

Agent OS lives in the dedicated `abrahamahn/agent-os` repository. This repository owns Agent OS code, tests, configuration, current-system evidence, architecture, research, operations, migration, and repository-specific documentation.

The former `ganbate-docs/docs/03-agent-os/` tree was migrated here and removed from Ganbate Docs. Ganbate Docs may reference Agent OS as an external dependency, but it no longer maintains a duplicate Agent OS documentation subtree.

## Rationale

A separate system can be strategically critical to Ganbate development without sharing the domain truth of the product it helps build. Keeping Agent OS in its own repository prevents orchestration state, runner concerns, task state, and workflow semantics from leaking into Product architecture.

## Rejected alternatives

- **Low-depth research annex:** would leave implementation inventing critical Agent semantics too late.
- **Generic orchestration platform first:** creates speculative scope and weakens Ganbate-first optimization.
- **Embed orchestration in Ganbate:** leaks software-delivery state into product truth.
- **Duplicate documentation in Ganbate Docs:** creates conflicting authority and maintenance debt.

## Consequences

- Agent OS owns implementation-ready research and specification depth for itself;
- every proposed capability traces to measured Ganbate burden or correctness, recovery, safety, or evidence;
- Ganbate specs reference only the external behavior/integration contract they require;
- operational targets are proved on representative Ganbate work;
- superseded orchestration authority is retired only after safe replacement and evidence.
