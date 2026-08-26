#!/usr/bin/env tsx
// src/agent/command-executor.ts
//
// Thin V0 execution bridge. The orchestrator remains the only workflow writer;
// this module claims controller-issued commands, launches the corresponding
// Codex worker, converts the bounded terminal result into a controller artifact,
// and submits it back. No worker writes orchestration state directly.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { AgentOrchestrator } from './orchestrator-o0';

import type {
  AgentCommand,
  AgentRecord,
  BuilderResultArtifact,
  IntegrationResultArtifact,
  ReviewFinding,
  ReviewResultArtifact,
  ReviewSessionEnvironment,
  TaskRecord,
  TestEvidenceClaim,
} from './orchestrator';

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const RESULT_AUTHORITY_MARKER = '\n\nRESULT AUTHORITY:';

interface BuilderTerminalResult {
  status: 'PASS' | 'FAILED' | 'BLOCKED';
  tests: TestEvidenceClaim[];
  blockers: string[];
}

interface ReviewerTerminalResult {
  status: 'PASS' | 'CHANGES_REQUIRED' | 'BLOCKED';
  findings: ReviewFinding[];
  evidenceInspected: string[];
}

interface IntegrationTerminalResult {
  status: 'PASS' | 'FAILED' | 'BLOCKED';
  blockers: string[];
}

class CommandLaunchError extends Error {
  readonly processStarted: boolean;

  constructor(message: string, processStarted: boolean, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CommandLaunchError';
    this.processStarted = processStarted;
  }
}

export interface CommandExecutorOptions {
  orchestrator?: AgentOrchestrator;
  executable?: string;
  timeoutMs?: number;
  runtimeDir?: string;
  maxCommands?: number;
  signal?: AbortSignal;
  onEvent?: (message: string) => void;
}

export interface CommandExecutionResult {
  commandId: string;
  taskId: string;
  agent: string;
  kind: AgentCommand['kind'];
  status: 'IMPORTED' | 'UNSUPPORTED';
  artifactId?: string;
  verification?: 'ACCEPTED' | 'REJECTED';
  exitCode?: number;
  runDirectory?: string;
}

function boundedAppend(current: string, chunk: Buffer | string): string {
  const next = `${current}${chunk.toString()}`;
  if (Buffer.byteLength(next) <= MAX_CAPTURE_BYTES) return next;
  return Buffer.from(next).subarray(-MAX_CAPTURE_BYTES).toString();
}

function builderSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'tests', 'blockers'],
    properties: {
      status: { enum: ['PASS', 'FAILED', 'BLOCKED'] },
      tests: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['checkId', 'status', 'command'],
          properties: {
            checkId: { type: 'string', minLength: 1 },
            status: { enum: ['PASS', 'FAIL', 'ENVIRONMENT_BLOCKED'] },
            command: { type: 'array', items: { type: 'string' } },
            evidenceId: { type: 'string', minLength: 1 },
          },
        },
      },
      blockers: { type: 'array', items: { type: 'string' } },
    },
  };
}

function reviewerSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'findings', 'evidenceInspected'],
    properties: {
      status: { enum: ['PASS', 'CHANGES_REQUIRED', 'BLOCKED'] },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['severity', 'summary', 'requiredCorrection'],
          properties: {
            severity: { enum: ['P0', 'P1', 'P2', 'P3'] },
            summary: { type: 'string', minLength: 1 },
            requiredCorrection: { type: 'string', minLength: 1 },
            file: { type: 'string', minLength: 1 },
          },
        },
      },
      evidenceInspected: { type: 'array', items: { type: 'string' } },
    },
  };
}

function integrationSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'blockers'],
    properties: {
      status: { enum: ['PASS', 'FAILED', 'BLOCKED'] },
      blockers: { type: 'array', items: { type: 'string' } },
    },
  };
}

function commandSchema(command: AgentCommand): Record<string, unknown> {
  if (command.kind === 'BUILD' || command.kind === 'CORRECTION') return builderSchema();
  if (command.kind === 'REVIEW') return reviewerSchema();
  if (command.kind === 'INTEGRATE') return integrationSchema();
  throw new Error(`unsupported zero-copy command kind: ${command.kind}`);
}

function controllerSecretFreePrompt(command: AgentCommand): string {
  const marker = command.prompt.indexOf(RESULT_AUTHORITY_MARKER);
  return marker === -1 ? command.prompt : command.prompt.slice(0, marker);
}

function resultInstruction(command: AgentCommand): string {
  if (command.kind === 'REVIEW') {
    return [
      'Return only the final structured reviewer result required by the output schema.',
      'Do not edit files. PASS only after inspecting the exact controller materialization and task acceptance criteria.',
      'CHANGES_REQUIRED must contain concrete findings and required corrections.',
      'Do not include controller IDs, tokens, SHAs, or worktree binding fields; the controller supplies those.',
    ].join('\n');
  }
  if (command.kind === 'INTEGRATE') {
    return [
      'Return only the final structured integration result required by the output schema.',
      'Use only the controller-specified durable candidate ref/source and exact accepted predecessor.',
      'Do not invent glue or unrelated edits. If the exact reviewed candidate cannot be applied cleanly, return BLOCKED.',
      'Before PASS, leave the configured integration worktree clean with the integrated result committed.',
      'Do not include controller IDs, tokens, SHAs, or worktree binding fields; the controller derives them from trusted state and Git.',
    ].join('\n');
  }
  return [
    'Return only the final structured builder result required by the output schema.',
    'Before reporting PASS, commit the complete owned-scope change in the assigned worktree and run the checks you claim.',
    'FAILED or BLOCKED must include at least one blocker.',
    'Do not include controller IDs, tokens, SHAs, or worktree binding fields; the controller derives those from trusted state and Git.',
  ].join('\n');
}

async function git(
  worktree: string,
  args: readonly string[],
  gitControlDirectory?: string,
): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
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

async function changedFilesBetween(
  worktree: string,
  baseSha: string,
  resultSha: string,
  gitControlDirectory?: string,
): Promise<string[]> {
  const output = await git(
    worktree,
    ['diff', '--name-only', '-z', baseSha, resultSha, '--'],
    gitControlDirectory,
  );
  return [...new Set(output.split('\0').filter(Boolean))].sort();
}

async function builderChangedFiles(task: TaskRecord, resultSha: string): Promise<string[]> {
  return changedFilesBetween(task.worktree, task.baseSha, resultSha, task.gitControlDirectory);
}

function commandAgent(
  state: Awaited<ReturnType<AgentOrchestrator['snapshot']>>,
  command: AgentCommand,
): AgentRecord {
  const agent = state.agents.find((candidate) => candidate.id === command.agent);
  if (agent === undefined) throw new Error(`command agent is not registered: ${command.agent}`);
  return agent;
}

function commandTask(
  state: Awaited<ReturnType<AgentOrchestrator['snapshot']>>,
  command: AgentCommand,
): TaskRecord {
  const task = state.tasks.find((candidate) => candidate.id === command.taskId);
  if (task === undefined) throw new Error(`command task is not registered: ${command.taskId}`);
  return task;
}

async function ensureReviewerEnvironment(
  orchestrator: AgentOrchestrator,
  command: AgentCommand,
): Promise<void> {
  if (command.kind !== 'REVIEW') return;
  const state = await orchestrator.snapshot();
  const task = commandTask(state, command);
  const materialization = task.reviewMaterialization;
  const binding = command.reviewBinding;
  if (materialization === undefined || binding === undefined) {
    throw new Error('review command is missing controller materialization binding');
  }
  const agent = commandAgent(state, command);
  const current = agent.reviewEnvironment;
  if (
    current?.sessionId === command.sessionId &&
    current.generation === command.generation &&
    current.materializationId === materialization.id
  ) {
    return;
  }
  const reviewEnvironment: ReviewSessionEnvironment = {
    sessionId: command.sessionId,
    taskId: task.id,
    generation: command.generation,
    materializationId: materialization.id,
    candidateSha: materialization.candidateSha,
    candidateTreeSha: materialization.candidateTreeSha,
    durableCandidateRef: materialization.durableCandidateRef,
    durableStoreGitDirectory: materialization.durableStoreGitDirectory,
    workspace: materialization.checkout,
    gitControlDirectory: materialization.gitControlDirectory,
  };
  await orchestrator.registerAgent({
    id: agent.id,
    role: agent.role,
    sessionId: command.sessionId,
    reviewEnvironment,
  });
}

function launchContext(
  state: Awaited<ReturnType<AgentOrchestrator['snapshot']>>,
  command: AgentCommand,
): {
  cwd: string;
  sandbox: 'workspace-write' | 'read-only';
  extraArgs: string[];
  env: NodeJS.ProcessEnv;
} {
  const task = commandTask(state, command);
  if (command.kind === 'REVIEW') {
    const materialization = task.reviewMaterialization;
    if (materialization === undefined) throw new Error('review materialization is unavailable');
    return {
      cwd: materialization.checkout,
      sandbox: 'read-only',
      extraArgs: [],
      env: process.env,
    };
  }

  const workspace = command.kind === 'INTEGRATE' ? task.integration?.worktree : task.worktree;
  const gitControlDirectory =
    command.kind === 'INTEGRATE' ? task.integration?.gitControlDirectory : task.gitControlDirectory;
  if (workspace === undefined)
    throw new Error(`${command.kind} command has no configured worktree`);
  const extraArgs = gitControlDirectory === undefined ? [] : ['--add-dir', gitControlDirectory];
  return {
    cwd: workspace,
    sandbox: 'workspace-write',
    extraArgs,
    env:
      gitControlDirectory === undefined
        ? process.env
        : {
            ...process.env,
            GIT_DIR: gitControlDirectory,
            GIT_WORK_TREE: workspace,
          },
  };
}

async function runCodex(
  orchestrator: AgentOrchestrator,
  command: AgentCommand,
  state: Awaited<ReturnType<AgentOrchestrator['snapshot']>>,
  options: Required<Pick<CommandExecutorOptions, 'executable' | 'timeoutMs' | 'runtimeDir'>>,
): Promise<{ exitCode: number; final: unknown; runDirectory: string }> {
  const context = launchContext(state, command);
  const runDirectory = path.join(options.runtimeDir, 'command-runs', command.id);
  await fs.mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const schemaPath = path.join(runDirectory, 'result.schema.json');
  const finalPath = path.join(runDirectory, 'final.json');
  const stdoutPath = path.join(runDirectory, 'events.jsonl');
  const stderrPath = path.join(runDirectory, 'stderr.log');
  await fs.writeFile(schemaPath, `${JSON.stringify(commandSchema(command), null, 2)}\n`, {
    mode: 0o600,
  });

  const prompt = `${controllerSecretFreePrompt(command)}\n\n${resultInstruction(command)}`;
  const args = [
    '--ask-for-approval',
    'never',
    '--sandbox',
    context.sandbox,
    ...context.extraArgs,
    '--cd',
    context.cwd,
    'exec',
    '--json',
    '--output-schema',
    schemaPath,
    '--output-last-message',
    finalPath,
    '--skip-git-repo-check',
    '-',
  ];

  let child;
  try {
    child = spawn(options.executable, args, {
      cwd: context.cwd,
      env: context.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
  } catch (error) {
    throw new CommandLaunchError(`Codex command ${command.id} could not be spawned`, false, {
      cause: error,
    });
  }

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer | string) => {
    stdout = boundedAppend(stdout, chunk);
  });
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderr = boundedAppend(stderr, chunk);
  });

  const completion = new Promise<number>((resolveExit, rejectExit) => {
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, options.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectExit(
        new CommandLaunchError(
          `Codex command ${command.id} failed to start`,
          child.pid !== undefined,
          { cause: error },
        ),
      );
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolveExit(timedOut ? 124 : (code ?? 1));
    });
  });

  if (child.pid === undefined) {
    await completion;
    throw new CommandLaunchError(`Codex command ${command.id} never started`, false);
  }

  const agent = commandAgent(state, command);
  try {
    // Register process identity before delivering the task prompt. If this
    // controller write fails, no model instruction has been sent yet.
    await orchestrator.registerAgent({
      id: agent.id,
      role: agent.role,
      pid: child.pid,
      sessionId: command.sessionId,
    });
  } catch (error) {
    child.kill('SIGTERM');
    await completion.catch(() => undefined);
    throw new CommandLaunchError(
      `Codex command ${command.id} process identity could not be registered`,
      false,
      { cause: error },
    );
  }

  child.stdin.end(prompt);
  const exitCode = await completion;

  await Promise.all([
    fs.writeFile(stdoutPath, stdout, { mode: 0o600 }),
    fs.writeFile(stderrPath, stderr, { mode: 0o600 }),
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `Codex command ${command.id} exited non-zero (${String(exitCode)}); terminal claims are not importable`,
    );
  }

  let final: unknown;
  try {
    final = JSON.parse(await fs.readFile(finalPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Codex command ${command.id} exited without a parseable structured result`, {
      cause: error,
    });
  }
  return { exitCode, final, runDirectory };
}

function parseBuilderTerminal(value: unknown): BuilderTerminalResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('builder terminal result must be an object');
  }
  const item = value as Record<string, unknown>;
  if (!['PASS', 'FAILED', 'BLOCKED'].includes(String(item['status']))) {
    throw new Error('builder terminal status is invalid');
  }
  if (!Array.isArray(item['tests']) || !Array.isArray(item['blockers'])) {
    throw new Error('builder terminal result requires tests and blockers arrays');
  }
  return value as BuilderTerminalResult;
}

function parseReviewerTerminal(value: unknown): ReviewerTerminalResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('reviewer terminal result must be an object');
  }
  const item = value as Record<string, unknown>;
  if (!['PASS', 'CHANGES_REQUIRED', 'BLOCKED'].includes(String(item['status']))) {
    throw new Error('reviewer terminal status is invalid');
  }
  if (!Array.isArray(item['findings']) || !Array.isArray(item['evidenceInspected'])) {
    throw new Error('reviewer terminal result requires findings and evidenceInspected arrays');
  }
  return value as ReviewerTerminalResult;
}

function parseIntegrationTerminal(value: unknown): IntegrationTerminalResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('integration terminal result must be an object');
  }
  const item = value as Record<string, unknown>;
  if (!['PASS', 'FAILED', 'BLOCKED'].includes(String(item['status']))) {
    throw new Error('integration terminal status is invalid');
  }
  if (!Array.isArray(item['blockers'])) {
    throw new Error('integration terminal result requires blockers array');
  }
  return value as IntegrationTerminalResult;
}

async function builderArtifact(
  command: AgentCommand,
  state: Awaited<ReturnType<AgentOrchestrator['snapshot']>>,
  terminal: BuilderTerminalResult,
): Promise<BuilderResultArtifact> {
  const task = commandTask(state, command);
  const resultSha = (
    await git(task.worktree, ['rev-parse', 'HEAD'], task.gitControlDirectory)
  ).toLowerCase();
  const filesChanged = await builderChangedFiles(task, resultSha);
  const blockers = [...terminal.blockers];
  if (terminal.status !== 'PASS' && blockers.length === 0) {
    blockers.push(`Codex returned ${terminal.status} without a blocker explanation`);
  }
  return {
    schemaVersion: 1,
    kind: 'BUILDER_RESULT',
    commandId: command.id,
    generation: command.generation,
    candidateSha: resultSha,
    sessionId: command.sessionId,
    idempotencyKey: `${command.id}:terminal`,
    artifactType: 'BUILDER_RESULT',
    artifactToken: command.artifactToken,
    taskId: task.id,
    agent: command.agent,
    worktree: task.worktree,
    branch: task.branch,
    baseSha: task.baseSha,
    resultSha,
    status: terminal.status,
    filesChanged,
    tests: terminal.tests,
    blockers,
  };
}

function reviewerArtifact(
  command: AgentCommand,
  state: Awaited<ReturnType<AgentOrchestrator['snapshot']>>,
  terminal: ReviewerTerminalResult,
): ReviewResultArtifact {
  const task = commandTask(state, command);
  const materialization = task.reviewMaterialization;
  if (materialization === undefined) throw new Error('review materialization disappeared');
  return {
    schemaVersion: 1,
    kind: 'REVIEW_RESULT',
    commandId: command.id,
    generation: command.generation,
    candidateSha: materialization.candidateSha,
    sessionId: command.sessionId,
    idempotencyKey: `${command.id}:terminal`,
    artifactType: 'REVIEW_RESULT',
    artifactToken: command.artifactToken,
    taskId: task.id,
    agent: command.agent,
    reviewedSha: materialization.candidateSha,
    candidateTreeSha: materialization.candidateTreeSha,
    durableCandidateRef: materialization.durableCandidateRef,
    durableStoreGitDirectory: materialization.durableStoreGitDirectory,
    reviewMaterializationId: materialization.id,
    reviewCheckout: materialization.checkout,
    status: terminal.status,
    findings: terminal.findings,
    evidenceInspected: terminal.evidenceInspected,
  };
}

async function integrationArtifact(
  command: AgentCommand,
  state: Awaited<ReturnType<AgentOrchestrator['snapshot']>>,
  terminal: IntegrationTerminalResult,
): Promise<IntegrationResultArtifact> {
  const task = commandTask(state, command);
  const integration = task.integration;
  if (integration === undefined || task.candidateSha === undefined) {
    throw new Error('integration task is missing source/worktree authority');
  }
  const entry = state.integrationQueue
    .slice()
    .reverse()
    .find(
      (candidate) =>
        candidate.taskId === task.id &&
        candidate.sourceSha === task.candidateSha &&
        candidate.status === 'INTEGRATING',
    );
  if (entry === undefined) throw new Error('integration queue binding disappeared');
  const resultSha = (
    await git(integration.worktree, ['rev-parse', 'HEAD'], integration.gitControlDirectory)
  ).toLowerCase();
  const filesChanged = await changedFilesBetween(
    integration.worktree,
    entry.expectedPredecessorSha,
    resultSha,
    integration.gitControlDirectory,
  );
  const blockers = [...terminal.blockers];
  if (terminal.status !== 'PASS' && blockers.length === 0) {
    blockers.push(`Codex returned ${terminal.status} without an integration blocker explanation`);
  }
  return {
    schemaVersion: 1,
    kind: 'INTEGRATION_RESULT',
    commandId: command.id,
    generation: command.generation,
    candidateSha: task.candidateSha,
    sessionId: command.sessionId,
    idempotencyKey: `${command.id}:terminal`,
    artifactType: 'INTEGRATION_RESULT',
    artifactToken: command.artifactToken,
    taskId: task.id,
    agent: command.agent,
    worktree: integration.worktree,
    branch: integration.branch,
    baseSha: entry.expectedPredecessorSha,
    sourceSha: task.candidateSha,
    resultSha,
    status: terminal.status,
    filesChanged,
    blockers,
  };
}

async function executeClaimed(
  orchestrator: AgentOrchestrator,
  command: AgentCommand,
  options: Required<Pick<CommandExecutorOptions, 'executable' | 'timeoutMs' | 'runtimeDir'>>,
): Promise<CommandExecutionResult> {
  if (!['BUILD', 'CORRECTION', 'REVIEW', 'INTEGRATE'].includes(command.kind)) {
    return {
      commandId: command.id,
      taskId: command.taskId,
      agent: command.agent,
      kind: command.kind,
      status: 'UNSUPPORTED',
    };
  }
  const state = await orchestrator.snapshot();
  const run = await runCodex(orchestrator, command, state, options);
  let artifact: BuilderResultArtifact | ReviewResultArtifact | IntegrationResultArtifact;
  if (command.kind === 'REVIEW') {
    artifact = reviewerArtifact(
      command,
      await orchestrator.snapshot(),
      parseReviewerTerminal(run.final),
    );
  } else if (command.kind === 'INTEGRATE') {
    artifact = await integrationArtifact(
      command,
      await orchestrator.snapshot(),
      parseIntegrationTerminal(run.final),
    );
  } else {
    artifact = await builderArtifact(
      command,
      await orchestrator.snapshot(),
      parseBuilderTerminal(run.final),
    );
  }
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
    exitCode: run.exitCode,
    runDirectory: run.runDirectory,
  };
}

async function nextExecutableCommand(
  orchestrator: AgentOrchestrator,
): Promise<AgentCommand | undefined> {
  await orchestrator.reconcile();
  const state = await orchestrator.snapshot();
  const pending = state.commands.find(
    (command) =>
      command.status === 'PENDING' &&
      ['BUILD', 'CORRECTION', 'REVIEW', 'INTEGRATE'].includes(command.kind),
  );
  if (pending === undefined) return undefined;
  await ensureReviewerEnvironment(orchestrator, pending);
  return orchestrator.claimNextCommand(pending.agent);
}

export async function runCommandExecutor(
  options: CommandExecutorOptions = {},
): Promise<CommandExecutionResult[]> {
  const orchestrator = options.orchestrator ?? new AgentOrchestrator();
  const executable = options.executable ?? process.env['AGENT_OS_CODEX_EXECUTABLE'] ?? 'codex';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runtimeDir = path.resolve(options.runtimeDir ?? orchestrator.runtimeDir);
  const maxCommands = options.maxCommands ?? Number.POSITIVE_INFINITY;
  const results: CommandExecutionResult[] = [];

  while (options.signal?.aborted !== true && results.length < maxCommands) {
    const command = await nextExecutableCommand(orchestrator);
    if (command === undefined) break;
    options.onEvent?.(`${command.kind} ${command.taskId} → ${command.agent}`);
    try {
      results.push(
        await executeClaimed(orchestrator, command, {
          executable,
          timeoutMs,
          runtimeDir,
        }),
      );
    } catch (error) {
      if (error instanceof CommandLaunchError && !error.processStarted) {
        await orchestrator.releaseNeverStartedCommand(command.id, error.message);
      } else {
        // Started/ambiguous workers use the existing PID/Git recovery model.
        // Never blindly release them back to PENDING.
        await orchestrator.reconcile();
      }
      throw error;
    }
  }
  return results;
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const maxCommandsRaw = option(args, '--max-commands');
  const timeoutRaw = option(args, '--timeout-seconds');
  const maxCommands =
    maxCommandsRaw === undefined ? (once ? 1 : Number.POSITIVE_INFINITY) : Number(maxCommandsRaw);
  const timeoutMs = timeoutRaw === undefined ? DEFAULT_TIMEOUT_MS : Number(timeoutRaw) * 1_000;
  if (!(
    maxCommands === Number.POSITIVE_INFINITY ||
    (Number.isSafeInteger(maxCommands) && maxCommands > 0)
  )) {
    throw new Error('--max-commands must be a positive integer');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
    throw new Error('--timeout-seconds must be at least 1');
  }
  const results = await runCommandExecutor({
    maxCommands,
    timeoutMs,
    onEvent: (message) => process.stdout.write(`${message}\n`),
  });
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

if (process.argv[1]?.endsWith('command-executor.ts') === true) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `agent-command-executor: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
