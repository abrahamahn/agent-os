# Review, integration, and completion

**Status:** `EVIDENCE/MIGRATION ORACLE` — retained pre-separation research input; active owner is the Agent OS repository
**Reviewed:** 2026-08-26
**Dossier status:** `DRAFT` — migrate into the standard dossier before evidence review
**Owner / required reviewers:** unassigned; assign domain, product, and specialist reviewers before evidence review
**Source cutoff:** 2026-08-26 current Notion scope plus reviewed historical Agent OS lifecycle proposals; repository and current tooling evidence otherwise pending
**Historical architecture admission:** `FOUNDATION-REQUIRED` — pre-separation classification; not active architecture
**Historical research depth:** Tier 1 — implementation-grade

**Product horizon at capture:** `CURRENT` for internal Agent OS

## Purpose

Study the states between “an agent produced something” and “accepted work is integrated, verified, released, and safe to retire.”

## Behaviors to study

- submit candidate, request review, record findings, revise, accept, reject, or supersede;
- dependency/base drift and revalidation;
- integrate into canonical line, resolve conflict, verify exact integrated revision;
- release candidacy, independent review, deployment, smoke, rollback evidence, and acceptance;
- preservation, reachability proof, branch/worktree retirement, and backlog pressure;
- reopened issue or post-release defect;
- blocked/ambiguous completion and owner escalation.

## Candidate invariants

- `BUILDER_COMPLETE`, committed, reviewed, accepted, integrated, released, and production-verified are distinct states.
- Review applies to an exact candidate identity.
- Integration invalidates evidence when relevant content/environment fingerprints change.
- No task artifact is destructively retired without preservation and reachability proof.
- Release authority remains product/release-governed, not agent-declared.
- A blocked task does not silently become complete because budget/time elapsed.

## Historical review and recovery lessons to revalidate

**Status:** `EVIDENCE/MIGRATION ORACLE`, not an accepted lifecycle or implementation contract.

- Builder completion, durable capture, independent review, approval, integration, validation, acceptance, release, and observed production health are different states.
- A review applies only to the exact candidate it inspected. An ancestor review, stale pass, builder self-review, or task-level claim cannot approve changed work.
- Required corrections produce a new candidate identity and another independent review. A later pass cannot silently erase an unresolved negative finding against the same bytes.
- Immediately before integration, recheck candidate identity, qualifying review, dependencies, and accepted predecessor. If an integrator exits after a possible change, reconcile the real effect before retrying; never repeat a possibly applied integration blindly.
- Founder decisions remain explicit blockers or approvals. Routine scheduling and recovery cannot invent product, security, release, or exception authority.
- An unrelated blocker does not broaden the blocked task. It receives a stable identity, narrow owner/scope, root-cause classification, reviewed resolution, and validation evidence; the parent then performs its required rebuild/rebase/revalidation because blocker resolution does not approve the parent candidate.

The archived state names, queues, command tokens, JSON artifacts, retry rules, and single-integrator design remain proposals to compare during current Agent OS work.

Historical blocker source: [`BLOCKERS.md`](https://github.com/abrahamahn/ganbate-docs/blob/ff86cb89041558ee192feaebdade28e0d9a25cc8/archive/original/b12b3e0a/docs/agent/BLOCKERS.md).

## Questions

1. Which review roles and independence are required per risk class?
2. How is completed-but-not-integrated pressure measured and resolved?
3. What exact evidence allows validation reuse?
4. How are owner decisions and exceptions recorded durably?
5. Which Agent OS states map to repository/CI/deployment systems without duplicating their truth?

## Expected outputs

- candidate/review/integration/release lifecycle;
- evidence validity and retirement rules;
- risk-based review matrix;
- boundary from repository, CI, and production authority.
