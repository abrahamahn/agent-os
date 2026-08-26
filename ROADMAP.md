# Agent OS Roadmap

## Goal

Agent OS should operate as a reusable working-agent orchestrator for any software project:

```text
User
  ↕ approval, clarification, and final decisions
Orchestrator (1)
  ↕ plans, manager reports, escalations, and decisions
Managers (2–3)
  ↕ delegation, progress, questions, and blockers
Task workers (3–4 per manager)
```

The primary product requirement is to eliminate manual copy-and-paste between agents. Work,
reports, questions, decisions, and approvals must move through durable Agent OS communication
channels while preserving authority, traceability, and retry safety.

Agent OS remains project-agnostic and TypeScript-first. Target repositories provide thin adapters,
capability profiles, and customized workflows instead of copying orchestration logic.

## Current foundation

The current release provides a secure, flat orchestration kernel:

- Durable `BUILD → REVIEW → INTEGRATE → VALIDATE → ACCEPTED` task execution.
- Automated command/result transfer without founder clipboard relay.
- Persistent task, command, agent, artifact, and validation state.
- Structured and authenticated worker results with idempotent ingestion.
- Independent review against immutable Git candidates.
- Exact-SHA integration, host validation, resource leases, and bounded process cleanup.
- Declarative target profiles and explicit target worktrees.

The missing layer is the multi-level organization: managers are not yet operational agents, agent
communication is limited to lifecycle-specific command/result artifacts, commands execute
sequentially, and user approval is not represented as a durable workflow object.

## Design principles

1. **No clipboard relay.** Every delegation, report, question, escalation, and decision is delivered
   by Agent OS.
2. **Controller-mediated communication.** Agents address one another through a durable typed message
   bus rather than unrestricted peer-to-peer chat.
3. **Explicit authority.** Workers report to managers, managers report to the orchestrator, and only
   the orchestrator requests decisions from the user.
4. **Durable approvals.** Work that needs permission pauses at an inspectable approval gate and
   resumes from persisted state after approval or denial.
5. **Bounded autonomy.** Roles receive only the tools, paths, resources, and decisions allowed by
   their authority scope.
6. **Auditable decisions.** Important actions retain their input evidence, recommendation, decision,
   actor, and resulting commands.
7. **Project independence.** Application-specific policy stays in target adapters and profiles.
8. **TypeScript-first contracts.** Public message, hierarchy, approval, and execution contracts use
   strict TypeScript schemas and versioned persisted representations.

## Phase 1: Organizational hierarchy

Make managers and reporting relationships first-class controller state.

### Deliverables

- Add `teamId`, `reportsTo`, `authorityScope`, `maxDirectReports`, and role-specific capacity to agent
  records.
- Add explicit `orchestrator`, `manager`, and `worker` role contracts.
- Assign objectives to managers and child tasks to workers; do not assign all workers directly from
  the root orchestrator.
- Validate the reporting graph: one root orchestrator, no cycles, bounded manager and worker counts,
  and no cross-team assignment without explicit authority.
- Persist team membership and hierarchy changes as auditable controller events.
- Add CLI inspection for the organization tree, team capacity, assignments, and idle/busy state.

### Exit criteria

- One orchestrator can register two or three managers.
- Each manager can own three or four task workers.
- A manager can assign, reassign, pause, and cancel its workers' tasks within its authority scope.
- Invalid reporting relationships and unauthorized assignments fail closed.

## Phase 2: Durable agent communication

Replace lifecycle-only result passing with a general typed communication layer.

### Deliverables

- Introduce a versioned `AgentMessage` envelope with message ID, sender, recipient, thread,
  correlation ID, type, timestamp, delivery state, and structured payload.
- Support at least:
  - `TASK_DELEGATION`
  - `PROGRESS_REPORT`
  - `QUESTION`
  - `ANSWER`
  - `BLOCKER`
  - `CORRECTION_REQUEST`
  - `ESCALATION`
  - `DECISION`
  - `APPROVAL_REQUEST`
  - `APPROVAL_RESPONSE`
- Provide persistent per-agent inboxes and outboxes with acknowledgement, retry, deduplication, and
  dead-letter handling.
- Enforce routing policy from the reporting graph. Workers normally communicate through their
  manager; managers escalate to the orchestrator.
- Preserve structured lifecycle artifacts as message attachments instead of converting everything
  into unstructured chat.
- Add CLI/API inspection for conversations, pending questions, unanswered escalations, and delivery
  failures.

### Exit criteria

- A worker can report progress or a blocker to its manager without manual relay.
- A manager can answer, request correction, or escalate the message to the orchestrator.
- Every message is delivered at least once and applied exactly once.
- A restarted controller resumes pending delivery without losing or duplicating decisions.

## Phase 3: Manager execution loop

Give manager agents responsibility for planning and supervising their teams.

### Deliverables

- Define structured manager inputs and outputs for objective decomposition, worker assignment,
  status synthesis, correction, and escalation.
- Let a manager turn an orchestrator objective into dependency-aware child tasks with owned paths
  and acceptance criteria.
- Let managers choose workers based on capability, availability, path ownership, and resource cost.
- Aggregate worker reports into concise manager reports instead of forwarding every raw event to the
  orchestrator.
- Require manager review before integration or escalation when target policy calls for it.
- Bound decomposition depth, retries, open questions, and correction loops.

### Exit criteria

- The orchestrator can give one objective to a manager without hand-authored worker task JSON.
- The manager decomposes, assigns, tracks, corrects, and completes the child work automatically.
- The orchestrator receives a consolidated result, material risk, or explicit decision request.

## Phase 4: User decisions and approval gates

Make permission a controller-owned workflow instead of an interactive worker concern.

### Deliverables

- Add durable `DecisionRequest` and `ApprovalRequest` records containing the action, rationale, risk,
  evidence, alternatives, recommendation, requester, and affected work.
- Support `PENDING`, `APPROVED`, `DENIED`, `CANCELLED`, and `EXPIRED` outcomes.
- Pause only dependent commands while unrelated safe work continues.
- Add CLI/API commands to list, inspect, approve, deny, or request clarification.
- Deliver the user's response back through the authority chain with a correlation ID.
- Record who decided, when, under which policy, and what execution resumed.
- Keep worker subprocesses non-interactive; the orchestrator owns the user-facing approval channel.

### Exit criteria

- A worker blocker can become a manager escalation and then an orchestrator approval request.
- The user can approve or deny once without copying content between agents.
- Dependent work resumes or terminates deterministically after the decision.
- Workers cannot bypass approval policy or contact the user directly.

## Phase 5: Concurrent team execution

Run the organization as parallel teams while preserving existing safety boundaries.

### Deliverables

- Replace the sequential command loop with a bounded asynchronous worker pool.
- Enforce global, per-manager, per-repository, and resource-class concurrency limits.
- Continue preventing conflicting owned-path mutations and unsafe simultaneous integration.
- Add command cancellation, timeouts, heartbeat/lease recovery, and orphan reconciliation.
- Schedule fairly across managers while respecting priority and task dependencies.
- Expose live capacity, queue latency, utilization, and stalled-command diagnostics.

### Exit criteria

- Two or three managers can supervise three or four workers each.
- Independent tasks execute concurrently; conflicting tasks remain serialized.
- Restart, timeout, and worker failure do not lose work or corrupt controller state.
- Resource and path limits remain enforceable under maximum configured concurrency.

## Phase 6: Project adapters and operator experience

Make the orchestrator practical across TypeScript and mixed-stack repositories.

### Deliverables

- Publish a stable adapter contract for repository discovery, capability policy, task templates,
  validation, and customized approval workflows.
- Provide a reference TypeScript adapter and migration guide for existing repositories.
- Add a local API and event stream suitable for terminal, web, or IDE interfaces.
- Provide an operator view for organization, conversations, approvals, progress, failures, costs, and
  evidence.
- Add notification hooks without coupling the control plane to one chat or issue-tracking product.
- Version persisted state and support forward migrations.

### Exit criteria

- A new TypeScript repository can connect through a thin adapter without copying Agent OS source.
- Operators can supervise the whole hierarchy and answer approvals from one interface.
- Project-specific workflows remain outside the Agent OS core.

## Cross-cutting verification

Every phase must add tests for:

- success, rejection, retry, restart, timeout, and duplicate-delivery paths;
- role and authority violations;
- reporting-graph and message-routing invariants;
- approval bypass attempts;
- concurrent path, Git, resource, and integration conflicts;
- persisted-state migrations and recovery;
- a complete zero-copy scenario from user objective through managers and workers to acceptance.

The milestone is complete when a user can submit one objective, receive only genuine decision or
approval requests, and obtain the final validated result without manually relaying content between
any agents.
