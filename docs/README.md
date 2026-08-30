# Agent OS documentation

**Status:** `CURRENT CANON` — Agent OS documentation navigation and ownership boundary
**Migrated from:** `abrahamahn/ganbate-docs/docs/03-agent-os/` on 2026-08-30

Agent OS is internal software-delivery infrastructure optimized for real Ganbate work. This repository is the sole owner of Agent OS code, tests, configuration, current-system evidence, architecture, operations, migration decisions, acceptance criteria, and repository-specific documentation.

The documents under `docs/research/` were originally developed inside `ganbate-docs` before Agent OS was separated into its own repository. They are retained here as research and migration evidence. Their historical status labels and old Ganbate references are provenance; they do not override current code, this repository's accepted decisions, or newer founder/Notion authority.

## Authority boundary

- Agent OS owns goals/tasks/attempts, routing, execution isolation, capabilities/approvals, checkpoints/artifacts/evidence, review/integration orchestration, and its own operational state.
- Agent OS does not own Ganbate Player, Game, Value, Product Economy, House, sportsbook, world, Product roadmap, or production-release truth.
- Ganbate may consume Agent OS through explicit integration boundaries, but Product/domain facts remain with their owning product repositories.

## Read in order

1. [Founder separation decision](founder-decision.md)
2. [Retained acceptance input](acceptance.md)
3. [Historical research dossiers](research/README.md)
4. Repository root [`AGENTS.md`](../AGENTS.md) for current execution discipline
5. Repository root [`ROADMAP.md`](../ROADMAP.md) for current program direction

## Research migration rule

The migrated research is preserved because it contains useful requirements, historical implementation leads, failure cases, safety constraints, and exact source revisions. When current Agent OS work adopts, rejects, or supersedes one of those ideas, update the current owning document/code and treat the old dossier as provenance rather than creating another parallel authority.
