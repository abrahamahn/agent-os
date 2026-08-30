# Execution isolation

**Status:** `EVIDENCE/MIGRATION ORACLE` — retained pre-separation research input; active owner is the Agent OS repository
**Reviewed:** 2026-08-26
**Dossier status:** `DRAFT` — migrate into the standard dossier before evidence review
**Owner / required reviewers:** unassigned; assign domain, product, and specialist reviewers before evidence review
**Source cutoff:** 2026-08-26 current Notion scope plus reviewed historical Agent OS execution and process-cleanup proposals; repository and current tooling evidence otherwise pending
**Historical architecture admission:** `FOUNDATION-REQUIRED` — pre-separation classification; not active architecture
**Historical research depth:** Tier 1 — implementation-grade

**Product horizon at capture:** `CURRENT` for internal Agent OS

## Purpose

Study runner/environment isolation, workspace ownership, networking, secrets, resource budgets, process lifecycle, and cleanup so agent execution cannot damage shared or production state.

## Behaviors to study

- environment image/template selection, provision, mount, start, heartbeat, stop, preserve, and retire;
- repository checkout/worktree/branch ownership and concurrent-agent coordination;
- filesystem, process, network, secret, credential, and external-service boundaries;
- CPU/memory/time/storage/network budgets and backpressure;
- untrusted code execution and sandbox escape threat model;
- task cancellation, orphan process detection, and safe cleanup;
- artifact/evidence extraction and environment destruction.

## Candidate invariants

- Runner identity does not imply tool/service/product authority.
- Shared files are never overwritten or deleted without explicit task ownership.
- Cleanup requires positive workload/target ownership, not cwd or process-name guesses.
- Secrets are task-scoped, minimally exposed, and revoked after use.
- Resource exhaustion in one attempt cannot destabilize unrelated workloads.
- Environment retirement follows artifact/evidence preservation and reachability proof.

## Historical execution lessons to revalidate

**Status:** `EVIDENCE/MIGRATION ORACLE` — useful requirements from removed implementation proposals, not an accepted runner design.

- A worker needs an isolated, attributable way to produce a real candidate without receiving unrestricted write access to the founder's checkout, Git control state, credentials, local services, or production.
- Worktree, branch, saved session, and running process are separate facts. Discovery rechecks the live checkout/runtime state; a persisted assignment or existing directory never proves that execution is active, safe to resume, or still attached to the recorded candidate.
- Observation and launch planning are read-only. Dispatch is a separate bounded capability that rechecks eligibility immediately before execution; capture/import and task transition remain separate afterward.
- Sandbox inability to reach host loopback or PostgreSQL is an environment fact, not evidence that the candidate product failed. Host-dependent validation needs a separately trusted, allowlisted runner and a recorded environment identity.
- Validation distinguishes unavailable service, blocked environment, product-test failure, pass, and safe evidence reuse. An agent cannot turn an arbitrary host command or self-authored log into a pass.
- Existing dirty or legacy work is preserved and fingerprinted before adoption. Cleanup, relocation, reset, or metadata recreation cannot silently change it.
- Process cleanup is inspect-only by default. A destructive cleanup requires a separate explicit action and repeats ownership and identity checks immediately before it signals anything.
- A current directory, executable name, port, or vague ancestry is not enough to prove ownership. Unknown or mixed-ownership processes remain visible but protected from automatic cleanup.
- Process identity includes more than a reusable PID. A cleanup plan records and rechecks an OS-provided process start identity so a newly reused PID is never treated as the old target.
- Cleanup protects its own process/ancestor chain and any separately registered shared developer environment. It requests orderly shutdown before forced termination and signals a process group only when every live member is positively in scope.
- Process inventory is bounded by the visible OS/process namespace. Reports redact likely credentials and do not rely on exposing raw command arguments; secrets should not be passed on command lines.
- Resource-heavy work should pass through one host-aware admission point that can classify jobs by expected cost, queue them before launch, and apply measured CPU/memory/process pressure limits. Fixed capacities and worker-number privileges from the old controller are not accepted; current research must choose limits from observed workloads and host capacity.
- A resource job needs enough identity to attribute and safely retire only its own work: candidate revision, command, workspace, owner, child/process-group identity, queue/start time, and terminal status. Every success, failure, cancellation, and abandoned-owner path releases its lease without searching for arbitrary user or developer processes.
- A separately registered shared developer environment must remain protected from agent cleanup. Inspection may report it, but starting, stopping, restarting, or unregistering shared services requires their actual owner or another explicitly authorized control path.
- Historical inspection leads include `6f7366ec378dcfae9a88db3250b6c90d0f43863e`, `162fbb515cbf38821d8bf2615b0d68469bbc6956`, and `8f60fc2bc34c063c20355032dc56dae2ae3267d8`; reachability, contents, tests, and relationship to current Agent OS must be revalidated before reuse or retirement.

Historical sources include [`agent-resource-control.md`](https://github.com/abrahamahn/ganbate-docs/blob/ff86cb89041558ee192feaebdade28e0d9a25cc8/archive/original/5cb7bfb4/docs/dev/agent-resource-control.md), [`AGENT_BOOTSTRAP_V1.md`](https://github.com/abrahamahn/ganbate-docs/blob/ff86cb89041558ee192feaebdade28e0d9a25cc8/archive/original/b12b3e0a/docs/agent/AGENT_BOOTSTRAP_V1.md), [`AGENT_OS_V2.md`](https://github.com/abrahamahn/ganbate-docs/blob/ff86cb89041558ee192feaebdade28e0d9a25cc8/archive/original/b12b3e0a/docs/agent/AGENT_OS_V2.md), and [`PRESERVE_BRANCH_SALVAGE.md`](https://github.com/abrahamahn/ganbate-docs/blob/ff86cb89041558ee192feaebdade28e0d9a25cc8/archive/original/e510f2c3/docs/audits/PRESERVE_BRANCH_SALVAGE.md).

## Questions

1. Which workloads require per-attempt sandbox versus durable workspace?
2. How are network egress and external writes approved and audited?
3. How are concurrent edits integrated without permanent worktree sprawl?
4. Which process ownership evidence permits cleanup?
5. What incident response follows runner compromise?

## Expected outputs

- runner/workspace lifecycle and threat model;
- capability and resource boundary;
- preservation/cleanup contract;
- workload-class isolation requirements.
