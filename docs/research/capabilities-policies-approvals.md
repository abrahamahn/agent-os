# Capabilities, policies, and approvals

**Status:** `EVIDENCE/MIGRATION ORACLE` — retained pre-separation research input; active owner is the Agent OS repository
**Reviewed:** 2026-08-26
**Dossier status:** `DRAFT` — migrate into the standard dossier before evidence review
**Owner / required reviewers:** unassigned; assign domain, product, and specialist reviewers before evidence review
**Source cutoff:** 2026-08-24 Notion scope only; repository and external evidence pending
**Historical architecture admission:** `FOUNDATION-REQUIRED` — pre-separation classification; not active architecture
**Historical research depth:** Tier 1 — implementation-grade

**Product horizon at capture:** `CURRENT` for internal Agent OS

## Purpose

Study explicit agent/tool capabilities, resource scopes, policy evaluation, approval, delegation, expiry, and revocation so internal automation has no ambient product or production authority.

## Behaviors to study

- capability definition, grant, constrain, delegate, approve, use, expire, revoke, and review;
- task/attempt/tool/resource/environment scope;
- read versus write, destructive, external-message, release, production, secret, and financial authority;
- policy evaluation and denied/approval-required outcomes;
- single or multi-party approval, time-bound token, break-glass, and audit;
- policy/version change during an attempt;
- least-privilege derivation and unused-capability review.

## Candidate invariants

- No agent or runner receives authority solely from its identity or network location.
- Every material external write is within explicit task and resource scope.
- Approval records exact proposed action/scope/version and cannot authorize a materially changed action.
- Revocation blocks future use and has defined behavior for in-flight work.
- Production, secrets, releases, and destructive operations fail closed by default.
- Policy/approval decisions are attributable and auditable without exposing secret values.

## Questions

1. What is a capability versus role, policy, credential, or approval?
2. Which actions require fresh human confirmation even if generally allowed?
3. How are repository/worktree ownership and shared-checkout safety represented?
4. How are third-party app/plugin permissions discovered and bounded?
5. Which capabilities can safely be delegated to subagents?

## Expected outputs

- capability/policy/approval lifecycle;
- high-risk action taxonomy;
- revocation and in-flight semantics;
- strict boundary from Ganbate product authorization.
