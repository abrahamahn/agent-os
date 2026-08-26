// src/agent/orchestrator.test.ts
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { AgentOrchestrator, reviewTruth } from './orchestrator';

import type {
  AgentArtifact,
  AgentCommand,
  BuilderResultArtifact,
  IntegrationResultArtifact,
  ReviewResultArtifact,
  ReviewSessionEnvironment,
  TaskContract,
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

async function fixture(taskId = 'task-1'): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-os-orchestrator-test-'));
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
  await git(worktree, ['switch', '-c', 'agent/task-1']);
  let identifier = 0;
  const orchestrator = new AgentOrchestrator({
    runtimeDir,
    allowUnsafeTestRuntime: true,
    idFactory: () => `controller-${String(++identifier)}`,
    now: (() => {
      let tick = 0;
      return () => new Date(Date.UTC(2026, 7, 15, 0, 0, tick++));
    })(),
  });
  const task: TaskContract = {
    id: taskId,
    cycle: 'CYCLE_TEST',
    title: 'Prove autonomous routing',
    priority: 1,
    ownerAgent: 'builder-1',
    reviewerAgent: 'reviewer-1',
    worktree,
    branch: 'agent/task-1',
    baseSha,
    dependencies: [],
    ownedPaths: ['candidate.md'],
    acceptanceCriteria: ['candidate is committed and independently reviewed'],
    integration: {
      agent: 'integrator-1',
      worktree: integrationWorktree,
      branch: integrationBranch,
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

async function commitCandidate(current: Fixture, content: string): Promise<string> {
  await fs.writeFile(path.join(current.worktree, 'candidate.md'), content);
  await git(current.worktree, ['add', 'candidate.md']);
  await git(current.worktree, ['commit', '--quiet', '-m', `candidate ${content.trim()}`]);
  return git(current.worktree, ['rev-parse', 'HEAD']);
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
    const existingEnvironment = state.agents.find((entry) => entry.id === agent)?.reviewEnvironment;
    if (
      pending !== undefined &&
      materialization !== undefined &&
      (existingEnvironment === undefined ||
        existingEnvironment.generation !== pending.generation ||
        existingEnvironment.materializationId !== materialization.id)
    ) {
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

async function builderResult(current: Fixture, resultSha: string): Promise<BuilderResultArtifact> {
  const command = await commandFor(current, current.task.ownerAgent);
  return {
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
}

async function reviewResult(
  current: Fixture,
  reviewedSha: string,
  status: ReviewResultArtifact['status'],
  suffix = '1',
): Promise<ReviewResultArtifact> {
  const command = await commandFor(current, current.task.reviewerAgent);
  const state = await current.orchestrator.snapshot();
  const registeredTask = state.tasks.find((task) => task.id === current.task.id);
  const materialization = registeredTask?.reviewMaterialization;
  return {
    schemaVersion: 1,
    kind: 'REVIEW_RESULT',
    ...binding(command, reviewedSha, 'REVIEW_RESULT', suffix),
    taskId: current.task.id,
    agent: current.task.reviewerAgent,
    reviewedSha,
    candidateTreeSha: materialization?.candidateTreeSha ?? '0'.repeat(40),
    durableCandidateRef: materialization?.durableCandidateRef ?? 'missing',
    durableStoreGitDirectory:
      materialization?.durableStoreGitDirectory ?? path.join(current.root, 'missing-store'),
    reviewMaterializationId: materialization?.id ?? 'missing',
    reviewCheckout: materialization?.checkout ?? path.join(current.root, 'missing-review'),
    status,
    findings:
      status === 'CHANGES_REQUIRED'
        ? [
            {
              severity: 'P1',
              summary: 'candidate needs correction',
              requiredCorrection: 'update candidate.md',
              file: 'candidate.md',
            },
          ]
        : [],
    evidenceInspected: ['durable candidate', 'focused test'],
  };
}

async function integrationResult(
  current: Fixture,
  sourceSha: string,
): Promise<IntegrationResultArtifact> {
  const command = await commandFor(current, 'integrator-1');
  const state = await current.orchestrator.snapshot();
  const captured = state.tasks[0]?.capturedCandidate;
  if (captured === undefined) throw new Error('candidate was not captured');
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
  return {
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
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('corrected Agent OS authority and recovery model', () => {
  it('captures before review, routes correction, and integrates only the new reviewed SHA', async () => {
    const current = await fixture();
    const firstSha = await commitCandidate(current, 'first\n');
    await expect(
      current.orchestrator.submitArtifact(await builderResult(current, firstSha)),
    ).resolves.toMatchObject({ verification: 'ACCEPTED' });
    const firstCapture = (await current.orchestrator.snapshot()).tasks[0]?.capturedCandidate;
    expect(firstCapture).toMatchObject({ candidateSha: firstSha });

    await current.orchestrator.submitArtifact(
      await reviewResult(current, firstSha, 'CHANGES_REQUIRED'),
    );
    await expect(commandFor(current, 'builder-1')).resolves.toMatchObject({
      kind: 'CORRECTION',
    });
    const secondSha = await commitCandidate(current, 'corrected\n');
    await current.orchestrator.submitArtifact(await builderResult(current, secondSha));
    await current.orchestrator.submitArtifact(await reviewResult(current, secondSha, 'PASS'));
    await current.orchestrator.reconcile();

    const ready = await current.orchestrator.snapshot();
    const task = ready.tasks[0];
    if (task === undefined) throw new Error('task missing');
    expect(task.negativeReviewShas).toContain(firstSha);
    expect(reviewTruth(ready, task)).toMatchObject({
      eligible: true,
      reviewedSha: secondSha,
    });
    expect(await current.orchestrator.claimNextCommand('integrator-1')).toMatchObject({
      kind: 'INTEGRATE',
    });
    const integrated = await integrationResult(current, secondSha);
    await current.orchestrator.submitArtifact(integrated);
    expect((await current.orchestrator.snapshot()).tasks[0]).toMatchObject({
      status: 'ACCEPTED',
      acceptedSha: integrated.resultSha,
    });
  });

  it('permanently fences PASS -> CHANGES_REQUIRED -> later PASS for the same SHA', async () => {
    const current = await fixture('f9e70126');
    const candidateSha = await commitCandidate(current, 'candidate\n');
    await current.orchestrator.submitArtifact(await builderResult(current, candidateSha));
    await current.orchestrator.submitArtifact(await reviewResult(current, candidateSha, 'PASS'));
    await current.orchestrator.reconcile();
    expect((await current.orchestrator.snapshot()).integrationQueue[0]?.status).toBe('QUEUED');

    await current.orchestrator.requestIndependentReview(current.task.id, 'adversarial follow-up');
    await current.orchestrator.claimNextCommand('reviewer-1');
    await current.orchestrator.submitArtifact(
      await reviewResult(current, candidateSha, 'CHANGES_REQUIRED', 'negative'),
    );
    await current.orchestrator.requestIndependentReview(
      current.task.id,
      'attempt same-SHA reversal',
    );
    await current.orchestrator.claimNextCommand('reviewer-1');
    const laterPass = await current.orchestrator.submitArtifact(
      await reviewResult(current, candidateSha, 'PASS', 'later-pass'),
    );
    expect(laterPass).toMatchObject({
      verification: 'REJECTED',
      verificationErrors: expect.arrayContaining([
        'REVIEW_INVALIDATED: candidate SHA has an authoritative negative-review fence',
      ]),
    });
    expect(
      (await current.orchestrator.snapshot()).commands.find(
        (command) => command.id === laterPass.artifact.commandId,
      ),
    ).toMatchObject({ status: 'CANCELLED' });

    const restarted = new AgentOrchestrator({
      runtimeDir: current.runtimeDir,
      allowUnsafeTestRuntime: true,
    });
    await restarted.reconcile();
    const state = await restarted.snapshot();
    const task = state.tasks[0];
    if (task === undefined) throw new Error('task missing after restart');
    expect(reviewTruth(state, task)).toMatchObject({
      eligible: false,
      invalidated: true,
    });
    expect(state.integrationQueue[0]).toMatchObject({
      status: 'REMOVED',
      failureCode: 'REVIEW_INVALIDATED',
    });
    expect(await restarted.claimNextCommand('integrator-1')).toBeUndefined();
  });

  it('rejects a reviewer claiming Y while inspecting a different checkout X', async () => {
    const current = await fixture('wrong-checkout');
    const candidateSha = await commitCandidate(current, 'candidate\n');
    await current.orchestrator.submitArtifact(await builderResult(current, candidateSha));
    const review = await reviewResult(current, candidateSha, 'CHANGES_REQUIRED');
    const rejected = await current.orchestrator.submitArtifact({
      ...review,
      reviewCheckout: current.worktree,
    });
    expect(rejected.verification).toBe('REJECTED');
    expect(rejected.verificationErrors).toContain(
      'REVIEW_MATERIALIZATION_MISMATCH: artifact is not bound to the registered checkout',
    );
    const state = await current.orchestrator.snapshot();
    expect(state.tasks[0]?.negativeReviewShas).toEqual([]);
    expect(state.artifacts.filter((stored) => stored.verification === 'ACCEPTED')).toHaveLength(1);
  });

  it('rejects copied candidate fields when the registered reviewer session is attached to X', async () => {
    const current = await fixture('session-materialization-mismatch');
    const candidateSha = await commitCandidate(current, 'candidate\n');
    await current.orchestrator.submitArtifact(await builderResult(current, candidateSha));
    const review = await reviewResult(current, candidateSha, 'CHANGES_REQUIRED');
    const legacyCheckout = path.join(current.root, 'legacy-checkout');
    await execFileAsync('git', [
      'clone',
      '--quiet',
      '--no-local',
      current.worktree,
      legacyCheckout,
    ]);
    const statePath = path.join(current.runtimeDir, 'orchestration-state.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8')) as {
      agents: Array<{
        id: string;
        reviewEnvironment?: Record<string, unknown>;
      }>;
    };
    const reviewer = state.agents.find((agent) => agent.id === current.task.reviewerAgent);
    if (reviewer?.reviewEnvironment === undefined)
      throw new Error('review session was not registered');
    reviewer.reviewEnvironment = {
      ...reviewer.reviewEnvironment,
      workspace: legacyCheckout,
      gitControlDirectory: path.join(legacyCheckout, '.git'),
    };
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    const rejected = await current.orchestrator.submitArtifact(review);
    expect(rejected.verification).toBe('REJECTED');
    expect(rejected.verificationErrors).toContain(
      'REVIEW_MATERIALIZATION_MISMATCH: reviewer session is bound to another checkout',
    );
    const after = await current.orchestrator.snapshot();
    expect(after.tasks[0]).toMatchObject({
      status: 'REVIEW_RETRYABLE',
      negativeReviewShas: [],
    });
    expect(after.artifacts.filter((stored) => stored.verification === 'ACCEPTED')).toHaveLength(1);
  });

  it('treats unavailable review materialization as environment failure, never a negative verdict', async () => {
    const current = await fixture('missing-materialization');
    const candidateSha = await commitCandidate(current, 'candidate\n');
    await current.orchestrator.submitArtifact(await builderResult(current, candidateSha));
    const review = await reviewResult(current, candidateSha, 'BLOCKED');
    await fs.rm(review.reviewCheckout, { recursive: true, force: true });
    const rejected = await current.orchestrator.submitArtifact(review);
    expect(rejected.verification).toBe('REJECTED');
    expect(rejected.verificationErrors).toContain(
      'REVIEW_MATERIALIZATION_MISMATCH: review checkout changed or is unavailable',
    );
    expect((await current.orchestrator.snapshot()).tasks[0]).toMatchObject({
      status: 'REVIEW_RETRYABLE',
      negativeReviewShas: [],
    });
    await fs.mkdir(path.dirname(review.reviewCheckout), { recursive: true });
    await execFileAsync('git', [
      'clone',
      '--quiet',
      '--no-local',
      review.durableStoreGitDirectory,
      review.reviewCheckout,
    ]);
    await git(review.reviewCheckout, [
      'fetch',
      '--quiet',
      review.durableStoreGitDirectory,
      `${review.durableCandidateRef}:${review.durableCandidateRef}`,
    ]);
    await git(review.reviewCheckout, ['checkout', '--quiet', '--detach', candidateSha]);
    await current.orchestrator.reconcile();
    const repaired = await reviewResult(current, candidateSha, 'PASS', 'repaired');
    expect((await current.orchestrator.submitArtifact(repaired)).verification).toBe('ACCEPTED');
  });

  it('rejects unclaimed, cross-agent, and forged command artifacts without completing commands', async () => {
    const current = await fixture();
    await current.orchestrator.registerTask({
      ...current.task,
      id: 'task-2',
      title: 'Second authority domain',
      ownerAgent: 'builder-2',
      reviewerAgent: 'reviewer-2',
      ownedPaths: ['second.md'],
    });
    const candidateSha = await commitCandidate(current, 'candidate\n');
    await current.orchestrator.reconcile();
    const pending = (await current.orchestrator.snapshot()).commands[0];
    if (pending === undefined) throw new Error('pending command missing');
    const forged: BuilderResultArtifact = {
      schemaVersion: 1,
      kind: 'BUILDER_RESULT',
      ...binding(pending, candidateSha, 'BUILDER_RESULT'),
      artifactToken: 'forged-token',
      taskId: 'task-2',
      agent: 'builder-2',
      worktree: current.worktree,
      branch: current.task.branch,
      baseSha: current.baseSha,
      resultSha: candidateSha,
      status: 'PASS',
      filesChanged: ['candidate.md'],
      tests: [],
      blockers: [],
    };
    const rejected = await current.orchestrator.submitArtifact(forged);
    expect(rejected.verification).toBe('REJECTED');
    const state = await current.orchestrator.snapshot();
    expect(state.commands[0]?.status).toBe('PENDING');
    expect(state.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'task-1', status: 'DISPATCHED' }),
        expect.objectContaining({ id: 'task-2', status: 'DISPATCHED' }),
      ]),
    );
    expect(state.tasks.every((task) => task.candidateSha === undefined)).toBe(true);
    expect(state.integrationQueue).toHaveLength(0);
  });

  it('does not let a builder credential fabricate independent review PASS or readiness', async () => {
    const current = await fixture();
    const candidateSha = await commitCandidate(current, 'candidate\n');
    const builderArtifact = await builderResult(current, candidateSha);
    await current.orchestrator.submitArtifact(builderArtifact);
    const capturedTask = (await current.orchestrator.snapshot()).tasks[0];
    const materialization = capturedTask?.reviewMaterialization;
    if (materialization === undefined) throw new Error('review materialization missing');
    const forgedReview: ReviewResultArtifact = {
      schemaVersion: 1,
      kind: 'REVIEW_RESULT',
      commandId: builderArtifact.commandId,
      generation: builderArtifact.generation,
      candidateSha,
      sessionId: builderArtifact.sessionId,
      idempotencyKey: 'builder-attempted-review-pass',
      artifactType: 'REVIEW_RESULT',
      artifactToken: builderArtifact.artifactToken,
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
      evidenceInspected: [],
    };
    await expect(current.orchestrator.submitArtifact(forgedReview)).resolves.toMatchObject({
      verification: 'REJECTED',
    });
    await current.orchestrator.reconcile();
    const state = await current.orchestrator.snapshot();
    expect(state.tasks[0]).toMatchObject({ status: 'READY_FOR_REVIEW' });
    expect(state.integrationQueue).toHaveLength(0);
  });

  it('makes accepted artifact replay exactly idempotent across restart', async () => {
    const current = await fixture();
    const candidateSha = await commitCandidate(current, 'candidate\n');
    const artifact = await builderResult(current, candidateSha);
    const first = await current.orchestrator.submitArtifact(artifact);
    const restarted = new AgentOrchestrator({
      runtimeDir: current.runtimeDir,
      allowUnsafeTestRuntime: true,
    });
    const replay = await restarted.submitArtifact(artifact);
    expect(replay.id).toBe(first.id);
    await restarted.reconcile();
    const state = await restarted.snapshot();
    expect(state.artifacts).toHaveLength(1);
    expect(state.commands.filter((command) => command.kind === 'REVIEW')).toHaveLength(1);
  });

  it('does not duplicate negative review generation or correction dispatch on replay', async () => {
    const current = await fixture();
    const candidateSha = await commitCandidate(current, 'candidate\n');
    await current.orchestrator.submitArtifact(await builderResult(current, candidateSha));
    const negative = await reviewResult(current, candidateSha, 'CHANGES_REQUIRED');
    const first = await current.orchestrator.submitArtifact(negative);
    const restarted = new AgentOrchestrator({
      runtimeDir: current.runtimeDir,
      allowUnsafeTestRuntime: true,
    });
    const replay = await restarted.submitArtifact(negative);
    expect(replay.id).toBe(first.id);
    const state = await restarted.snapshot();
    expect(state.tasks[0]).toMatchObject({
      generation: 1,
      status: 'CHANGES_REQUIRED',
    });
    expect(state.commands.filter((command) => command.kind === 'CORRECTION')).toHaveLength(1);
    expect(
      state.artifacts.filter((stored) => stored.artifact.kind === 'REVIEW_RESULT'),
    ).toHaveLength(1);
  });

  it('acknowledges an inbox artifact exactly once after a crash between state commit and archive', async () => {
    const current = await fixture();
    const candidateSha = await commitCandidate(current, 'candidate\n');
    const artifact = await builderResult(current, candidateSha);
    const inbox = path.join(current.runtimeDir, 'inbox');
    await fs.mkdir(inbox, { recursive: true });
    await fs.writeFile(path.join(inbox, 'builder-result.json'), JSON.stringify(artifact));
    const stored = await current.orchestrator.submitArtifact(artifact);

    const restarted = new AgentOrchestrator({
      runtimeDir: current.runtimeDir,
      allowUnsafeTestRuntime: true,
    });
    await expect(restarted.ingestInbox()).resolves.toEqual({
      accepted: ['builder-result.json'],
      rejected: [],
    });
    await restarted.reconcile();
    const state = await restarted.snapshot();
    expect(state.artifacts).toHaveLength(1);
    expect(state.artifacts[0]?.id).toBe(stored.id);
    expect(state.commands.filter((command) => command.kind === 'REVIEW')).toHaveLength(1);
  });

  it('reconstructs a claimed command and queued integration without duplicate effects', async () => {
    const current = await fixture();
    const build = await commandFor(current, 'builder-1');
    const restartedClaim = new AgentOrchestrator({
      runtimeDir: current.runtimeDir,
      allowUnsafeTestRuntime: true,
    });
    expect(
      (await restartedClaim.snapshot()).commands.find((command) => command.id === build.id),
    ).toMatchObject({
      status: 'CLAIMED',
    });

    const candidateSha = await commitCandidate(current, 'candidate\n');
    await restartedClaim.submitArtifact(await builderResult(current, candidateSha));
    await restartedClaim.submitArtifact(await reviewResult(current, candidateSha, 'PASS'));
    await restartedClaim.reconcile();
    const before = await restartedClaim.snapshot();
    const restartedQueue = new AgentOrchestrator({
      runtimeDir: current.runtimeDir,
      allowUnsafeTestRuntime: true,
    });
    await restartedQueue.reconcile();
    const after = await restartedQueue.snapshot();
    expect(after.integrationQueue).toEqual(before.integrationQueue);
    expect(after.commands.filter((command) => command.kind === 'INTEGRATE')).toHaveLength(1);
  });

  it('blocks a partially attempted integration instead of issuing a blind resume', async () => {
    const current = await fixture();
    const candidateSha = await commitCandidate(current, 'candidate\n');
    await current.orchestrator.submitArtifact(await builderResult(current, candidateSha));
    await current.orchestrator.submitArtifact(await reviewResult(current, candidateSha, 'PASS'));
    await current.orchestrator.reconcile();
    await current.orchestrator.registerAgent({
      id: 'integrator-1',
      role: 'Integrator',
      pid: 2_000_000_000,
      sessionId: 'integrator-session',
    });
    await current.orchestrator.claimNextCommand('integrator-1');
    const captured = (await current.orchestrator.snapshot()).tasks[0]?.capturedCandidate;
    if (captured === undefined) throw new Error('capture missing');
    await git(current.integrationWorktree, [
      'fetch',
      '--quiet',
      captured.storeGitDirectory,
      captured.ref,
    ]);
    await git(current.integrationWorktree, [
      'cherry-pick',
      '--quiet',
      `${current.baseSha}..${candidateSha}`,
    ]);

    await current.orchestrator.reconcile();
    const state = await current.orchestrator.snapshot();
    expect(state.tasks[0]).toMatchObject({
      status: 'BLOCKED',
      blocker: expect.stringContaining('INTEGRATION_RECONCILIATION_REQUIRED'),
    });
    expect(state.commands.filter((command) => command.kind === 'INTEGRATE')).toHaveLength(1);
    expect(state.commands.find((command) => command.kind === 'INTEGRATE')).toMatchObject({
      status: 'CANCELLED',
    });
    expect(state.integrationQueue[0]).toMatchObject({
      status: 'REMOVED',
      failureCode: 'INTEGRATION_OUTCOME_UNKNOWN',
    });
  });

  it('retries an interrupted integration only after proving Git stayed at the predecessor', async () => {
    const current = await fixture();
    const candidateSha = await commitCandidate(current, 'candidate\n');
    await current.orchestrator.submitArtifact(await builderResult(current, candidateSha));
    await current.orchestrator.submitArtifact(await reviewResult(current, candidateSha, 'PASS'));
    await current.orchestrator.reconcile();
    await current.orchestrator.registerAgent({
      id: 'integrator-1',
      role: 'Integrator',
      pid: 2_000_000_000,
      sessionId: 'integrator-session',
    });
    await current.orchestrator.claimNextCommand('integrator-1');

    await current.orchestrator.reconcile();
    const state = await current.orchestrator.snapshot();
    expect(state.tasks[0]).toMatchObject({ status: 'READY_FOR_INTEGRATION' });
    expect(state.integrationQueue[0]).toMatchObject({
      status: 'QUEUED',
      expectedPredecessorSha: current.baseSha,
    });
    expect(state.commands.filter((command) => command.kind === 'INTEGRATE')).toHaveLength(2);
  });

  it('rejects authoritative state placed in a worker-writable temporary root', async () => {
    const current = await fixture();
    const unsafe = new AgentOrchestrator({
      runtimeDir: path.join(current.root, 'forged-state'),
    });
    await expect(unsafe.snapshot()).rejects.toThrow(/worker-writable|controller runtime/iu);
  });

  it('never treats builder PASS as independent review truth', async () => {
    const current = await fixture();
    const candidateSha = await commitCandidate(current, 'candidate\n');
    await current.orchestrator.submitArtifact(await builderResult(current, candidateSha));
    const state = await current.orchestrator.snapshot();
    const task = state.tasks[0];
    if (task === undefined) throw new Error('task missing');
    expect(reviewTruth(state, task)).toMatchObject({
      eligible: false,
      conflict: false,
    });
    expect(state.integrationQueue).toHaveLength(0);
  });

  it('rejects agent-reported Git control that is absent from the controller task contract', async () => {
    const current = await fixture();
    await expect(
      current.orchestrator.registerAgent({
        id: 'builder-1',
        role: 'Builder',
        environment: {
          schemaVersion: 1,
          environmentId: current.task.id,
          workspace: current.worktree,
          gitControlDirectory: path.join(current.root, 'untrusted-git-control'),
          branch: current.task.branch,
          baseSha: current.baseSha,
          gitCommit: 'DIRECT_WITH_EXPORTED_GIT_DIR',
          hostLoopback: 'UNAVAILABLE',
          sharedRuntime: 'VIA_HOST_VALIDATION_RUNNER',
          postgres: 'VIA_HOST_VALIDATION_RUNNER',
          networkNamespace: 'CODEX_ISOLATED',
          createdAt: '2026-08-15T00:00:00.000Z',
        },
      }),
    ).rejects.toThrow(/controller-owned task contract/iu);
  });

  it('fails closed with REVIEW_STATE_CONFLICT for conflicting authoritative records', async () => {
    const current = await fixture();
    const candidateSha = await commitCandidate(current, 'candidate\n');
    await current.orchestrator.submitArtifact(await builderResult(current, candidateSha));
    await current.orchestrator.submitArtifact(await reviewResult(current, candidateSha, 'PASS'));
    const state = await current.orchestrator.snapshot();
    const accepted = state.artifacts.find((stored) => stored.artifact.kind === 'REVIEW_RESULT');
    const task = state.tasks[0];
    if (
      accepted === undefined ||
      accepted.artifact.kind !== 'REVIEW_RESULT' ||
      task === undefined
    ) {
      throw new Error('review conflict fixture is incomplete');
    }
    state.artifacts.push({
      ...structuredClone(accepted),
      id: 'conflicting-review',
      artifact: { ...accepted.artifact, status: 'BLOCKED' },
    });
    task.negativeReviewShas.push(candidateSha);
    expect(reviewTruth(state, task)).toMatchObject({
      eligible: false,
      conflict: true,
      code: 'REVIEW_STATE_CONFLICT',
    });
  });

  it('pre-dispatch rejects a stale queue whose qualifying review command binding changed', async () => {
    const current = await fixture();
    const candidateSha = await commitCandidate(current, 'candidate\n');
    await current.orchestrator.submitArtifact(await builderResult(current, candidateSha));
    await current.orchestrator.submitArtifact(await reviewResult(current, candidateSha, 'PASS'));
    await current.orchestrator.reconcile();
    const stateFile = path.join(current.runtimeDir, 'orchestration-state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf8')) as {
      commands: Array<{ kind: string; artifactToken: string }>;
    };
    const reviewCommand = raw.commands.find((command) => command.kind === 'REVIEW');
    if (reviewCommand === undefined) throw new Error('review command missing');
    reviewCommand.artifactToken = 'tampered-controller-binding';
    await fs.writeFile(stateFile, `${JSON.stringify(raw, null, 2)}\n`);

    const restarted = new AgentOrchestrator({
      runtimeDir: current.runtimeDir,
      allowUnsafeTestRuntime: true,
    });
    await expect(restarted.claimNextCommand('integrator-1')).resolves.toBeUndefined();
    const blocked = await restarted.snapshot();
    expect(blocked.tasks[0]).toMatchObject({
      status: 'BLOCKED',
      blocker: expect.stringContaining('REVIEW_STATE_CONFLICT'),
    });
    expect(blocked.integrationQueue[0]).toMatchObject({
      status: 'REMOVED',
      failureCode: 'REVIEW_STATE_CONFLICT',
    });
  });

  it('fails closed when durable orchestration state is corrupt', async () => {
    const current = await fixture();
    await fs.writeFile(path.join(current.runtimeDir, 'orchestration-state.json'), 'not-json\n');
    await expect(current.orchestrator.snapshot()).rejects.toThrow(/state is unreadable/iu);
  });
});
