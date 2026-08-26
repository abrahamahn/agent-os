// src/agent/orchestrator.validation-fence.test.ts
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { AgentOrchestrator } from './orchestrator-o0';

import type {
  AgentArtifact,
  AgentCommand,
  BuilderResultArtifact,
  IntegrationResultArtifact,
  ReviewResultArtifact,
  ReviewSessionEnvironment,
  TaskContract,
  ValidationResultArtifact,
} from './orchestrator';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

interface Fixture {
  root: string;
  worktree: string;
  integrationWorktree: string;
  integrationBranch: string;
  runtimeDir: string;
  baseSha: string;
  orchestrator: AgentOrchestrator;
  task: TaskContract;
}

async function git(worktree: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', [...args], {
    cwd: worktree,
    encoding: 'utf8',
  });
  return result.stdout.trim();
}

async function fixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-os-validation-fence-test-'));
  temporaryDirectories.push(root);
  const worktree = path.join(root, 'builder');
  const integrationWorktree = path.join(root, 'integrator');
  const integrationBranch = 'integration/current';
  const runtimeDir = path.join(root, 'controller');

  await fs.mkdir(worktree);
  await git(worktree, ['init', '--quiet']);
  await git(worktree, ['config', 'user.name', 'Agent OS Fixture']);
  await git(worktree, ['config', 'user.email', 'fixture@invalid.example']);
  await fs.writeFile(path.join(worktree, 'base.md'), 'base\n');
  await git(worktree, ['add', 'base.md']);
  await git(worktree, ['commit', '--quiet', '-m', 'base']);
  const baseSha = await git(worktree, ['rev-parse', 'HEAD']);

  await git(root, ['clone', '--quiet', worktree, integrationWorktree]);
  await git(integrationWorktree, ['config', 'user.name', 'Integrator Fixture']);
  await git(integrationWorktree, ['config', 'user.email', 'integrator@invalid.example']);
  await git(integrationWorktree, ['switch', '-c', integrationBranch]);
  await git(worktree, ['switch', '-c', 'agent/validation-fence']);

  let identifier = 0;
  const orchestrator = new AgentOrchestrator({
    runtimeDir,
    allowUnsafeTestRuntime: true,
    idFactory: () => `controller-${String(++identifier)}`,
    now: (() => {
      let tick = 0;
      return () => new Date(Date.UTC(2026, 7, 18, 12, 0, tick++));
    })(),
  });

  const task: TaskContract = {
    id: 'validation-fence',
    cycle: 'CYCLE_TEST',
    title: 'Fence validation-failed integration results',
    priority: 1,
    ownerAgent: 'builder-1',
    reviewerAgent: 'reviewer-1',
    worktree,
    branch: 'agent/validation-fence',
    baseSha,
    dependencies: [],
    ownedPaths: ['candidate.md'],
    acceptanceCriteria: ['validation failure cannot advance accepted predecessor'],
    integration: {
      agent: 'integrator-1',
      worktree: integrationWorktree,
      branch: integrationBranch,
    },
    validation: {
      agent: 'validator-1',
      checks: [
        {
          checkId: 'focused',
          resource: 'medium',
          command: ['node', 'focused-test.js'],
        },
      ],
    },
  };

  await orchestrator.initialize('CYCLE_TEST', baseSha);
  await orchestrator.registerTask(task);
  return {
    root,
    worktree,
    integrationWorktree,
    integrationBranch,
    runtimeDir,
    baseSha,
    orchestrator,
    task,
  };
}

function binding(
  command: AgentCommand,
  candidateSha: string,
  artifactType: AgentArtifact['kind'],
  suffix = '1',
): Pick<
  AgentArtifact,
  | 'commandId'
  | 'generation'
  | 'candidateSha'
  | 'sessionId'
  | 'idempotencyKey'
  | 'artifactType'
  | 'artifactToken'
> {
  return {
    commandId: command.id,
    generation: command.generation,
    candidateSha,
    sessionId: command.sessionId,
    idempotencyKey: `${command.id}:${suffix}`,
    artifactType,
    artifactToken: command.artifactToken,
  };
}

async function commandFor(current: Fixture, agent: string): Promise<AgentCommand> {
  const existing = (await current.orchestrator.snapshot()).commands.find(
    (command) => command.agent === agent && command.status === 'CLAIMED',
  );
  if (existing !== undefined) return existing;

  await current.orchestrator.reconcile();
  if (agent === current.task.reviewerAgent) {
    const state = await current.orchestrator.snapshot();
    const pending = state.commands.find(
      (command) =>
        command.agent === agent && command.kind === 'REVIEW' && command.status === 'PENDING',
    );
    const registeredTask = state.tasks.find((task) => task.id === current.task.id);
    const materialization = registeredTask?.reviewMaterialization;
    if (pending !== undefined && materialization !== undefined) {
      const reviewEnvironment: ReviewSessionEnvironment = {
        sessionId: pending.sessionId,
        taskId: current.task.id,
        generation: pending.generation,
        materializationId: materialization.id,
        candidateSha: materialization.candidateSha,
        candidateTreeSha: materialization.candidateTreeSha,
        durableCandidateRef: materialization.durableCandidateRef,
        durableStoreGitDirectory: materialization.durableStoreGitDirectory,
        workspace: materialization.checkout,
        gitControlDirectory: materialization.gitControlDirectory,
      };
      await current.orchestrator.registerAgent({
        id: agent,
        role: 'Reviewer',
        sessionId: pending.sessionId,
        reviewEnvironment,
      });
    }
  }

  const claimed = await current.orchestrator.claimNextCommand(agent);
  if (claimed === undefined) throw new Error(`no command for ${agent}`);
  return claimed;
}

async function commitCandidate(current: Fixture): Promise<string> {
  await fs.writeFile(path.join(current.worktree, 'candidate.md'), 'candidate\n');
  await git(current.worktree, ['add', 'candidate.md']);
  await git(current.worktree, ['commit', '--quiet', '-m', 'candidate']);
  return git(current.worktree, ['rev-parse', 'HEAD']);
}

async function submitBuilder(current: Fixture, resultSha: string): Promise<void> {
  const command = await commandFor(current, current.task.ownerAgent);
  const artifact: BuilderResultArtifact = {
    schemaVersion: 1,
    kind: 'BUILDER_RESULT',
    ...binding(command, resultSha, 'BUILDER_RESULT'),
    taskId: current.task.id,
    agent: current.task.ownerAgent,
    worktree: current.worktree,
    branch: current.task.branch,
    baseSha: current.baseSha,
    resultSha,
    status: 'PASS',
    filesChanged: ['candidate.md'],
    tests: [],
    blockers: [],
  };
  await current.orchestrator.submitArtifact(artifact);
}

async function submitReviewPass(current: Fixture, candidateSha: string): Promise<void> {
  const command = await commandFor(current, current.task.reviewerAgent);
  const task = (await current.orchestrator.snapshot()).tasks.find(
    (entry) => entry.id === current.task.id,
  );
  const materialization = task?.reviewMaterialization;
  if (materialization === undefined) throw new Error('review materialization missing');
  const artifact: ReviewResultArtifact = {
    schemaVersion: 1,
    kind: 'REVIEW_RESULT',
    ...binding(command, candidateSha, 'REVIEW_RESULT'),
    taskId: current.task.id,
    agent: current.task.reviewerAgent,
    reviewedSha: candidateSha,
    candidateTreeSha: materialization.candidateTreeSha,
    durableCandidateRef: materialization.durableCandidateRef,
    durableStoreGitDirectory: materialization.durableStoreGitDirectory,
    reviewMaterializationId: materialization.id,
    reviewCheckout: materialization.checkout,
    status: 'PASS',
    findings: [],
    evidenceInspected: ['durable candidate'],
  };
  await current.orchestrator.submitArtifact(artifact);
}

async function submitIntegrationPass(current: Fixture, sourceSha: string): Promise<string> {
  const command = await commandFor(current, 'integrator-1');
  const task = (await current.orchestrator.snapshot()).tasks.find(
    (entry) => entry.id === current.task.id,
  );
  const captured = task?.capturedCandidate;
  if (captured === undefined) throw new Error('captured candidate missing');
  await git(current.integrationWorktree, [
    'fetch',
    '--quiet',
    captured.storeGitDirectory,
    captured.ref,
  ]);
  await git(current.integrationWorktree, [
    'cherry-pick',
    '--quiet',
    `${current.baseSha}..${sourceSha}`,
  ]);
  const resultSha = await git(current.integrationWorktree, ['rev-parse', 'HEAD']);
  const artifact: IntegrationResultArtifact = {
    schemaVersion: 1,
    kind: 'INTEGRATION_RESULT',
    ...binding(command, sourceSha, 'INTEGRATION_RESULT'),
    taskId: current.task.id,
    agent: 'integrator-1',
    worktree: current.integrationWorktree,
    branch: current.integrationBranch,
    baseSha: current.baseSha,
    sourceSha,
    resultSha,
    status: 'PASS',
    filesChanged: ['candidate.md'],
    blockers: [],
  };
  await current.orchestrator.submitArtifact(artifact);
  return resultSha;
}

async function submitValidationFailure(current: Fixture, integratedSha: string): Promise<void> {
  const command = await commandFor(current, 'validator-1');
  const artifact: ValidationResultArtifact = {
    schemaVersion: 1,
    kind: 'VALIDATION_RESULT',
    ...binding(command, integratedSha, 'VALIDATION_RESULT'),
    taskId: current.task.id,
    agent: 'validator-1',
    resultSha: integratedSha,
    status: 'FAILED',
    evidenceIds: [],
    blockers: ['focused validation failed'],
  };
  await current.orchestrator.submitArtifact(artifact);
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('accepted predecessor validation fence', () => {
  it('does not reopen a validation-failed staged integration result during reconcile or restart', async () => {
    const current = await fixture();
    const candidateSha = await commitCandidate(current);
    await submitBuilder(current, candidateSha);
    await submitReviewPass(current, candidateSha);
    const integratedSha = await submitIntegrationPass(current, candidateSha);

    const validating = await current.orchestrator.snapshot();
    expect(validating.tasks[0]).toMatchObject({ status: 'VALIDATING' });
    expect(validating.integratedSha).toBe(current.baseSha);

    await submitValidationFailure(current, integratedSha);
    expect((await current.orchestrator.snapshot()).tasks[0]).toMatchObject({
      status: 'CHANGES_REQUIRED',
    });

    await current.orchestrator.reconcile();
    const afterReconcile = await current.orchestrator.snapshot();
    expect(afterReconcile.tasks[0]).toMatchObject({
      status: 'CHANGES_REQUIRED',
    });
    expect(
      afterReconcile.integrationQueue.filter((entry) =>
        ['QUEUED', 'INTEGRATING', 'VALIDATING'].includes(entry.status),
      ),
    ).toHaveLength(0);
    expect(afterReconcile.integratedSha).toBe(current.baseSha);

    const restarted = new AgentOrchestrator({
      runtimeDir: current.runtimeDir,
      allowUnsafeTestRuntime: true,
    });
    await restarted.reconcile();
    const afterRestart = await restarted.snapshot();
    expect(afterRestart.tasks[0]).toMatchObject({ status: 'CHANGES_REQUIRED' });
    expect(afterRestart.integratedSha).toBe(current.baseSha);
    expect(
      afterRestart.commands.filter(
        (command) =>
          command.kind === 'INTEGRATE' &&
          (command.status === 'PENDING' || command.status === 'CLAIMED'),
      ),
    ).toHaveLength(0);
  });
});
