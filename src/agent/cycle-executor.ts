#!/usr/bin/env tsx
// src/agent/cycle-executor.ts
//
// End-to-end Agent OS execution loop. The bounded command executor owns all model
// worker commands (BUILD/REVIEW/CORRECTION/INTEGRATE). This file adds only the
// deterministic VALIDATE consumer and keeps cycling until no executable command
// remains, removing founder next-command/clipboard relay across the full path.

import { execFile } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import {
  buildEvidenceIdentity,
  fingerprintDependencyFiles,
  ValidationEvidenceStore,
} from '../validation/validation-evidence';

import { runCommandExecutor } from './command-executor';
import { AgentOrchestrator } from './orchestrator-o0';
import { dependencyEnvironmentKey, ResourceScheduler } from './resource-scheduler';

import type {
  AgentCommand,
  TaskRecord,
  ValidationRequirement,
  ValidationResultArtifact,
} from './orchestrator';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

export interface ValidationCheckExecution {
  state: 'PASS' | 'FAIL' | 'ENVIRONMENT_BLOCKED';
  evidenceId: string;
  summary?: string | undefined;
}

export interface ValidationCheckInput {
  task: TaskRecord;
  command: AgentCommand;
  requirement: ValidationRequirement;
  candidateSha: string;
  worktree: string;
  gitControlDirectory?: string;
  timeoutMs: number;
}

export interface CycleExecutorOptions {
  orchestrator?: AgentOrchestrator;
  executable?: string;
  timeoutMs?: number;
  maxCommands?: number;
  runtimeDir?: string;
  signal?: AbortSignal;
  resourceScheduler?: ResourceScheduler;
  evidenceStore?: ValidationEvidenceStore;
  validationCheckRunner?: (input: ValidationCheckInput) => Promise<ValidationCheckExecution>;
  onEvent?: (message: string) => void;
}

export interface CycleExecutionResult {
  commandId: string;
  taskId: string;
  agent: string;
  kind: AgentCommand['kind'];
  status: 'IMPORTED' | 'RETRYABLE';
  artifactId?: string;
  verification?: 'ACCEPTED' | 'REJECTED';
  exitCode?: number;
  runDirectory?: string;
  reason?: string;
}

async function git(
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
  return result.stdout.trim();
}

function taskFor(
  state: Awaited<ReturnType<AgentOrchestrator['snapshot']>>,
  command: AgentCommand,
): TaskRecord {
  const task = state.tasks.find((candidate) => candidate.id === command.taskId);
  if (task === undefined) throw new Error(`command task is not registered: ${command.taskId}`);
  return task;
}

async function defaultValidationCheck(
  input: ValidationCheckInput,
  evidenceStore: ValidationEvidenceStore,
  scheduler: ResourceScheduler,
): Promise<ValidationCheckExecution> {
  // ResourceScheduler currently verifies Git through the normal worktree .git
  // path. Split Git-control workspaces must stay on the existing host-validation
  // adapter until the scheduler itself carries that authority explicitly.
  if (input.gitControlDirectory !== undefined) {
    return {
      state: 'ENVIRONMENT_BLOCKED',
      evidenceId: `unavailable:${input.requirement.checkId}`,
      summary:
        'GENERIC_VALIDATION_UNSUPPORTED_GIT_CONTROL: use the host-validation adapter for split Git-control workspaces',
    };
  }

  const identity = buildEvidenceIdentity({
    candidateSha: input.candidateSha,
    checkId: input.requirement.checkId,
    command: input.requirement.command,
    dependencyFingerprint: fingerprintDependencyFiles(input.worktree),
    ...(input.requirement.environmentFingerprint === undefined
      ? {}
      : { environmentFingerprint: input.requirement.environmentFingerprint }),
  });
  const requested = await evidenceStore.request(identity, input.command.agent);

  if (requested.action === 'REUSE') {
    return {
      state: 'PASS',
      evidenceId: requested.job.id,
      summary: 'exact evidence reused',
    };
  }
  if (requested.action === 'WAIT') {
    const settled = await evidenceStore.wait(requested.job.id, input.timeoutMs, 100);
    if (settled.state === 'PASS') return { state: 'PASS', evidenceId: settled.id };
    if (settled.state === 'FAIL') {
      return {
        state: 'FAIL',
        evidenceId: settled.id,
        ...(settled.summary === undefined ? {} : { summary: settled.summary }),
      };
    }
    return {
      state: 'ENVIRONMENT_BLOCKED',
      evidenceId: settled.id,
      summary:
        settled.state === 'ENVIRONMENT_BLOCKED'
          ? (settled.summary ?? 'validation environment blocked')
          : `validation evidence remained ${settled.state} until timeout`,
    };
  }

  await evidenceStore.start(requested.job.id, input.command.agent, process.pid);
  try {
    const run = await scheduler.run({
      agent: input.command.agent,
      resource: input.requirement.resource,
      command: [...input.requirement.command],
      worktree: input.worktree,
      candidateSha: input.candidateSha,
      environmentKey: dependencyEnvironmentKey(input.worktree),
      reuseEligible: true,
    });
    if (run.exitCode === 0) {
      if (run.job.status === 'REUSED') {
        await evidenceStore.complete(requested.job.id, {
          state: 'PASS',
          summary: `resource result reused from ${run.job.reusedFrom ?? 'unknown'}`,
        });
      } else {
        await evidenceStore.complete(requested.job.id, { state: 'PASS' });
      }
      return { state: 'PASS', evidenceId: requested.job.id };
    }

    const summary = `validation command exited ${String(run.exitCode)}`;
    await evidenceStore.complete(requested.job.id, { state: 'FAIL', summary });
    return { state: 'FAIL', evidenceId: requested.job.id, summary };
  } catch (error) {
    const summary = error instanceof Error ? error.message : String(error);
    await evidenceStore.complete(requested.job.id, {
      state: 'ENVIRONMENT_BLOCKED',
      summary,
    });
    return {
      state: 'ENVIRONMENT_BLOCKED',
      evidenceId: requested.job.id,
      summary,
    };
  }
}

async function executeValidation(
  orchestrator: AgentOrchestrator,
  command: AgentCommand,
  timeoutMs: number,
  evidenceStore: ValidationEvidenceStore,
  scheduler: ResourceScheduler,
  runner?: (input: ValidationCheckInput) => Promise<ValidationCheckExecution>,
): Promise<CycleExecutionResult> {
  const state = await orchestrator.snapshot();
  const task = taskFor(state, command);
  const validation = task.validation;
  const integration = task.integration;
  const entry = state.integrationQueue
    .slice()
    .reverse()
    .find((candidate) => candidate.taskId === task.id && candidate.status === 'VALIDATING');

  if (validation === undefined || integration === undefined || entry?.resultSha === undefined) {
    await orchestrator.releaseNeverStartedCommand(
      command.id,
      'validation command lost its task/integration binding before checks started',
    );
    throw new Error('validation command lost its task/integration binding');
  }

  const candidateSha = entry.resultSha;
  const head = (
    await git(integration.worktree, ['rev-parse', 'HEAD'], integration.gitControlDirectory)
  ).toLowerCase();
  const dirty = await git(
    integration.worktree,
    ['status', '--porcelain'],
    integration.gitControlDirectory,
  );
  if (head !== candidateSha || dirty.length > 0) {
    await orchestrator.releaseNeverStartedCommand(
      command.id,
      'validation worktree was not clean at the staged exact SHA before checks started',
    );
    throw new Error('validation worktree is not clean at the exact staged integration SHA');
  }

  const agent = state.agents.find((candidate) => candidate.id === command.agent);
  if (agent === undefined) {
    await orchestrator.releaseNeverStartedCommand(
      command.id,
      'validator registration disappeared before checks started',
    );
    throw new Error(`validator is not registered: ${command.agent}`);
  }
  try {
    await orchestrator.registerAgent({
      id: agent.id,
      role: agent.role,
      pid: process.pid,
      sessionId: command.sessionId,
    });
  } catch (error) {
    await orchestrator.releaseNeverStartedCommand(
      command.id,
      'validator process identity could not be registered before checks started',
    );
    throw error;
  }

  const evidenceIds: string[] = [];
  const blockers: string[] = [];
  let status: ValidationResultArtifact['status'] = 'PASS';

  for (const requirement of validation.checks) {
    const input: ValidationCheckInput = {
      task,
      command,
      requirement,
      candidateSha,
      worktree: integration.worktree,
      ...(integration.gitControlDirectory === undefined
        ? {}
        : { gitControlDirectory: integration.gitControlDirectory }),
      timeoutMs,
    };
    let result: ValidationCheckExecution;
    try {
      result =
        runner === undefined
          ? await defaultValidationCheck(input, evidenceStore, scheduler)
          : await runner(input);
    } catch (error) {
      result = {
        state: 'ENVIRONMENT_BLOCKED',
        evidenceId: `unavailable:${requirement.checkId}`,
        summary: error instanceof Error ? error.message : String(error),
      };
    }

    if (!result.evidenceId.startsWith('unavailable:')) evidenceIds.push(result.evidenceId);
    if (result.state === 'FAIL') {
      status = 'FAILED';
      blockers.push(`${requirement.checkId}: ${result.summary ?? 'validation failed'}`);
      break;
    }
    if (result.state === 'ENVIRONMENT_BLOCKED') {
      status = 'BLOCKED';
      blockers.push(
        `${requirement.checkId}: ${result.summary ?? 'validation environment blocked'}`,
      );
      break;
    }
  }

  if (status === 'BLOCKED') {
    const reason = `VALIDATION_ENVIRONMENT_BLOCKED: ${blockers.join('; ')}`;
    // Validation checks are read-only and their evidence records are idempotent.
    // Do not convert an environment outage into builder correction. Keep the
    // staged SHA/review/integration truth intact and make the same validation
    // command retryable on the next execute-cycle invocation.
    await orchestrator.releaseNeverStartedCommand(command.id, reason);
    return {
      commandId: command.id,
      taskId: command.taskId,
      agent: command.agent,
      kind: command.kind,
      status: 'RETRYABLE',
      reason,
    };
  }

  const artifact: ValidationResultArtifact = {
    schemaVersion: 1,
    kind: 'VALIDATION_RESULT',
    commandId: command.id,
    generation: command.generation,
    candidateSha,
    sessionId: command.sessionId,
    idempotencyKey: `${command.id}:terminal`,
    artifactType: 'VALIDATION_RESULT',
    artifactToken: command.artifactToken,
    taskId: task.id,
    agent: command.agent,
    resultSha: candidateSha,
    status,
    evidenceIds,
    blockers,
  };
  const stored = await orchestrator.submitArtifact(artifact);
  await orchestrator.reconcile();
  return {
    commandId: command.id,
    taskId: command.taskId,
    agent: command.agent,
    kind: command.kind,
    status: 'IMPORTED',
    artifactId: stored.id,
    verification: stored.verification,
  };
}

async function claimPendingValidation(
  orchestrator: AgentOrchestrator,
): Promise<AgentCommand | undefined> {
  await orchestrator.reconcile();
  const state = await orchestrator.snapshot();
  const pending = state.commands.find(
    (command) => command.status === 'PENDING' && command.kind === 'VALIDATE',
  );
  if (pending === undefined) return undefined;
  return orchestrator.claimNextCommand(pending.agent);
}

export async function runCycleExecutor(
  options: CycleExecutorOptions = {},
): Promise<CycleExecutionResult[]> {
  const orchestrator = options.orchestrator ?? new AgentOrchestrator();
  const executable = options.executable ?? process.env['AGENT_OS_CODEX_EXECUTABLE'] ?? 'codex';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runtimeDir = path.resolve(options.runtimeDir ?? orchestrator.runtimeDir);
  const maxCommands = options.maxCommands ?? Number.POSITIVE_INFINITY;
  if (!(
    maxCommands === Number.POSITIVE_INFINITY ||
    (Number.isSafeInteger(maxCommands) && maxCommands > 0)
  )) {
    throw new Error('maxCommands must be a positive integer');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
    throw new Error('timeoutMs must be at least 1000');
  }

  // Use the shared scheduler by default. A private scheduler would defeat the
  // global medium/heavy slots and duplicate-suppression guarantees.
  const scheduler = options.resourceScheduler ?? new ResourceScheduler();
  const evidenceStore =
    options.evidenceStore ??
    new ValidationEvidenceStore({
      runtimeDir: path.join(runtimeDir, 'validation-evidence'),
    });
  const results: CycleExecutionResult[] = [];

  while (options.signal?.aborted !== true && results.length < maxCommands) {
    const mechanical = await runCommandExecutor({
      orchestrator,
      executable,
      timeoutMs,
      runtimeDir,
      maxCommands: 1,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    });
    const modelResult = mechanical[0];
    if (modelResult !== undefined) {
      if (
        modelResult.status !== 'IMPORTED' ||
        modelResult.artifactId === undefined ||
        modelResult.verification === undefined
      ) {
        throw new Error('model command executor returned a non-imported command');
      }
      results.push({
        commandId: modelResult.commandId,
        taskId: modelResult.taskId,
        agent: modelResult.agent,
        kind: modelResult.kind,
        status: 'IMPORTED',
        artifactId: modelResult.artifactId,
        verification: modelResult.verification,
        ...(modelResult.exitCode === undefined ? {} : { exitCode: modelResult.exitCode }),
        ...(modelResult.runDirectory === undefined
          ? {}
          : { runDirectory: modelResult.runDirectory }),
      });
      continue;
    }

    const command = await claimPendingValidation(orchestrator);
    if (command === undefined) break;
    options.onEvent?.(`${command.kind} ${command.taskId} → ${command.agent}`);
    const validationResult = await executeValidation(
      orchestrator,
      command,
      timeoutMs,
      evidenceStore,
      scheduler,
      options.validationCheckRunner,
    );
    results.push(validationResult);
    if (validationResult.status === 'RETRYABLE') break;
  }
  return results;
}
