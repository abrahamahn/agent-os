// src/agent/orchestrator.ts
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { ValidationEvidenceStore } from '../validation/validation-evidence';

import { HostValidationRunner } from './host-validation';
import {
  acceptedReviews,
  activeTask,
  addEvent,
  agentById,
  buildPrompt,
  capturedCandidateExists,
  commandIsActiveIntegration,
  completeCommand,
  ensureAgent,
  git,
  integrationBindingMatches,
  integrationEntryFromReview,
  integrationPrompt,
  invalidateIntegrationForReview,
  materializeReviewCandidate,
  pathsOverlap,
  releaseAgent,
  reviewPrompt,
  reviewTruth,
  taskById,
  validationPrompt,
  verifyGitCandidate,
  verifyRegisteredReviewMaterialization,
  verifyReviewMaterialization,
  verifyReviewSessionEnvironment,
} from './orchestrator-review';
import {
  acquireLock,
  defaultRuntimeDirectory,
  fullSha,
  normalizePaths,
  parseAgentArtifact,
  parseReviewSessionEnvironment,
  processStartTicks,
  readState,
  releaseLock,
  requiredText,
  sameProcess,
  sameSecret,
  stringList,
  trustedDirectory,
  writeState,
} from './orchestrator-state';
import { captureGitCandidate, parseWorkerEnvironment } from './worker-workspace';

import type {
  AgentCommand,
  AgentLifecycle,
  AgentRecord,
  CommandKind,
  EvidenceRecord,
  OrchestrationState,
  OrchestratorOptions,
  ReconcileResult,
  ReviewExecutionBinding,
  ReviewMaterialization,
  StoredArtifact,
  TaskContract,
  TaskRecord,
} from './orchestrator-types';
import type { CapturedCandidate } from './worker-workspace';

export class AgentOrchestrator {
  readonly runtimeDir: string;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly lockPollMs: number;
  private readonly evidenceLookup: (id: string) => Promise<EvidenceRecord | undefined>;
  private readonly allowUnsafeTestRuntime: boolean;

  constructor(options: OrchestratorOptions = {}) {
    this.runtimeDir = path.resolve(options.runtimeDir ?? defaultRuntimeDirectory());
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.lockPollMs = options.lockPollMs ?? 25;
    this.allowUnsafeTestRuntime = options.allowUnsafeTestRuntime === true;
    this.evidenceLookup =
      options.evidenceLookup ??
      (async (id) => {
        const job = await new ValidationEvidenceStore().job(id);
        if (job !== undefined) return job;
        const hostJob = (
          await new HostValidationRunner({
            runtimeDir: path.join(this.runtimeDir, 'host-validation'),
            allowUnsafeTestRuntime: this.allowUnsafeTestRuntime,
          }).state()
        ).jobs.find((candidate) => candidate.id === id);
        if (hostJob === undefined || (hostJob.status !== 'PASS' && hostJob.status !== 'REUSED')) {
          return undefined;
        }
        return {
          state: 'PASS',
          identity: {
            candidateSha: hostJob.candidateSha,
            checkId: hostJob.checkId,
            environmentFingerprint: hostJob.environmentFingerprint,
          },
        };
      });
  }

  private async withState<T>(
    operation: (state: OrchestrationState, now: string) => Promise<T> | T,
  ): Promise<T> {
    const lock = await acquireLock(this.runtimeDir, this.lockPollMs, this.allowUnsafeTestRuntime);
    try {
      const now = this.now().toISOString();
      const state = await readState(this.runtimeDir, now);
      const result = await operation(state, now);
      await writeState(this.runtimeDir, state);
      return result;
    } finally {
      await releaseLock(lock);
    }
  }

  async snapshot(): Promise<OrchestrationState> {
    return this.withState((state) => structuredClone(state));
  }

  async initialize(cycle: string, integratedSha?: string): Promise<OrchestrationState> {
    return this.withState((state, now) => {
      const normalizedCycle = requiredText(cycle, 'cycle');
      if (
        state.cycle !== 'UNASSIGNED' &&
        state.cycle !== normalizedCycle &&
        state.tasks.length > 0
      ) {
        throw new Error(`cannot replace active cycle ${state.cycle}`);
      }
      state.cycle = normalizedCycle;
      if (integratedSha !== undefined)
        state.integratedSha = fullSha(integratedSha, 'integratedSha');
      addEvent(state, now, 'CYCLE_INITIALIZED', `Cycle ${normalizedCycle} initialized`);
      return structuredClone(state);
    });
  }

  async registerAgent(input: {
    id: string;
    role: string;
    pid?: number;
    sessionId?: string;
    environment?: unknown;
    reviewEnvironment?: unknown;
  }): Promise<AgentRecord> {
    return this.withState(async (state, now) => {
      const id = requiredText(input.id, 'agent id');
      const role = requiredText(input.role, 'agent role');
      let agent = state.agents.find((candidate) => candidate.id === id);
      if (agent === undefined) {
        agent = {
          id,
          role,
          lifecycle: 'IDLE',
          sessionId: input.sessionId ?? `registered:${id}`,
          updatedAt: now,
        };
        state.agents.push(agent);
      } else {
        agent.role = role;
        agent.updatedAt = now;
      }
      if (input.pid !== undefined) {
        if (!Number.isSafeInteger(input.pid) || input.pid <= 0)
          throw new Error('agent pid must be positive');
        agent.pid = input.pid;
        const ticks = await processStartTicks(input.pid);
        if (ticks !== undefined) agent.processStartTicks = ticks;
      }
      if (input.sessionId !== undefined)
        agent.sessionId = requiredText(input.sessionId, 'sessionId');
      if (input.environment !== undefined) {
        const environment = parseWorkerEnvironment(input.environment);
        for (const task of state.tasks.filter((candidate) => candidate.ownerAgent === id)) {
          if (
            environment.workspace !== task.worktree ||
            environment.branch !== task.branch ||
            environment.baseSha !== task.baseSha ||
            environment.gitControlDirectory !== task.gitControlDirectory ||
            (task.environmentId !== undefined && environment.environmentId !== task.environmentId)
          ) {
            throw new Error('agent environment does not match its controller-owned task contract');
          }
        }
        for (const task of state.tasks.filter((candidate) => candidate.integration?.agent === id)) {
          const integration = task.integration;
          if (
            integration === undefined ||
            environment.workspace !== integration.worktree ||
            environment.branch !== integration.branch ||
            environment.gitControlDirectory !== integration.gitControlDirectory
          ) {
            throw new Error(
              'integrator environment does not match its controller-owned integration contract',
            );
          }
        }
        agent.environment = environment;
      }
      if (input.reviewEnvironment !== undefined) {
        const reviewEnvironment = parseReviewSessionEnvironment(input.reviewEnvironment);
        if (agent.sessionId !== reviewEnvironment.sessionId) {
          throw new Error('review session does not match registered agent session');
        }
        const task = state.tasks.find(
          (candidate) =>
            candidate.id === reviewEnvironment.taskId &&
            candidate.reviewerAgent === id &&
            candidate.generation === reviewEnvironment.generation,
        );
        if (task === undefined)
          throw new Error('review session task/generation is not registered to this reviewer');
        const errors = await verifyReviewSessionEnvironment(task, reviewEnvironment);
        if (errors.length > 0) throw new Error(errors.join('; '));
        agent.reviewEnvironment = reviewEnvironment;
      }
      addEvent(state, now, 'AGENT_REGISTERED', `${id} registered as ${role}`, {
        agent: id,
      });
      return structuredClone(agent);
    });
  }

  async registerTask(contract: TaskContract): Promise<TaskRecord> {
    return this.withState(async (state, now) => {
      if (state.cycle === 'UNASSIGNED')
        throw new Error('initialize a cycle before registering tasks');
      const normalizedIntegration =
        contract.integration === undefined
          ? undefined
          : {
              ...contract.integration,
              worktree: await trustedDirectory(
                contract.integration.worktree,
                'integration worktree',
              ),
              ...(contract.integration.gitControlDirectory === undefined
                ? {}
                : {
                    gitControlDirectory: await trustedDirectory(
                      contract.integration.gitControlDirectory,
                      'integration Git control directory',
                    ),
                  }),
            };
      const normalized: TaskRecord = {
        ...contract,
        id: requiredText(contract.id, 'task id'),
        cycle: requiredText(contract.cycle, 'task cycle'),
        title: requiredText(contract.title, 'task title'),
        ownerAgent: requiredText(contract.ownerAgent, 'ownerAgent'),
        reviewerAgent: requiredText(contract.reviewerAgent, 'reviewerAgent'),
        worktree: await trustedDirectory(
          requiredText(contract.worktree, 'worktree'),
          'task worktree',
        ),
        branch: requiredText(contract.branch, 'branch'),
        baseSha: fullSha(contract.baseSha, 'baseSha'),
        ...(contract.gitControlDirectory === undefined
          ? {}
          : {
              gitControlDirectory: await trustedDirectory(
                contract.gitControlDirectory,
                'task Git control directory',
              ),
            }),
        dependencies: stringList(contract.dependencies, 'dependencies'),
        ownedPaths: normalizePaths(stringList(contract.ownedPaths, 'ownedPaths')),
        acceptanceCriteria: stringList(contract.acceptanceCriteria, 'acceptanceCriteria'),
        ...(normalizedIntegration === undefined ? {} : { integration: normalizedIntegration }),
        status: 'READY',
        generation: 0,
        negativeReviewShas: [],
        createdAt: now,
        updatedAt: now,
      };
      if (!Number.isSafeInteger(normalized.priority) || normalized.priority < 0) {
        throw new Error('task priority must be a non-negative integer');
      }
      if (normalized.cycle !== state.cycle) throw new Error(`task cycle must be ${state.cycle}`);
      if (normalized.ownerAgent === normalized.reviewerAgent) {
        throw new Error('builder and reviewer must be independent agents');
      }
      if (state.tasks.some((task) => task.id === normalized.id))
        throw new Error(`duplicate task: ${normalized.id}`);
      if (normalized.dependencies.includes(normalized.id))
        throw new Error('task cannot depend on itself');
      for (const dependency of normalized.dependencies) taskById(state, dependency);
      const owner = ensureAgent(state, normalized.ownerAgent, 'Builder', now);
      ensureAgent(state, normalized.reviewerAgent, 'Reviewer', now);
      if (
        owner.environment !== undefined &&
        (owner.environment.workspace !== normalized.worktree ||
          owner.environment.branch !== normalized.branch ||
          owner.environment.baseSha !== normalized.baseSha ||
          owner.environment.gitControlDirectory !== normalized.gitControlDirectory ||
          (normalized.environmentId !== undefined &&
            owner.environment.environmentId !== normalized.environmentId))
      ) {
        throw new Error('task contract does not match the builder execution environment');
      }
      if (normalized.integration !== undefined) {
        ensureAgent(state, normalized.integration.agent, 'Integrator', now);
      }
      if (normalized.validation !== undefined) {
        ensureAgent(state, normalized.validation.agent, 'Validator', now);
      }
      if (normalized.supersedes !== undefined) {
        const superseded = taskById(state, normalized.supersedes);
        if (superseded.status === 'ACCEPTED')
          throw new Error('accepted tasks cannot be superseded');
        superseded.status = 'SUPERSEDED';
        superseded.updatedAt = now;
        for (const command of state.commands.filter((entry) => entry.taskId === superseded.id)) {
          if (command.status === 'PENDING' || command.status === 'CLAIMED')
            command.status = 'CANCELLED';
        }
        for (const entry of state.integrationQueue.filter(
          (candidate) => candidate.taskId === superseded.id,
        )) {
          entry.status = 'SUPERSEDED';
        }
        addEvent(state, now, 'TASK_SUPERSEDED', `${superseded.id} superseded by ${normalized.id}`, {
          taskId: superseded.id,
        });
      }
      if (!normalized.dependencies.every((id) => taskById(state, id).status === 'ACCEPTED')) {
        normalized.status = 'BLOCKED';
        normalized.blocker = `Waiting for dependencies: ${normalized.dependencies
          .filter((id) => taskById(state, id).status !== 'ACCEPTED')
          .join(', ')}`;
      }
      state.tasks.push(normalized);
      addEvent(state, now, 'TASK_REGISTERED', `${normalized.id} registered`, {
        taskId: normalized.id,
      });
      return structuredClone(normalized);
    });
  }

  async requestIndependentReview(taskId: string, reason: string): Promise<AgentCommand> {
    return this.withState((state, now) => {
      const task = taskById(state, requiredText(taskId, 'taskId'));
      if (task.candidateSha === undefined || task.capturedCandidate === undefined) {
        throw new Error('independent review requires a durably captured candidate');
      }
      const reviewer = agentById(state, task.reviewerAgent);
      if (reviewer.lifecycle !== 'IDLE') throw new Error('assigned reviewer is not idle');
      const command = this.createCommand(
        state,
        task,
        reviewer,
        'REVIEW',
        `${reviewPrompt(task)}\n\nCONTROLLER REVIEW REASON: ${requiredText(reason, 'reason')}`,
        now,
      );
      task.status = 'READY_FOR_REVIEW';
      task.updatedAt = now;
      return structuredClone(command);
    });
  }

  private createCommand(
    state: OrchestrationState,
    task: TaskRecord,
    agent: AgentRecord,
    kind: CommandKind,
    prompt: string,
    now: string,
  ): AgentCommand {
    const existing = state.commands.find(
      (command) =>
        command.taskId === task.id &&
        command.agent === agent.id &&
        command.kind === kind &&
        command.generation === task.generation &&
        (command.status === 'PENDING' || command.status === 'CLAIMED'),
    );
    if (existing !== undefined) return existing;
    const commandId = this.idFactory();
    const sessionId = agent.sessionId ?? `registered:${agent.id}`;
    const artifactToken = randomUUID();
    const materialization = task.reviewMaterialization;
    if (kind === 'REVIEW' && materialization === undefined) {
      throw new Error('REVIEW_MATERIALIZATION_MISMATCH: review command has no materialization');
    }
    const reviewBinding: ReviewExecutionBinding | undefined =
      kind === 'REVIEW' && materialization !== undefined
        ? {
            taskId: task.id,
            generation: task.generation,
            commandId,
            reviewerAgent: agent.id,
            reviewerSessionId: sessionId,
            candidateSha: materialization.candidateSha,
            candidateTreeSha: materialization.candidateTreeSha,
            durableCandidateRef: materialization.durableCandidateRef,
            durableStoreGitDirectory: materialization.durableStoreGitDirectory,
            materializationId: materialization.id,
            reviewCheckout: materialization.checkout,
            gitControlDirectory: materialization.gitControlDirectory,
          }
        : undefined;
    const command: AgentCommand = {
      id: commandId,
      taskId: task.id,
      agent: agent.id,
      kind,
      status: 'PENDING',
      generation: task.generation,
      sessionId,
      artifactToken,
      prompt: `${prompt}\n\nRESULT AUTHORITY: submit through the controller interface with commandId ${commandId}, generation ${String(task.generation)}, sessionId ${sessionId}, artifactToken ${artifactToken}, a unique idempotencyKey, artifactType matching kind, and the exact candidateSha. Workers cannot write controller state directly.`,
      createdAt: now,
      ...(reviewBinding === undefined ? {} : { reviewBinding }),
    };
    state.commands.push(command);
    agent.lifecycle = 'DISPATCHED';
    agent.currentTask = task.id;
    agent.updatedAt = now;
    addEvent(state, now, 'COMMAND_ISSUED', `${kind} issued to ${agent.id}`, {
      taskId: task.id,
      agent: agent.id,
    });
    return command;
  }

  async reconcile(): Promise<ReconcileResult> {
    return this.withState(async (state, now) => {
      const initialSequence = state.sequence;
      const initialCommandIds = new Set(state.commands.map((command) => command.id));

      for (const agent of state.agents) {
        if (
          agent.pid !== undefined &&
          ['WORKING', 'REVIEWING', 'INTEGRATING', 'VALIDATING'].includes(agent.lifecycle) &&
          !(await sameProcess(agent.pid, agent.processStartTicks))
        ) {
          const active = state.commands.find(
            (command) =>
              command.agent === agent.id &&
              command.taskId === agent.currentTask &&
              command.status === 'CLAIMED',
          );
          if (active !== undefined) {
            active.status = 'CANCELLED';
            const task = taskById(state, active.taskId);
            if (active.kind === 'INTEGRATE') {
              const entry = state.integrationQueue
                .slice()
                .reverse()
                .find(
                  (candidate) => candidate.taskId === task.id && candidate.status === 'INTEGRATING',
                );
              const integration = task.integration;
              let unchanged = false;
              let observed = 'integration worktree could not be inspected';
              if (entry !== undefined && integration !== undefined) {
                try {
                  const [head, tree, branch, dirty] = await Promise.all([
                    git(
                      integration.worktree,
                      ['rev-parse', 'HEAD'],
                      integration.gitControlDirectory,
                    ),
                    git(
                      integration.worktree,
                      ['rev-parse', 'HEAD^{tree}'],
                      integration.gitControlDirectory,
                    ),
                    git(
                      integration.worktree,
                      ['branch', '--show-current'],
                      integration.gitControlDirectory,
                    ),
                    git(
                      integration.worktree,
                      ['status', '--porcelain'],
                      integration.gitControlDirectory,
                    ),
                  ]);
                  unchanged =
                    head.toLowerCase() === entry.expectedPredecessorSha &&
                    branch === integration.branch &&
                    dirty.length === 0;
                  observed = `HEAD ${head.toLowerCase()} tree ${tree.toLowerCase()} branch ${branch || '(detached)'} clean ${String(dirty.length === 0)}`;
                } catch (error) {
                  observed = error instanceof Error ? error.message : String(error);
                }
              }
              releaseAgent(state, agent.id, now);
              if (unchanged && entry !== undefined) {
                entry.status = 'QUEUED';
                task.status = 'READY_FOR_INTEGRATION';
                delete task.blocker;
                addEvent(
                  state,
                  now,
                  'INTEGRATION_RETRY_SAFE',
                  `No Git effect observed after worker exit; ${observed}`,
                  { taskId: task.id, agent: agent.id },
                );
              } else {
                if (entry !== undefined) {
                  entry.status = 'REMOVED';
                  entry.failureCode = 'INTEGRATION_OUTCOME_UNKNOWN';
                }
                task.status = 'BLOCKED';
                task.blocker = `INTEGRATION_RECONCILIATION_REQUIRED: ${observed}; do not resume until the Git effect is classified`;
                addEvent(state, now, 'INTEGRATION_RECONCILIATION_REQUIRED', task.blocker, {
                  taskId: task.id,
                  agent: agent.id,
                });
              }
            } else {
              this.createCommand(
                state,
                task,
                agent,
                active.kind,
                `Resume ${active.kind} for ${task.id} after unexpected process exit. Reconcile the current worktree and do not claim completion without a terminal artifact.\n\n${active.prompt}`,
                now,
              );
              agent.lifecycle = 'DISPATCHED';
            }
          } else {
            releaseAgent(state, agent.id, now);
          }
          delete agent.pid;
          delete agent.processStartTicks;
          addEvent(state, now, 'AGENT_EXITED', `${agent.id} exited; process state reconciled`, {
            ...(active === undefined ? {} : { taskId: active.taskId }),
            agent: agent.id,
          });
        }
      }

      for (const task of state.tasks) {
        if (
          task.status === 'BLOCKED' &&
          task.blocker?.startsWith('Waiting for dependencies:') === true &&
          task.dependencies.every((id) => taskById(state, id).status === 'ACCEPTED')
        ) {
          task.status = 'READY';
          delete task.blocker;
          task.updatedAt = now;
          addEvent(state, now, 'DEPENDENCIES_READY', `${task.id} dependencies accepted`, {
            taskId: task.id,
          });
        }
      }

      const orderedTasks = state.tasks
        .filter((task) => task.status === 'READY')
        .sort(
          (left, right) =>
            left.priority - right.priority || left.createdAt.localeCompare(right.createdAt),
        );
      for (const task of orderedTasks) {
        const agent = agentById(state, task.ownerAgent);
        const conflict = state.tasks.find(
          (candidate) =>
            candidate.id !== task.id &&
            activeTask(candidate.status) &&
            pathsOverlap(task.ownedPaths, candidate.ownedPaths),
        );
        if (agent.lifecycle !== 'IDLE' || conflict !== undefined) continue;
        this.createCommand(state, task, agent, 'BUILD', buildPrompt(task), now);
        task.status = 'DISPATCHED';
        task.updatedAt = now;
      }

      for (const task of state.tasks.filter(
        (candidate) =>
          candidate.status === 'READY_FOR_REVIEW' || candidate.status === 'REVIEW_RETRYABLE',
      )) {
        if ((await verifyRegisteredReviewMaterialization(task)).length > 0) continue;
        const reviewer = agentById(state, task.reviewerAgent);
        if (reviewer.lifecycle !== 'IDLE') continue;
        this.createCommand(state, task, reviewer, 'REVIEW', reviewPrompt(task), now);
        task.status = 'READY_FOR_REVIEW';
        delete task.blocker;
        task.updatedAt = now;
      }

      for (const entry of state.integrationQueue.filter((candidate) =>
        ['QUEUED', 'INTEGRATING', 'VALIDATING'].includes(candidate.status),
      )) {
        const task = taskById(state, entry.taskId);
        const truth = reviewTruth(state, task);
        const bindingConflict = !integrationBindingMatches(entry, task, truth);
        const candidateExists = await capturedCandidateExists(task, this.runtimeDir);
        const predecessorMatches =
          entry.expectedPredecessorSha === (state.integratedSha ?? task.baseSha);
        if (!bindingConflict && candidateExists && predecessorMatches) continue;
        entry.status = 'REMOVED';
        entry.reviewSupersessionState = 'SUPERSEDED';
        for (const command of state.commands.filter(
          (candidate) => candidate.taskId === task.id && commandIsActiveIntegration(candidate),
        )) {
          const wasPending = command.status === 'PENDING';
          command.status = 'CANCELLED';
          command.completedAt = now;
          if (wasPending) releaseAgent(state, command.agent, now);
        }
        if (!predecessorMatches && !bindingConflict && candidateExists) {
          task.status = 'REVIEW_PASS';
          delete task.blocker;
          addEvent(
            state,
            now,
            'INTEGRATION_PREDECESSOR_ADVANCED',
            `${task.id} will be rebound to ${state.integratedSha ?? task.baseSha}`,
            { taskId: task.id },
          );
        } else if (truth.invalidated === true) {
          entry.failureCode = 'REVIEW_INVALIDATED';
          task.status = truth.verdict === 'CHANGES_REQUIRED' ? 'CHANGES_REQUIRED' : 'BLOCKED';
          task.blocker = `REVIEW_INVALIDATED: ${truth.reason}`;
          addEvent(state, now, 'REVIEW_INVALIDATED', task.blocker, {
            taskId: task.id,
          });
        } else if (truth.conflict || bindingConflict) {
          entry.failureCode = 'REVIEW_STATE_CONFLICT';
          task.status = 'BLOCKED';
          task.blocker = `REVIEW_STATE_CONFLICT: ${truth.conflict ? truth.reason : 'queued integration review binding is stale or incomplete'}`;
          addEvent(state, now, 'REVIEW_STATE_CONFLICT', task.blocker, {
            taskId: task.id,
          });
        } else if (!candidateExists) {
          task.status = 'BLOCKED';
          task.blocker = `CANDIDATE_SHA_MISSING: ${task.candidateSha ?? entry.sourceSha}`;
          addEvent(state, now, 'CANDIDATE_SHA_MISSING', task.blocker, {
            taskId: task.id,
          });
        } else {
          task.status = 'READY_FOR_REVIEW';
          task.blocker = truth.reason;
        }
        task.updatedAt = now;
      }

      for (const task of state.tasks.filter((candidate) => candidate.status === 'REVIEW_PASS')) {
        if (!task.dependencies.every((id) => taskById(state, id).status === 'ACCEPTED')) continue;
        const truth = reviewTruth(state, task);
        if (!truth.eligible) {
          task.status = truth.conflict ? 'BLOCKED' : 'READY_FOR_REVIEW';
          task.blocker = truth.conflict ? `REVIEW_STATE_CONFLICT: ${truth.reason}` : truth.reason;
          task.updatedAt = now;
          if (truth.conflict) {
            addEvent(state, now, 'REVIEW_STATE_CONFLICT', task.blocker, {
              taskId: task.id,
            });
          }
          continue;
        }
        if (task.candidateSha === undefined) throw new Error('review truth lost its candidate SHA');
        if (!(await capturedCandidateExists(task, this.runtimeDir))) {
          task.status = 'BLOCKED';
          task.blocker = `CANDIDATE_SHA_MISSING: ${task.candidateSha}`;
          task.updatedAt = now;
          addEvent(state, now, 'CANDIDATE_SHA_MISSING', task.blocker, {
            taskId: task.id,
          });
          continue;
        }
        if (
          state.integrationQueue.some(
            (entry) =>
              entry.taskId === task.id &&
              integrationBindingMatches(entry, task, truth) &&
              !['SUPERSEDED', 'REMOVED'].includes(entry.status),
          )
        ) {
          task.status = 'READY_FOR_INTEGRATION';
          continue;
        }
        state.integrationQueue.push(integrationEntryFromReview(state, task, truth, now));
        task.status = 'READY_FOR_INTEGRATION';
        task.updatedAt = now;
        addEvent(state, now, 'INTEGRATION_QUEUED', `${task.id} queued at ${task.candidateSha}`, {
          taskId: task.id,
        });
      }

      const integrationBusy = state.integrationQueue.some((entry) =>
        ['INTEGRATING', 'VALIDATING'].includes(entry.status),
      );
      const nextIntegration = integrationBusy
        ? undefined
        : state.integrationQueue.find((entry) => {
            if (entry.status !== 'QUEUED') return false;
            const task = taskById(state, entry.taskId);
            return (
              integrationBindingMatches(entry, task, reviewTruth(state, task)) &&
              task.dependencies.every((id) => taskById(state, id).status === 'ACCEPTED')
            );
          });
      if (nextIntegration !== undefined) {
        const task = taskById(state, nextIntegration.taskId);
        const integration = task.integration;
        if (integration !== undefined) {
          const integrator = agentById(state, integration.agent);
          if (integrator.lifecycle === 'IDLE') {
            this.createCommand(
              state,
              task,
              integrator,
              'INTEGRATE',
              integrationPrompt(state, task),
              now,
            );
          }
        }
      }

      return {
        changed: state.sequence !== initialSequence,
        commandsCreated: state.commands
          .filter((command) => !initialCommandIds.has(command.id))
          .map((command) => structuredClone(command)),
        events: state.events
          .filter((event) => event.sequence > initialSequence)
          .map((event) => structuredClone(event)),
      };
    });
  }

  async claimNextCommand(agentId: string): Promise<AgentCommand | undefined> {
    return this.withState(async (state, now) => {
      const agent = agentById(state, requiredText(agentId, 'agent id'));
      const command = state.commands.find(
        (candidate) => candidate.agent === agent.id && candidate.status === 'PENDING',
      );
      if (command === undefined) return undefined;
      const task = taskById(state, command.taskId);
      if (command.kind === 'REVIEW') {
        const binding = command.reviewBinding;
        const environment = agent.reviewEnvironment;
        const errors: string[] = [];
        if (binding === undefined)
          errors.push('REVIEW_MATERIALIZATION_MISMATCH: command binding is missing');
        if (environment === undefined)
          errors.push('CANDIDATE_UNAVAILABLE: reviewer session is not registered');
        if (binding !== undefined && environment !== undefined) {
          if (
            binding.reviewerSessionId !== agent.sessionId ||
            binding.reviewerSessionId !== environment.sessionId
          )
            errors.push('REVIEW_MATERIALIZATION_MISMATCH: reviewer session does not match command');
          errors.push(...(await verifyReviewSessionEnvironment(task, environment)));
        }
        if (errors.length > 0) {
          command.status = 'CANCELLED';
          command.completedAt = now;
          task.status = 'REVIEW_RETRYABLE';
          task.blocker = errors.join('; ');
          task.updatedAt = now;
          releaseAgent(state, agent.id, now);
          addEvent(state, now, 'REVIEW_RETRYABLE', task.blocker, {
            taskId: task.id,
            agent: agent.id,
          });
          return undefined;
        }
      }
      if (command.kind === 'INTEGRATE') {
        const entry = state.integrationQueue
          .slice()
          .reverse()
          .find((candidate) => candidate.taskId === task.id && candidate.status === 'QUEUED');
        const truth = reviewTruth(state, task);
        const candidateExists = await capturedCandidateExists(task, this.runtimeDir);
        const dependenciesAccepted = task.dependencies.every(
          (id) => taskById(state, id).status === 'ACCEPTED',
        );
        let integrationEnvironmentReady = false;
        const integration = task.integration;
        if (integration !== undefined) {
          const expectedBase = entry?.expectedPredecessorSha ?? state.integratedSha ?? task.baseSha;
          try {
            const actualRoot = path.resolve(
              await git(
                integration.worktree,
                ['rev-parse', '--show-toplevel'],
                integration.gitControlDirectory,
              ),
            );
            const branch = await git(
              integration.worktree,
              ['branch', '--show-current'],
              integration.gitControlDirectory,
            );
            const head = await git(
              integration.worktree,
              ['rev-parse', 'HEAD'],
              integration.gitControlDirectory,
            );
            const dirty = await git(
              integration.worktree,
              ['status', '--porcelain'],
              integration.gitControlDirectory,
            );
            integrationEnvironmentReady =
              actualRoot === path.resolve(integration.worktree) &&
              branch === integration.branch &&
              head.toLowerCase() === expectedBase &&
              dirty.length === 0;
          } catch {
            integrationEnvironmentReady = false;
          }
        }
        if (
          entry === undefined ||
          !integrationBindingMatches(entry, task, truth) ||
          !candidateExists ||
          !dependenciesAccepted ||
          entry.expectedPredecessorSha !== (state.integratedSha ?? task.baseSha) ||
          !integrationEnvironmentReady
        ) {
          command.status = 'CANCELLED';
          command.completedAt = now;
          if (entry !== undefined) {
            entry.status = 'REMOVED';
            entry.reviewSupersessionState = 'SUPERSEDED';
            entry.failureCode =
              truth.invalidated === true ? 'REVIEW_INVALIDATED' : 'REVIEW_STATE_CONFLICT';
          }
          task.status = truth.verdict === 'CHANGES_REQUIRED' ? 'CHANGES_REQUIRED' : 'BLOCKED';
          task.blocker = `${truth.invalidated === true ? 'REVIEW_INVALIDATED' : 'REVIEW_STATE_CONFLICT'}: ${!candidateExists ? 'candidate exact SHA/tree is unavailable in the durable controller store' : !dependenciesAccepted ? 'dependencies are no longer accepted' : entry?.expectedPredecessorSha !== (state.integratedSha ?? task.baseSha) ? 'integration predecessor binding is stale' : !integrationEnvironmentReady ? 'integrator worktree is not clean at the accepted predecessor' : truth.reason}`;
          task.updatedAt = now;
          releaseAgent(state, agent.id, now);
          addEvent(
            state,
            now,
            truth.invalidated === true ? 'REVIEW_INVALIDATED' : 'REVIEW_STATE_CONFLICT',
            task.blocker,
            { taskId: task.id, agent: agent.id },
          );
          return undefined;
        }
      }
      command.status = 'CLAIMED';
      command.claimedAt = now;
      const lifecycle: AgentLifecycle =
        command.kind === 'REVIEW'
          ? 'REVIEWING'
          : command.kind === 'INTEGRATE'
            ? 'INTEGRATING'
            : command.kind === 'VALIDATE'
              ? 'VALIDATING'
              : 'WORKING';
      agent.lifecycle = lifecycle;
      agent.currentTask = task.id;
      agent.updatedAt = now;
      task.status =
        command.kind === 'REVIEW'
          ? 'REVIEWING'
          : command.kind === 'INTEGRATE'
            ? 'INTEGRATING'
            : command.kind === 'VALIDATE'
              ? 'VALIDATING'
              : 'WORKING';
      task.updatedAt = now;
      const queueEntry = state.integrationQueue
        .slice()
        .reverse()
        .find((entry) => entry.taskId === task.id && entry.status === 'QUEUED');
      if (command.kind === 'INTEGRATE' && queueEntry !== undefined)
        queueEntry.status = 'INTEGRATING';
      addEvent(state, now, 'COMMAND_CLAIMED', `${command.kind} claimed by ${agent.id}`, {
        taskId: task.id,
        agent: agent.id,
      });
      return structuredClone(command);
    });
  }

  async submitArtifact(input: unknown): Promise<StoredArtifact> {
    const artifact = parseAgentArtifact(input);
    const before = await this.snapshot();
    const task = taskById(before, artifact.taskId);
    let verificationErrors: string[] = [];
    const identicalReplay = before.artifacts.find(
      (stored) => stored.artifact.idempotencyKey === artifact.idempotencyKey,
    );
    if (identicalReplay !== undefined) {
      if (JSON.stringify(identicalReplay.artifact) !== JSON.stringify(artifact)) {
        throw new Error('IDEMPOTENCY_CONFLICT: key was already used for different artifact bytes');
      }
      return structuredClone(identicalReplay);
    }
    const command = before.commands.find((candidate) => candidate.id === artifact.commandId);
    const expectedKinds: readonly CommandKind[] =
      artifact.kind === 'BUILDER_RESULT'
        ? ['BUILD', 'CORRECTION']
        : artifact.kind === 'REVIEW_RESULT'
          ? ['REVIEW']
          : artifact.kind === 'INTEGRATION_RESULT'
            ? ['INTEGRATE']
            : ['VALIDATE'];
    const agent = before.agents.find((candidate) => candidate.id === artifact.agent);
    if (command === undefined) verificationErrors.push('artifact commandId is unknown');
    else {
      if (command.status !== 'CLAIMED') verificationErrors.push('artifact command is not claimed');
      if (command.taskId !== artifact.taskId)
        verificationErrors.push('artifact command task mismatch');
      if (command.agent !== artifact.agent)
        verificationErrors.push('artifact command agent mismatch');
      if (!expectedKinds.includes(command.kind))
        verificationErrors.push('artifact type does not match command');
      if (command.generation !== artifact.generation)
        verificationErrors.push('artifact generation does not match command');
      if (command.sessionId !== artifact.sessionId)
        verificationErrors.push('artifact session does not match command');
      if (!sameSecret(command.artifactToken, artifact.artifactToken))
        verificationErrors.push('artifact authentication token is invalid');
    }
    if (agent?.sessionId !== artifact.sessionId)
      verificationErrors.push('artifact session is not the registered agent session');
    const payloadCandidateSha =
      artifact.kind === 'BUILDER_RESULT'
        ? artifact.resultSha
        : artifact.kind === 'REVIEW_RESULT'
          ? artifact.reviewedSha
          : artifact.kind === 'INTEGRATION_RESULT'
            ? artifact.sourceSha
            : artifact.resultSha;
    if (artifact.candidateSha !== payloadCandidateSha)
      verificationErrors.push('artifact candidateSha does not match its result payload');
    const authorizationFailed = verificationErrors.length > 0;

    let capturedCandidate: CapturedCandidate | undefined;
    let reviewMaterialization: ReviewMaterialization | undefined;

    if (artifact.kind === 'BUILDER_RESULT') {
      const builder = agentById(before, task.ownerAgent);
      if (artifact.agent !== task.ownerAgent)
        verificationErrors.push(`builder must be ${task.ownerAgent}`);
      if (artifact.worktree !== task.worktree)
        verificationErrors.push('artifact worktree does not match task');
      if (artifact.branch !== task.branch)
        verificationErrors.push('artifact branch does not match task');
      if (artifact.baseSha !== task.baseSha)
        verificationErrors.push('artifact base SHA does not match task');
      if (
        builder.environment !== undefined &&
        (builder.environment.workspace !== artifact.worktree ||
          builder.environment.branch !== artifact.branch ||
          builder.environment.baseSha !== artifact.baseSha ||
          builder.environment.gitControlDirectory !== task.gitControlDirectory)
      ) {
        verificationErrors.push(
          'builder result does not match its registered execution environment',
        );
      }
      if (artifact.status === 'PASS') {
        verificationErrors = verificationErrors.concat(
          await verifyGitCandidate({
            worktree: artifact.worktree,
            branch: artifact.branch,
            baseSha: artifact.baseSha,
            resultSha: artifact.resultSha,
            filesChanged: artifact.filesChanged,
            ...(task.gitControlDirectory === undefined
              ? {}
              : { gitControlDirectory: task.gitControlDirectory }),
            ...(task.status === 'CHANGES_REQUIRED' && task.candidateSha !== undefined
              ? { previousSha: task.candidateSha }
              : {}),
          }),
        );
        if (artifact.resultSha === artifact.baseSha)
          verificationErrors.push('builder result must change the base SHA');
        if (verificationErrors.length === 0) {
          capturedCandidate = await captureGitCandidate({
            taskId: task.id,
            worktree: task.worktree,
            candidateSha: artifact.resultSha,
            storeGitDirectory: path.join(this.runtimeDir, 'object-store.git'),
            ...(task.gitControlDirectory === undefined
              ? {}
              : { gitControlDirectory: task.gitControlDirectory }),
            now: this.now(),
          });
          reviewMaterialization = await materializeReviewCandidate(
            this.runtimeDir,
            task.id,
            task.generation,
            capturedCandidate,
            this.now().toISOString(),
          );
        }
      } else if (artifact.blockers.length === 0) {
        verificationErrors.push(`${artifact.status} builder result requires blockers`);
      }
    } else if (artifact.kind === 'REVIEW_RESULT') {
      const binding = command?.reviewBinding;
      if (binding === undefined) {
        verificationErrors.push(
          'REVIEW_MATERIALIZATION_MISMATCH: review command binding is missing',
        );
      } else if (
        binding.taskId !== artifact.taskId ||
        binding.generation !== artifact.generation ||
        binding.commandId !== artifact.commandId ||
        binding.reviewerAgent !== artifact.agent ||
        binding.reviewerSessionId !== artifact.sessionId ||
        binding.candidateSha !== artifact.reviewedSha ||
        binding.candidateTreeSha !== artifact.candidateTreeSha ||
        binding.materializationId !== artifact.reviewMaterializationId ||
        binding.reviewCheckout !== artifact.reviewCheckout ||
        binding.durableCandidateRef !== artifact.durableCandidateRef ||
        binding.durableStoreGitDirectory !== artifact.durableStoreGitDirectory
      ) {
        verificationErrors.push(
          'REVIEW_MATERIALIZATION_MISMATCH: artifact disagrees with structured command binding',
        );
      }
      verificationErrors = verificationErrors.concat(
        await verifyReviewMaterialization(task, artifact),
      );
      if (artifact.agent !== task.reviewerAgent)
        verificationErrors.push(`reviewer must be ${task.reviewerAgent}`);
      if (artifact.agent === task.ownerAgent)
        verificationErrors.push('builder may not self-approve');
      if (agent?.reviewEnvironment === undefined) {
        verificationErrors.push(
          'CANDIDATE_UNAVAILABLE: reviewer session environment is not registered',
        );
      } else {
        verificationErrors.push(
          ...(await verifyReviewSessionEnvironment(task, agent.reviewEnvironment)),
        );
      }
      if (artifact.reviewedSha !== task.candidateSha)
        verificationErrors.push('reviewed SHA is not the current candidate');
      if (artifact.status === 'PASS' && task.negativeReviewShas.includes(artifact.reviewedSha)) {
        verificationErrors.push(
          'REVIEW_INVALIDATED: candidate SHA has an authoritative negative-review fence',
        );
      }
      if (artifact.status === 'CHANGES_REQUIRED' && artifact.findings.length === 0) {
        verificationErrors.push('CHANGES_REQUIRED review must contain findings');
      }
    } else if (artifact.kind === 'INTEGRATION_RESULT') {
      const integration = task.integration;
      const truth = reviewTruth(before, task);
      if (!truth.eligible) {
        verificationErrors.push(`REVIEW_STATE_CONFLICT: ${truth.reason}`);
      }
      const queueEntry = before.integrationQueue.find(
        (entry) =>
          entry.taskId === task.id &&
          entry.sourceSha === artifact.sourceSha &&
          entry.status === 'INTEGRATING',
      );
      if (queueEntry === undefined) {
        verificationErrors.push('integration candidate is not an active exact-SHA queue entry');
      } else if (!integrationBindingMatches(queueEntry, task, truth)) {
        verificationErrors.push('REVIEW_STATE_CONFLICT: integration review binding is stale');
      }
      if (integration === undefined) verificationErrors.push('task has no integration contract');
      else {
        const integrator = agentById(before, integration.agent);
        if (artifact.agent !== integration.agent)
          verificationErrors.push(`integrator must be ${integration.agent}`);
        if (artifact.worktree !== path.resolve(integration.worktree))
          verificationErrors.push('integration worktree mismatch');
        if (artifact.branch !== integration.branch)
          verificationErrors.push('integration branch mismatch');
        if (
          integrator.environment !== undefined &&
          (integrator.environment.workspace !== artifact.worktree ||
            integrator.environment.branch !== artifact.branch ||
            integrator.environment.gitControlDirectory !== integration.gitControlDirectory)
        ) {
          verificationErrors.push(
            'integration result does not match the integrator execution environment',
          );
        }
      }
      if (artifact.sourceSha !== task.candidateSha)
        verificationErrors.push('integration source is not reviewed candidate');
      if (
        artifact.baseSha !== queueEntry?.expectedPredecessorSha ||
        artifact.baseSha !== (before.integratedSha ?? task.baseSha)
      )
        verificationErrors.push('integration base is not current accepted predecessor');
      if (artifact.status === 'PASS') {
        verificationErrors = verificationErrors.concat(
          await verifyGitCandidate({
            worktree: artifact.worktree,
            branch: artifact.branch,
            baseSha: artifact.baseSha,
            resultSha: artifact.resultSha,
            filesChanged: artifact.filesChanged,
            ...(integration?.gitControlDirectory === undefined
              ? {}
              : { gitControlDirectory: integration.gitControlDirectory }),
          }),
        );
      } else if (artifact.blockers.length === 0) {
        verificationErrors.push(`${artifact.status} integration result requires blockers`);
      }
    } else {
      const validation = task.validation;
      if (validation === undefined) verificationErrors.push('task has no validation contract');
      else if (artifact.agent !== validation.agent)
        verificationErrors.push(`validator must be ${validation.agent}`);
      const queueEntry = before.integrationQueue
        .slice()
        .reverse()
        .find((entry) => entry.taskId === task.id && entry.status === 'VALIDATING');
      if (!reviewTruth(before, task).eligible) {
        verificationErrors.push('REVIEW_STATE_CONFLICT: validation candidate lost review truth');
      }
      if (queueEntry?.status !== 'VALIDATING') {
        verificationErrors.push('validation candidate is not in VALIDATING state');
      }
      if (artifact.resultSha !== queueEntry?.resultSha)
        verificationErrors.push('validation SHA is not integrated result');
      if (artifact.status === 'PASS' && validation !== undefined) {
        const evidence = await Promise.all(
          artifact.evidenceIds.map((id) => this.evidenceLookup(id)),
        );
        for (const check of validation.checks) {
          const matching = evidence.find(
            (entry) =>
              entry?.state === 'PASS' &&
              entry.identity.candidateSha === artifact.resultSha &&
              entry.identity.checkId === check.checkId &&
              (check.environmentFingerprint === undefined ||
                entry.identity.environmentFingerprint === check.environmentFingerprint),
          );
          if (matching === undefined)
            verificationErrors.push(`missing exact-SHA PASS evidence for ${check.checkId}`);
        }
      } else if (artifact.status !== 'PASS' && artifact.blockers.length === 0) {
        verificationErrors.push(`${artifact.status} validation result requires blockers`);
      }
    }

    return this.withState((state, now) => {
      const concurrentReplay = state.artifacts.find(
        (stored) => stored.artifact.idempotencyKey === artifact.idempotencyKey,
      );
      if (concurrentReplay !== undefined) {
        if (JSON.stringify(concurrentReplay.artifact) !== JSON.stringify(artifact)) {
          throw new Error('IDEMPOTENCY_CONFLICT: key was concurrently reused');
        }
        return structuredClone(concurrentReplay);
      }
      const currentTask = taskById(state, artifact.taskId);
      const liveCommand = state.commands.find((candidate) => candidate.id === artifact.commandId);
      if (
        verificationErrors.length === 0 &&
        (liveCommand === undefined ||
          liveCommand.status !== 'CLAIMED' ||
          liveCommand.taskId !== artifact.taskId ||
          liveCommand.agent !== artifact.agent ||
          liveCommand.generation !== artifact.generation ||
          !sameSecret(liveCommand.artifactToken, artifact.artifactToken))
      ) {
        verificationErrors.push('artifact command changed during verification');
      }
      const stored: StoredArtifact = {
        id: this.idFactory(),
        sequence: state.artifacts.length + 1,
        artifact,
        taskGeneration: currentTask.generation,
        verification: verificationErrors.length === 0 ? 'ACCEPTED' : 'REJECTED',
        verificationErrors,
        receivedAt: now,
      };
      state.artifacts.push(stored);
      if (verificationErrors.length > 0) {
        if (authorizationFailed) {
          addEvent(state, now, 'ARTIFACT_AUTHORIZATION_REJECTED', verificationErrors.join('; '), {
            taskId: currentTask.id,
            agent: artifact.agent,
          });
          return structuredClone(stored);
        }
        // The controller authenticated this terminal result but rejected its
        // semantics/evidence. Settle that exact claimed command so restart cannot
        // replay it as active; forged artifacts never reach this branch.
        if (liveCommand?.status === 'CLAIMED') {
          liveCommand.status = 'CANCELLED';
          liveCommand.completedAt = now;
          const resultAgent = state.agents.find((candidate) => candidate.id === artifact.agent);
          if (resultAgent?.currentTask === currentTask.id) {
            releaseAgent(state, resultAgent.id, now);
          }
        }
        if (verificationErrors.some((error) => error.startsWith('REVIEW_STATE_CONFLICT:'))) {
          currentTask.status = 'BLOCKED';
          currentTask.blocker = verificationErrors
            .filter((error) => error.startsWith('REVIEW_STATE_CONFLICT:'))
            .join('; ');
          for (const entry of state.integrationQueue.filter(
            (candidate) =>
              candidate.taskId === currentTask.id &&
              ['QUEUED', 'INTEGRATING', 'VALIDATING'].includes(candidate.status),
          )) {
            entry.status = 'REMOVED';
            entry.failureCode = 'REVIEW_STATE_CONFLICT';
          }
          addEvent(state, now, 'REVIEW_STATE_CONFLICT', currentTask.blocker, {
            taskId: currentTask.id,
            agent: artifact.agent,
          });
        }
        if (
          artifact.kind === 'REVIEW_RESULT' &&
          verificationErrors.some(
            (error) =>
              error.startsWith('REVIEW_MATERIALIZATION_MISMATCH:') ||
              error.startsWith('CANDIDATE_UNAVAILABLE:'),
          )
        ) {
          currentTask.status = 'REVIEW_RETRYABLE';
          currentTask.blocker = verificationErrors.join('; ');
          currentTask.updatedAt = now;
          addEvent(state, now, 'REVIEW_RETRYABLE', currentTask.blocker, {
            taskId: currentTask.id,
            agent: artifact.agent,
          });
        }
        if (artifact.kind === 'BUILDER_RESULT') {
          currentTask.status = 'CHANGES_REQUIRED';
          currentTask.blocker = verificationErrors.join('; ');
          currentTask.updatedAt = now;
          const owner = agentById(state, currentTask.ownerAgent);
          releaseAgent(state, owner.id, now);
          currentTask.generation += 1;
          this.createCommand(
            state,
            currentTask,
            owner,
            'CORRECTION',
            `CORRECT ${currentTask.id}. Result reconciliation failed:\n${verificationErrors.map((error) => `- ${error}`).join('\n')}\nProduce a new committed SHA and resubmit the complete result artifact.`,
            now,
          );
        }
        addEvent(state, now, 'ARTIFACT_REJECTED', verificationErrors.join('; '), {
          taskId: currentTask.id,
          agent: artifact.agent,
        });
        return structuredClone(stored);
      }

      if (artifact.kind === 'BUILDER_RESULT') {
        completeCommand(state, artifact.commandId, now);
        releaseAgent(state, artifact.agent, now);
        if (artifact.status === 'PASS') {
          for (const priorReview of acceptedReviews(state, currentTask.id)) {
            priorReview.supersededAt = now;
            priorReview.supersededReason = `candidate replaced by ${artifact.resultSha}`;
          }
          for (const entry of state.integrationQueue.filter(
            (candidate) =>
              candidate.taskId === currentTask.id &&
              !['ACCEPTED', 'SUPERSEDED', 'REMOVED'].includes(candidate.status),
          )) {
            entry.status = 'SUPERSEDED';
            entry.reviewSupersessionState = 'SUPERSEDED';
          }
          for (const command of state.commands.filter(
            (candidate) =>
              candidate.taskId === currentTask.id && commandIsActiveIntegration(candidate),
          )) {
            const wasPending = command.status === 'PENDING';
            command.status = 'CANCELLED';
            command.completedAt = now;
            if (wasPending) releaseAgent(state, command.agent, now);
          }
          currentTask.candidateSha = artifact.resultSha;
          if (capturedCandidate === undefined) {
            throw new Error('CAPTURE_INCOMPLETE: builder result lacks durable object capture');
          }
          currentTask.capturedCandidate = capturedCandidate;
          if (reviewMaterialization === undefined) {
            throw new Error('REVIEW_MATERIALIZATION_MISSING: candidate was not materialized');
          }
          currentTask.reviewMaterialization = reviewMaterialization;
          currentTask.status = 'READY_FOR_REVIEW';
          delete currentTask.blocker;
          addEvent(state, now, 'BUILDER_RESULT_ACCEPTED', `${currentTask.id} ready for review`, {
            taskId: currentTask.id,
            agent: artifact.agent,
          });
        } else if (artifact.status === 'BLOCKED') {
          currentTask.status = 'BLOCKED';
          currentTask.blocker = artifact.blockers.join('; ');
          addEvent(state, now, 'TASK_BLOCKED', currentTask.blocker, {
            taskId: currentTask.id,
            agent: artifact.agent,
          });
        } else {
          currentTask.status = 'CHANGES_REQUIRED';
          currentTask.blocker = artifact.blockers.join('; ');
          currentTask.generation += 1;
          const owner = agentById(state, currentTask.ownerAgent);
          this.createCommand(
            state,
            currentTask,
            owner,
            'CORRECTION',
            `CORRECT ${currentTask.id} after failed builder validation:\n${artifact.blockers.map((blocker) => `- ${blocker}`).join('\n')}\nSubmit a new result SHA.`,
            now,
          );
        }
      } else if (artifact.kind === 'REVIEW_RESULT') {
        completeCommand(state, artifact.commandId, now);
        releaseAgent(state, artifact.agent, now);
        if (artifact.status === 'CHANGES_REQUIRED' || artifact.status === 'BLOCKED') {
          if (!currentTask.negativeReviewShas.includes(artifact.reviewedSha)) {
            currentTask.negativeReviewShas.push(artifact.reviewedSha);
          }
          invalidateIntegrationForReview(
            state,
            currentTask,
            now,
            `Review ${stored.id} (${artifact.status}) invalidated candidate ${artifact.reviewedSha}`,
          );
        }
        if (artifact.status === 'PASS') {
          currentTask.status = 'REVIEW_PASS';
          delete currentTask.blocker;
          addEvent(state, now, 'REVIEW_PASSED', `${currentTask.id} passed independent review`, {
            taskId: currentTask.id,
            agent: artifact.agent,
          });
        } else if (artifact.status === 'CHANGES_REQUIRED') {
          currentTask.status = 'CHANGES_REQUIRED';
          currentTask.blocker = artifact.findings.map((finding) => finding.summary).join('; ');
          currentTask.generation += 1;
          const owner = agentById(state, currentTask.ownerAgent);
          const findings = artifact.findings
            .map(
              (finding) =>
                `- [${finding.severity}] ${finding.summary}: ${finding.requiredCorrection}${finding.file === undefined ? '' : ` (${finding.file})`}`,
            )
            .join('\n');
          this.createCommand(
            state,
            currentTask,
            owner,
            'CORRECTION',
            `CORRECT ${currentTask.id} from reviewed SHA ${artifact.reviewedSha}:\n${findings}\nKeep the task contract and produce a new descendant SHA.`,
            now,
          );
          addEvent(
            state,
            now,
            'CORRECTION_ROUTED',
            `${String(artifact.findings.length)} findings routed to ${owner.id}`,
            {
              taskId: currentTask.id,
              agent: owner.id,
            },
          );
        } else {
          currentTask.status = 'BLOCKED';
          currentTask.blocker =
            artifact.findings.map((finding) => finding.summary).join('; ') || 'Reviewer blocked';
          addEvent(state, now, 'REVIEW_BLOCKED', currentTask.blocker, {
            taskId: currentTask.id,
            agent: artifact.agent,
          });
        }
      } else if (artifact.kind === 'INTEGRATION_RESULT') {
        completeCommand(state, artifact.commandId, now);
        releaseAgent(state, artifact.agent, now);
        const entry = state.integrationQueue
          .slice()
          .reverse()
          .find(
            (candidate) =>
              candidate.taskId === currentTask.id &&
              candidate.sourceSha === artifact.sourceSha &&
              candidate.status === 'INTEGRATING',
          );
        if (entry === undefined)
          throw new Error(`integration result without queue entry: ${currentTask.id}`);
        if (artifact.status === 'PASS') {
          entry.resultSha = artifact.resultSha;
          state.integratedSha = artifact.resultSha;
          if (currentTask.validation === undefined || currentTask.validation.checks.length === 0) {
            entry.status = 'ACCEPTED';
            currentTask.status = 'ACCEPTED';
            currentTask.acceptedSha = artifact.resultSha;
            addEvent(
              state,
              now,
              'TASK_ACCEPTED',
              `${currentTask.id} accepted at ${artifact.resultSha}`,
              {
                taskId: currentTask.id,
              },
            );
          } else {
            entry.status = 'VALIDATING';
            currentTask.status = 'VALIDATING';
            const validator = agentById(state, currentTask.validation.agent);
            this.createCommand(
              state,
              currentTask,
              validator,
              'VALIDATE',
              validationPrompt(currentTask, artifact.resultSha),
              now,
            );
            addEvent(
              state,
              now,
              'VALIDATION_QUEUED',
              `${currentTask.id} validating ${artifact.resultSha}`,
              {
                taskId: currentTask.id,
              },
            );
          }
        } else {
          entry.status = 'QUEUED';
          currentTask.status = 'BLOCKED';
          currentTask.blocker = artifact.blockers.join('; ');
          addEvent(state, now, 'INTEGRATION_BLOCKED', currentTask.blocker, {
            taskId: currentTask.id,
            agent: artifact.agent,
          });
        }
      } else {
        completeCommand(state, artifact.commandId, now);
        releaseAgent(state, artifact.agent, now);
        const entry = state.integrationQueue
          .slice()
          .reverse()
          .find(
            (candidate) =>
              candidate.taskId === currentTask.id &&
              candidate.resultSha === artifact.resultSha &&
              candidate.status === 'VALIDATING',
          );
        if (entry === undefined)
          throw new Error(`validation result without queue entry: ${currentTask.id}`);
        if (artifact.status === 'PASS') {
          entry.status = 'ACCEPTED';
          currentTask.status = 'ACCEPTED';
          currentTask.acceptedSha = artifact.resultSha;
          addEvent(
            state,
            now,
            'TASK_ACCEPTED',
            `${currentTask.id} accepted with exact-SHA evidence`,
            {
              taskId: currentTask.id,
              agent: artifact.agent,
            },
          );
        } else {
          currentTask.status = 'CHANGES_REQUIRED';
          currentTask.blocker = artifact.blockers.join('; ');
          currentTask.generation += 1;
          const owner = agentById(state, currentTask.ownerAgent);
          this.createCommand(
            state,
            currentTask,
            owner,
            'CORRECTION',
            `CORRECT ${currentTask.id} after validation failed at ${artifact.resultSha}:\n${artifact.blockers.map((blocker) => `- ${blocker}`).join('\n')}\nProduce a new candidate SHA for independent re-review.`,
            now,
          );
          addEvent(state, now, 'VALIDATION_FAILED', currentTask.blocker, {
            taskId: currentTask.id,
            agent: artifact.agent,
          });
        }
      }
      currentTask.updatedAt = now;
      return structuredClone(stored);
    });
  }

  async ingestInbox(): Promise<{ accepted: string[]; rejected: string[] }> {
    const inbox = path.join(this.runtimeDir, 'inbox');
    const archive = path.join(this.runtimeDir, 'archive');
    const rejectedDirectory = path.join(this.runtimeDir, 'rejected');
    await Promise.all([
      fs.mkdir(inbox, { recursive: true, mode: 0o700 }),
      fs.mkdir(archive, { recursive: true, mode: 0o700 }),
      fs.mkdir(rejectedDirectory, { recursive: true, mode: 0o700 }),
    ]);
    const accepted: string[] = [];
    const rejected: string[] = [];
    const entries = (await fs.readdir(inbox)).filter((entry) => entry.endsWith('.json')).sort();
    for (const entry of entries) {
      const source = path.join(inbox, entry);
      try {
        const artifact = JSON.parse(await fs.readFile(source, 'utf8')) as unknown;
        const stored = await this.submitArtifact(artifact);
        const destination = path.join(
          stored.verification === 'ACCEPTED' ? archive : rejectedDirectory,
          `${stored.id}-${entry}`,
        );
        await fs.rename(source, destination);
        (stored.verification === 'ACCEPTED' ? accepted : rejected).push(entry);
      } catch (error) {
        const destination = path.join(rejectedDirectory, `${this.idFactory()}-${entry}`);
        await fs.rename(source, destination);
        await fs.writeFile(
          `${destination}.error.json`,
          `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`,
          { mode: 0o600 },
        );
        rejected.push(entry);
      }
    }
    return { accepted, rejected };
  }

  async founderBrief(markRead = false): Promise<string> {
    return this.withState((state, now) => {
      const counts = new Map<string, number>();
      for (const task of state.tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
      const agents = new Map<string, number>();
      for (const agent of state.agents)
        agents.set(agent.lifecycle, (agents.get(agent.lifecycle) ?? 0) + 1);
      const blockers = state.tasks.filter((task) => task.status === 'BLOCKED');
      const recent = state.events.filter((event) => event.sequence > state.lastBriefSequence);
      const founderNeeded = blockers.filter((task) =>
        task.blocker?.startsWith('FOUNDER_DECISION:'),
      );
      const critical = state.tasks
        .filter((task) => !['ACCEPTED', 'SUPERSEDED'].includes(task.status))
        .sort((left, right) => left.priority - right.priority)[0];
      const milestones = recent
        .filter((event) =>
          ['REVIEW_PASSED', 'TASK_ACCEPTED', 'INTEGRATION_QUEUED', 'VALIDATION_FAILED'].includes(
            event.type,
          ),
        )
        .map((event) => event.detail);
      const corrections = recent
        .filter((event) => event.type === 'CORRECTION_ROUTED')
        .map((event) => event.detail);
      const risks = blockers.filter(
        (task) => task.blocker?.startsWith('FOUNDER_DECISION:') !== true,
      );
      const lines = [
        state.cycle,
        `${String(state.tasks.filter((task) => task.status === 'ACCEPTED').length)}/${String(state.tasks.length)} tasks accepted`,
        `Agents: ${[...agents.entries()].map(([status, count]) => `${status} ${String(count)}`).join(' · ') || 'none registered'}`,
        `Flow: review ${String(counts.get('READY_FOR_REVIEW') ?? 0)} · correction ${String(counts.get('CHANGES_REQUIRED') ?? 0)} · integration ${String(counts.get('READY_FOR_INTEGRATION') ?? 0)} · validating ${String(counts.get('VALIDATING') ?? 0)} · blocked ${String(blockers.length)}`,
        `Milestones: ${milestones.join('; ') || 'none since prior brief'}`,
        `Corrections issued: ${corrections.join('; ') || 'none since prior brief'}`,
        `Integration: ${state.integratedSha ?? 'not set'} · queued ${String(state.integrationQueue.filter((entry) => entry.status === 'QUEUED').length)}`,
        `Critical path: ${critical === undefined ? 'complete' : `${critical.id} (${critical.status})`}`,
        `Risks: ${risks.length === 0 ? 'NONE' : risks.map((task) => `${task.id}: ${task.blocker ?? 'blocked'}`).join('; ')}`,
        `Deferred: ${String(state.tasks.filter((task) => task.status === 'SUPERSEDED').length)} superseded task(s)`,
        `Needs founder: ${founderNeeded.length === 0 ? 'NONE' : founderNeeded.map((task) => `${task.id}: ${task.blocker ?? 'decision details missing'}`).join('; ')}`,
      ];
      const brief = lines.join('\n');
      if (markRead) {
        state.lastBriefSequence = state.sequence;
        state.updatedAt = now;
      }
      return brief;
    });
  }

  async writeFounderBrief(): Promise<string> {
    const brief = await this.founderBrief(true);
    const temporary = path.join(this.runtimeDir, `.founder-brief-${String(process.pid)}.tmp`);
    await fs.writeFile(temporary, `${brief}\n`, { mode: 0o600 });
    await fs.rename(temporary, path.join(this.runtimeDir, 'founder-brief.txt'));
    return brief;
  }

  async supervise(options: {
    intervalMs: number;
    heartbeatMs: number;
    signal?: AbortSignal;
    onBrief?: (brief: string) => void;
  }): Promise<void> {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 100) {
      throw new Error('supervisor interval must be an integer of at least 100ms');
    }
    if (!Number.isSafeInteger(options.heartbeatMs) || options.heartbeatMs < options.intervalMs) {
      throw new Error('heartbeat must be an integer no shorter than the supervisor interval');
    }
    let lastBrief = 0;
    while (options.signal?.aborted !== true) {
      const inbox = await this.ingestInbox();
      const reconciliation = await this.reconcile();
      const now = Date.now();
      if (
        reconciliation.changed ||
        inbox.accepted.length > 0 ||
        inbox.rejected.length > 0 ||
        now - lastBrief >= options.heartbeatMs
      ) {
        const brief = await this.writeFounderBrief();
        options.onBrief?.(brief);
        lastBrief = now;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, options.intervalMs));
    }
  }
}
