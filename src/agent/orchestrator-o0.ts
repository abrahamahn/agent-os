// src/agent/orchestrator-o0.ts
//
// Security hardening adapter over the core TypeScript orchestrator. Keeping the
// acceptance and handoff checks in a small layer makes that authority boundary
// easier to review without duplicating the command/artifact lifecycle.

import { execFile } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { ValidationEvidenceStore } from '../validation/validation-evidence';

import { controllerRoot } from './controller-runtime';
import { HostValidationRunner } from './host-validation';
import { AgentOrchestrator as BaseAgentOrchestrator, parseAgentArtifact } from './orchestrator';

import type {
  AgentArtifact,
  AgentCommand,
  IntegrationResultArtifact,
  OrchestrationEvent,
  OrchestrationState,
  OrchestratorOptions,
  ReconcileResult,
  StoredArtifact,
  TaskRecord,
} from './orchestrator';

export { parseAgentArtifact, parseTaskContract, reviewTruth } from './orchestrator';

export type * from './orchestrator';

type StateWriter = {
  withState<T>(operation: (state: OrchestrationState, now: string) => Promise<T> | T): Promise<T>;
};

const execFileAsync = promisify(execFile);
const RESULT_AUTHORITY_MARKER = '\n\nRESULT AUTHORITY:';
const TASK_CONTEXT_MARKER = '\n\nCONTROLLER TASK CONTEXT\n';

function activeValidationEntries(state: OrchestrationState) {
  return state.integrationQueue.filter((entry) => entry.status === 'VALIDATING');
}

function latestAcceptedIntegrationSha(state: OrchestrationState): string | undefined {
  return state.integrationQueue
    .slice()
    .reverse()
    .find((entry) => entry.status === 'ACCEPTED' && entry.resultSha !== undefined)?.resultSha;
}

function appendEvent(
  state: OrchestrationState,
  now: string,
  type: string,
  detail: string,
  taskId?: string,
): OrchestrationEvent {
  state.sequence += 1;
  const event: OrchestrationEvent = {
    sequence: state.sequence,
    at: now,
    type,
    detail,
    ...(taskId === undefined ? {} : { taskId }),
  };
  state.events.push(event);
  state.updatedAt = now;
  return event;
}

function normalizedRelativePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '');
}

function pathIsOwned(file: string, task: TaskRecord): boolean {
  const candidate = normalizedRelativePath(file);
  if (
    candidate.length === 0 ||
    candidate.startsWith('/') ||
    candidate === '..' ||
    candidate.startsWith('../') ||
    candidate.split('/').includes('..')
  ) {
    return false;
  }
  return task.ownedPaths.some((ownedPath) => {
    const owned = normalizedRelativePath(ownedPath);
    if (owned === '.' || owned === '') return true;
    return candidate === owned || candidate.startsWith(`${owned}/`);
  });
}

function scopeViolations(task: TaskRecord, files: readonly string[]): string[] {
  return files.filter((file) => !pathIsOwned(file, task));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function taskContext(task: TaskRecord): string {
  return [
    `Task: ${task.id} — ${task.title}`,
    `Generation: ${String(task.generation)}`,
    `Base SHA: ${task.baseSha}`,
    `Current candidate SHA: ${task.candidateSha ?? 'none yet'}`,
    `Dependencies: ${task.dependencies.join(', ') || 'none'}`,
    'Owned scope:',
    ...(task.ownedPaths.length === 0 ? ['- none'] : task.ownedPaths.map((entry) => `- ${entry}`)),
    'Acceptance criteria:',
    ...task.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    'Scope law: do not make or approve changes outside Owned scope. A scope expansion requires controller re-planning, not an implicit fix.',
  ].join('\n');
}

function enrichCommandPrompt(command: AgentCommand, task: TaskRecord): boolean {
  if (command.prompt.includes(TASK_CONTEXT_MARKER)) return false;
  const authorityIndex = command.prompt.indexOf(RESULT_AUTHORITY_MARKER);
  const publicPrompt =
    authorityIndex === -1 ? command.prompt : command.prompt.slice(0, authorityIndex);
  const authoritySuffix = authorityIndex === -1 ? '' : command.prompt.slice(authorityIndex);
  command.prompt = `${publicPrompt}${TASK_CONTEXT_MARKER}${taskContext(task)}${authoritySuffix}`;
  return true;
}

async function bareGit(gitDirectory: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', ['--git-dir', gitDirectory, ...args], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout;
}

async function worktreeGit(
  worktree: string,
  args: readonly string[],
  gitControlDirectory?: string,
): Promise<string> {
  const result = await execFileAsync('git', ['-C', worktree, ...args], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    env:
      gitControlDirectory === undefined
        ? process.env
        : {
            ...process.env,
            GIT_DIR: gitControlDirectory,
            GIT_WORK_TREE: worktree,
          },
  });
  return result.stdout;
}

function nulPaths(output: string): string[] {
  return [...new Set(output.split('\0').filter(Boolean).map(normalizedRelativePath))].sort();
}

async function integrationFidelityErrors(
  task: TaskRecord,
  artifact: IntegrationResultArtifact,
): Promise<string[]> {
  if (artifact.status !== 'PASS') return [];
  const captured = task.capturedCandidate;
  const integration = task.integration;
  if (
    captured === undefined ||
    integration === undefined ||
    task.candidateSha === undefined ||
    task.candidateSha !== artifact.sourceSha
  ) {
    return ['INTEGRATION_FIDELITY_VIOLATION: candidate/integration authority is incomplete'];
  }

  try {
    const sourceFiles = nulPaths(
      await bareGit(captured.storeGitDirectory, [
        'diff',
        '--name-only',
        '-z',
        `${task.baseSha}..${artifact.sourceSha}`,
        '--',
      ]),
    );
    const resultFiles = [...artifact.filesChanged].map(normalizedRelativePath).sort();
    if (!sameStrings(sourceFiles, resultFiles)) {
      return [
        `INTEGRATION_FIDELITY_VIOLATION: reviewed candidate paths (${sourceFiles.join(', ') || 'none'}) differ from integrated delta (${resultFiles.join(', ') || 'none'})`,
      ];
    }

    const errors: string[] = [];
    for (const file of sourceFiles) {
      const sourceEntry = await bareGit(captured.storeGitDirectory, [
        'ls-tree',
        '-z',
        artifact.sourceSha,
        '--',
        file,
      ]);
      const resultEntry = await worktreeGit(
        integration.worktree,
        ['ls-tree', '-z', artifact.resultSha, '--', file],
        integration.gitControlDirectory,
      );
      if (sourceEntry !== resultEntry) {
        errors.push(
          `INTEGRATION_FIDELITY_VIOLATION: integrated content for ${file} differs from reviewed candidate`,
        );
      }
    }
    return errors;
  } catch (error) {
    return [
      `INTEGRATION_FIDELITY_VIOLATION: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
}

function scopedEvidenceLookup(
  options: OrchestratorOptions,
): NonNullable<OrchestratorOptions['evidenceLookup']> {
  const runtimeDir = path.resolve(options.runtimeDir ?? controllerRoot());
  const genericStore = new ValidationEvidenceStore({
    runtimeDir: path.join(runtimeDir, 'validation-evidence'),
  });
  const hostRunner = new HostValidationRunner({
    runtimeDir: path.join(runtimeDir, 'host-validation'),
    allowUnsafeTestRuntime: options.allowUnsafeTestRuntime === true,
  });
  return async (id: string) => {
    const generic = await genericStore.job(id);
    if (generic !== undefined) return generic;
    const host = (await hostRunner.state()).jobs.find((candidate) => candidate.id === id);
    if (host === undefined || (host.status !== 'PASS' && host.status !== 'REUSED'))
      return undefined;
    return {
      state: 'PASS',
      identity: {
        candidateSha: host.candidateSha,
        checkId: host.checkId,
        environmentFingerprint: host.environmentFingerprint,
      },
    };
  };
}

export class AgentOrchestrator extends BaseAgentOrchestrator {
  constructor(options: OrchestratorOptions = {}) {
    super({
      ...options,
      evidenceLookup: options.evidenceLookup ?? scopedEvidenceLookup(options),
    });
  }

  private stateWriter(): StateWriter {
    // `withState` is TypeScript-private in the pushed implementation, but it is
    // the controller's existing lock + atomic-write primitive at runtime. This
    // deliberately reuses it instead of adding a second state writer.
    return this as unknown as StateWriter;
  }

  private async enrichCommandContexts(): Promise<void> {
    await this.stateWriter().withState((state, now) => {
      let changed = false;
      for (const command of state.commands) {
        if (command.status !== 'PENDING' && command.status !== 'CLAIMED') continue;
        const task = state.tasks.find((candidate) => candidate.id === command.taskId);
        if (task === undefined) continue;
        changed = enrichCommandPrompt(command, task) || changed;
      }
      if (changed) {
        state.updatedAt = now;
      }
    });
  }

  /**
   * Return a mutating command to durable pending state only when task execution
   * effects provably could not have begun. Usually no worker process exists; a
   * spawned child also qualifies only when controller registration failed before
   * prompt delivery and the child was terminated/reaped before release.
   * Started/ambiguous mutating workers must use normal PID/Git reconciliation
   * instead; otherwise retry could duplicate side effects. VALIDATE is the narrow
   * exception: deterministic validation is read-only and exact-evidence/idempotency
   * bound, so a claimed validation may be released after an environment block
   * while staged SHA and prior evidence remain intact. That retry emits a distinct
   * durable event.
   */
  async releaseNeverStartedCommand(commandId: string, reason: string): Promise<AgentCommand> {
    return this.stateWriter().withState((state, now) => {
      const command = state.commands.find((candidate) => candidate.id === commandId);
      if (command === undefined) throw new Error(`unknown Agent OS command: ${commandId}`);
      if (command.status === 'PENDING') return structuredClone(command);
      if (command.status !== 'CLAIMED') {
        throw new Error(`COMMAND_RETRY_UNSAFE: ${command.id} is ${command.status}, not CLAIMED`);
      }

      const task = state.tasks.find((candidate) => candidate.id === command.taskId);
      const agent = state.agents.find((candidate) => candidate.id === command.agent);
      if (task === undefined || agent === undefined) {
        throw new Error('COMMAND_RETRY_UNSAFE: command task/agent binding is missing');
      }

      if (command.kind === 'INTEGRATE') {
        const entry = state.integrationQueue
          .slice()
          .reverse()
          .find((candidate) => candidate.taskId === task.id && candidate.status === 'INTEGRATING');
        if (entry === undefined) {
          throw new Error('COMMAND_RETRY_UNSAFE: integration queue binding is missing');
        }
        entry.status = 'QUEUED';
      }

      if (command.kind === 'VALIDATE') {
        const entry = state.integrationQueue
          .slice()
          .reverse()
          .find((candidate) => candidate.taskId === task.id && candidate.status === 'VALIDATING');
        if (entry === undefined) {
          throw new Error('COMMAND_RETRY_UNSAFE: validation queue binding is missing');
        }
      }

      command.status = 'PENDING';
      delete command.claimedAt;
      delete command.completedAt;

      agent.lifecycle = 'DISPATCHED';
      agent.currentTask = task.id;
      delete agent.pid;
      delete agent.processStartTicks;
      agent.updatedAt = now;

      task.status =
        command.kind === 'REVIEW'
          ? 'READY_FOR_REVIEW'
          : command.kind === 'CORRECTION'
            ? 'CHANGES_REQUIRED'
            : command.kind === 'INTEGRATE'
              ? 'READY_FOR_INTEGRATION'
              : command.kind === 'VALIDATE'
                ? 'VALIDATING'
                : 'DISPATCHED';
      task.updatedAt = now;

      const validationRetry = command.kind === 'VALIDATE';
      appendEvent(
        state,
        now,
        validationRetry ? 'VALIDATION_RETRY_RELEASED' : 'COMMAND_RETRY_RELEASED',
        validationRetry
          ? `VALIDATE ${command.id} released for retry without advancing acceptance: ${reason}`
          : `${command.kind} ${command.id} task execution effects did not begin; released for retry: ${reason}`,
        task.id,
      );
      return structuredClone(command);
    });
  }

  private async reconcileAcceptedPredecessor(): Promise<void> {
    await this.stateWriter().withState((state, now) => {
      const validating = activeValidationEntries(state);
      if (validating.length > 1) {
        throw new Error(
          `ACCEPTED_PREDECESSOR_CONFLICT: ${String(validating.length)} validation candidates are active`,
        );
      }

      const validationEntry = validating[0];
      if (validationEntry !== undefined) {
        const task = state.tasks.find((candidate) => candidate.id === validationEntry.taskId);
        if (task === undefined) {
          throw new Error(
            `ACCEPTED_PREDECESSOR_CONFLICT: validation task ${validationEntry.taskId} is missing`,
          );
        }

        if (state.integratedSha !== validationEntry.expectedPredecessorSha) {
          state.integratedSha = validationEntry.expectedPredecessorSha;
          appendEvent(
            state,
            now,
            'STAGED_INTEGRATION_NOT_ACCEPTED',
            `${validationEntry.resultSha ?? '<unknown>'} remains staged; accepted predecessor is ${validationEntry.expectedPredecessorSha}`,
            task.id,
          );
        }

        if (task.status === 'CHANGES_REQUIRED' || task.status === 'BLOCKED') {
          validationEntry.status = 'REMOVED';
          appendEvent(
            state,
            now,
            'STAGED_INTEGRATION_REJECTED',
            `${validationEntry.resultSha ?? '<unknown>'} rejected by validation; fresh descendant review required`,
            task.id,
          );
        }
        return;
      }

      const acceptedSha = latestAcceptedIntegrationSha(state);
      if (acceptedSha !== undefined && state.integratedSha !== acceptedSha) {
        state.integratedSha = acceptedSha;
        appendEvent(
          state,
          now,
          'ACCEPTED_PREDECESSOR_ADVANCED',
          `Accepted predecessor advanced to ${acceptedSha}`,
        );
      }
    });
  }

  private async removeIntegrationFidelityFailure(
    artifact: IntegrationResultArtifact,
    blocker: string,
  ): Promise<void> {
    await this.stateWriter().withState((state, now) => {
      const task = state.tasks.find((candidate) => candidate.id === artifact.taskId);
      if (task === undefined) throw new Error(`Unknown Agent OS task: ${artifact.taskId}`);
      const entry = state.integrationQueue
        .slice()
        .reverse()
        .find(
          (candidate) =>
            candidate.taskId === task.id &&
            candidate.sourceSha === artifact.sourceSha &&
            !['ACCEPTED', 'SUPERSEDED', 'REMOVED'].includes(candidate.status),
        );
      if (entry !== undefined) {
        entry.status = 'REMOVED';
        entry.failureCode = 'REVIEW_STATE_CONFLICT';
      }
      task.status = 'BLOCKED';
      task.blocker = blocker;
      task.updatedAt = now;
      appendEvent(state, now, 'INTEGRATION_FIDELITY_VIOLATION', blocker, task.id);
    });
  }

  override async submitArtifact(input: unknown): Promise<StoredArtifact> {
    let artifact: AgentArtifact = parseAgentArtifact(input);
    let integrationFidelityBlocker: string | undefined;

    if (artifact.kind === 'BUILDER_RESULT' && artifact.status === 'PASS') {
      const before = await this.snapshot();
      const task = before.tasks.find((candidate) => candidate.id === artifact.taskId);
      if (task === undefined) throw new Error(`Unknown Agent OS task: ${artifact.taskId}`);
      const violations = scopeViolations(task, artifact.filesChanged);
      if (violations.length > 0) {
        artifact = {
          ...artifact,
          status: 'FAILED',
          blockers: [...artifact.blockers, `OWNED_SCOPE_VIOLATION: ${violations.join(', ')}`],
        };
      }
    }

    if (artifact.kind === 'INTEGRATION_RESULT' && artifact.status === 'PASS') {
      const before = await this.snapshot();
      const task = before.tasks.find((candidate) => candidate.id === artifact.taskId);
      if (task === undefined) throw new Error(`Unknown Agent OS task: ${artifact.taskId}`);
      const fidelityErrors = await integrationFidelityErrors(task, artifact);
      if (fidelityErrors.length > 0) {
        integrationFidelityBlocker = fidelityErrors.join('; ');
        artifact = {
          ...artifact,
          status: 'FAILED',
          blockers: [...artifact.blockers, ...fidelityErrors],
        };
      }
    }

    const stored = await super.submitArtifact(artifact);
    if (
      stored.verification === 'ACCEPTED' &&
      artifact.kind === 'INTEGRATION_RESULT' &&
      integrationFidelityBlocker !== undefined
    ) {
      await this.removeIntegrationFidelityFailure(artifact, integrationFidelityBlocker);
    }
    if (stored.verification === 'ACCEPTED') {
      if (artifact.kind === 'INTEGRATION_RESULT' || artifact.kind === 'VALIDATION_RESULT') {
        await this.reconcileAcceptedPredecessor();
      }
    }
    return stored;
  }

  override async claimNextCommand(agentId: string): Promise<AgentCommand | undefined> {
    await this.enrichCommandContexts();
    return super.claimNextCommand(agentId);
  }

  override async reconcile(): Promise<ReconcileResult> {
    await this.reconcileAcceptedPredecessor();
    const result = await super.reconcile();
    await this.reconcileAcceptedPredecessor();
    await this.enrichCommandContexts();
    return result;
  }
}
