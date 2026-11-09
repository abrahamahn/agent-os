// src/agent/orchestrator-review.ts
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { normalizePaths, sameSecret, sameStrings, trustedDirectory } from './orchestrator-state';

import type {
  AgentCommand,
  AgentRecord,
  GitCandidate,
  IntegrationEntry,
  OrchestrationEvent,
  OrchestrationState,
  ReviewMaterialization,
  ReviewResultArtifact,
  ReviewSessionEnvironment,
  ReviewTruth,
  StoredArtifact,
  TaskRecord,
  TaskStatus,
} from './orchestrator-types';
import type { CapturedCandidate } from './worker-workspace';

const execFileAsync = promisify(execFile);

export function activeTask(status: TaskStatus): boolean {
  return !['READY', 'BLOCKED', 'REVIEW_RETRYABLE', 'ACCEPTED', 'SUPERSEDED'].includes(status);
}

export function commandIsActiveIntegration(command: AgentCommand): boolean {
  return (
    command.kind === 'INTEGRATE' && (command.status === 'PENDING' || command.status === 'CLAIMED')
  );
}

export function pathsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((leftPath) =>
    right.some(
      (rightPath) =>
        leftPath === rightPath ||
        leftPath.startsWith(`${rightPath}/`) ||
        rightPath.startsWith(`${leftPath}/`),
    ),
  );
}

export function taskById(state: OrchestrationState, taskId: string): TaskRecord {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (task === undefined) throw new Error(`Unknown Agent OS task: ${taskId}`);
  return task;
}

export function agentById(state: OrchestrationState, agentId: string): AgentRecord {
  const agent = state.agents.find((candidate) => candidate.id === agentId);
  if (agent === undefined) throw new Error(`Unknown Agent OS agent: ${agentId}`);
  return agent;
}

export function ensureAgent(
  state: OrchestrationState,
  agentId: string,
  role: string,
  now: string,
): AgentRecord {
  const existing = state.agents.find((candidate) => candidate.id === agentId);
  if (existing !== undefined) return existing;
  const created: AgentRecord = {
    id: agentId,
    role,
    lifecycle: 'IDLE',
    sessionId: `registered:${agentId}`,
    updatedAt: now,
  };
  state.agents.push(created);
  return created;
}

export function addEvent(
  state: OrchestrationState,
  now: string,
  type: string,
  detail: string,
  context: { taskId?: string; agent?: string } = {},
): OrchestrationEvent {
  state.sequence += 1;
  const event: OrchestrationEvent = {
    sequence: state.sequence,
    at: now,
    type,
    detail,
    ...context,
  };
  state.events.push(event);
  state.updatedAt = now;
  return event;
}

export function completeCommand(state: OrchestrationState, commandId: string, now: string): void {
  const command = state.commands.find((candidate) => candidate.id === commandId);
  if (command === undefined || command.status !== 'CLAIMED') {
    throw new Error('cannot complete an unclaimed command');
  }
  command.status = 'COMPLETED';
  command.completedAt = now;
}

export function releaseAgent(state: OrchestrationState, agentId: string, now: string): void {
  const agent = agentById(state, agentId);
  agent.lifecycle = 'IDLE';
  delete agent.currentTask;
  agent.updatedAt = now;
}

export function invalidateIntegrationForReview(
  state: OrchestrationState,
  task: TaskRecord,
  now: string,
  reason: string,
): number {
  let invalidated = 0;
  for (const entry of state.integrationQueue.filter(
    (candidate) =>
      candidate.taskId === task.id &&
      candidate.sourceSha === task.candidateSha &&
      ['QUEUED', 'INTEGRATING', 'VALIDATING'].includes(candidate.status),
  )) {
    entry.status = 'REMOVED';
    entry.failureCode = 'REVIEW_INVALIDATED';
    entry.reviewSupersessionState = 'SUPERSEDED';
    invalidated += 1;
  }
  for (const command of state.commands.filter(
    (candidate) => candidate.taskId === task.id && commandIsActiveIntegration(candidate),
  )) {
    const wasPending = command.status === 'PENDING';
    command.status = 'CANCELLED';
    command.completedAt = now;
    if (wasPending) releaseAgent(state, command.agent, now);
  }
  if (invalidated > 0) {
    addEvent(state, now, 'REVIEW_INVALIDATED', reason, { taskId: task.id });
  }
  return invalidated;
}

export function acceptedReviews(state: OrchestrationState, taskId: string): StoredArtifact[] {
  return state.artifacts.filter(
    (stored) =>
      stored.verification === 'ACCEPTED' &&
      stored.supersededAt === undefined &&
      stored.artifact.kind === 'REVIEW_RESULT' &&
      stored.artifact.taskId === taskId,
  );
}

export function reviewBindingError(
  state: OrchestrationState,
  task: TaskRecord,
  stored: StoredArtifact,
): string | undefined {
  if (stored.artifact.kind !== 'REVIEW_RESULT') return 'stored review has the wrong artifact type';
  const review = stored.artifact;
  const materialization = task.reviewMaterialization;
  const command = state.commands.find((candidate) => candidate.id === review.commandId);
  const binding = command?.reviewBinding;
  if (
    command === undefined ||
    command.kind !== 'REVIEW' ||
    command.status !== 'COMPLETED' ||
    command.taskId !== task.id ||
    command.agent !== review.agent ||
    command.generation !== review.generation ||
    command.sessionId !== review.sessionId ||
    binding === undefined ||
    binding.taskId !== task.id ||
    binding.commandId !== command.id ||
    binding.reviewerAgent !== review.agent ||
    binding.reviewerSessionId !== review.sessionId ||
    binding.candidateSha !== review.reviewedSha ||
    binding.candidateTreeSha !== review.candidateTreeSha ||
    binding.materializationId !== review.reviewMaterializationId ||
    binding.reviewCheckout !== review.reviewCheckout ||
    binding.gitControlDirectory !== materialization?.gitControlDirectory ||
    !sameSecret(command.artifactToken, review.artifactToken) ||
    stored.taskGeneration !== review.generation ||
    review.reviewMaterializationId !== materialization.id ||
    review.reviewCheckout !== materialization.checkout ||
    review.candidateTreeSha !== materialization.candidateTreeSha ||
    review.durableCandidateRef !== materialization.durableCandidateRef ||
    review.durableStoreGitDirectory !== materialization.durableStoreGitDirectory ||
    review.reviewedSha !== materialization.candidateSha ||
    review.artifactType !== 'REVIEW_RESULT'
  ) {
    return `review artifact ${stored.id} is not bound to its completed controller command`;
  }
  return undefined;
}

export function reviewTruth(state: OrchestrationState, task: TaskRecord): ReviewTruth {
  if (task.candidateSha === undefined) {
    return {
      eligible: false,
      conflict: false,
      reason: 'candidate exact SHA is missing',
    };
  }
  const reviews = acceptedReviews(state, task.id);
  if (reviews.length === 0) {
    return {
      eligible: false,
      conflict: false,
      reason: 'independent review artifact is missing',
    };
  }
  const invalidBinding = reviews.find(
    (stored) => reviewBindingError(state, task, stored) !== undefined,
  );
  if (invalidBinding !== undefined) {
    return {
      eligible: false,
      conflict: true,
      code: 'REVIEW_STATE_CONFLICT',
      reason:
        reviewBindingError(state, task, invalidBinding) ?? 'review command binding is invalid',
    };
  }
  const latestGeneration = Math.max(...reviews.map((stored) => stored.taskGeneration ?? 0));
  const latestReviews = reviews.filter(
    (stored) => (stored.taskGeneration ?? 0) === latestGeneration,
  );
  const taskArtifactIndexes = new Map(
    state.artifacts.map((stored, index) => [stored.id, index] as const),
  );
  const sequenceOf = (stored: StoredArtifact): number =>
    stored.sequence ?? (taskArtifactIndexes.get(stored.id) ?? -1) + 1;
  const latestSequence = Math.max(...latestReviews.map(sequenceOf));
  const authoritative = latestReviews.filter((stored) => sequenceOf(stored) === latestSequence);
  const authoritativeSignatures = new Set(
    authoritative.map((stored) => {
      const artifact = stored.artifact;
      if (artifact.kind !== 'REVIEW_RESULT') throw new Error('review artifact index is corrupt');
      return `${artifact.reviewedSha}:${artifact.status}:${artifact.agent}`;
    }),
  );
  if (authoritativeSignatures.size !== 1) {
    return {
      eligible: false,
      conflict: true,
      code: 'REVIEW_STATE_CONFLICT',
      reason: 'latest review sequence contains conflicting records',
    };
  }
  const latest = authoritative.at(-1);
  if (latest === undefined || latest.artifact.kind !== 'REVIEW_RESULT') {
    return {
      eligible: false,
      conflict: true,
      code: 'REVIEW_STATE_CONFLICT',
      reason: 'latest review generation cannot be reconstructed',
    };
  }
  const review = latest.artifact;
  if (task.negativeReviewShas.includes(task.candidateSha)) {
    return {
      eligible: false,
      conflict: false,
      invalidated: true,
      code: 'REVIEW_INVALIDATED',
      reason: `candidate ${task.candidateSha} has an authoritative negative-review fence`,
      verdict: 'CHANGES_REQUIRED',
    };
  }
  const laterAdverse = reviews.find((stored) => {
    const artifact = stored.artifact;
    return (
      artifact.kind === 'REVIEW_RESULT' &&
      artifact.status !== 'PASS' &&
      sequenceOf(stored) > latestSequence
    );
  });
  if (laterAdverse !== undefined) {
    return {
      eligible: false,
      conflict: true,
      code: 'REVIEW_STATE_CONFLICT',
      reason: 'a later CHANGES_REQUIRED or BLOCKED verdict exists',
    };
  }
  if (review.reviewedSha !== task.candidateSha) {
    return {
      eligible: false,
      conflict: true,
      code: 'REVIEW_STATE_CONFLICT',
      reason: 'latest review does not match the candidate exact SHA',
    };
  }
  if (review.status !== 'PASS') {
    return {
      eligible: false,
      conflict: false,
      invalidated: true,
      code: 'REVIEW_INVALIDATED',
      reason: `latest authoritative review verdict is ${review.status}`,
      verdict: review.status,
    };
  }
  if (review.agent === task.ownerAgent || review.agent !== task.reviewerAgent) {
    return {
      eligible: false,
      conflict: true,
      code: 'REVIEW_STATE_CONFLICT',
      reason:
        review.agent === task.ownerAgent
          ? 'builder self-review cannot establish integration eligibility'
          : 'latest review was not produced by the assigned independent reviewer',
    };
  }
  return {
    eligible: true,
    conflict: false,
    reason: 'latest independent review generation passes the candidate exact SHA',
    reviewArtifactId: latest.id,
    reviewedSha: review.reviewedSha,
    reviewSequence: latestSequence,
    reviewGeneration: latest.taskGeneration ?? 0,
    reviewer: review.agent,
    verdict: 'PASS',
    reviewedAt: latest.receivedAt,
    supersessionState: 'CURRENT',
  };
}

export function integrationBindingMatches(
  entry: IntegrationEntry,
  task: TaskRecord,
  truth: ReviewTruth,
): boolean {
  return (
    truth.eligible &&
    task.candidateSha !== undefined &&
    entry.sourceSha === task.candidateSha &&
    entry.candidateSha === task.candidateSha &&
    entry.reviewArtifactId === truth.reviewArtifactId &&
    entry.reviewedSha === truth.reviewedSha &&
    entry.reviewSequence === truth.reviewSequence &&
    entry.reviewGeneration === truth.reviewGeneration &&
    entry.reviewer === truth.reviewer &&
    entry.reviewVerdict === truth.verdict &&
    entry.reviewedAt === truth.reviewedAt &&
    entry.reviewSupersessionState === truth.supersessionState &&
    task.capturedCandidate !== undefined &&
    entry.candidateTreeSha === task.capturedCandidate.treeSha &&
    entry.durableCandidateRef === task.capturedCandidate.ref
  );
}

export function integrationEntryFromReview(
  state: OrchestrationState,
  task: TaskRecord,
  truth: ReviewTruth,
  now: string,
): IntegrationEntry {
  if (
    !truth.eligible ||
    task.candidateSha === undefined ||
    truth.reviewArtifactId === undefined ||
    truth.reviewedSha === undefined ||
    truth.reviewSequence === undefined ||
    truth.reviewGeneration === undefined ||
    truth.reviewer === undefined ||
    truth.verdict !== 'PASS' ||
    truth.reviewedAt === undefined ||
    task.capturedCandidate === undefined
  ) {
    throw new Error('cannot create an integration entry without exact qualifying review truth');
  }
  return {
    taskId: task.id,
    sourceSha: task.candidateSha,
    candidateSha: task.candidateSha,
    reviewArtifactId: truth.reviewArtifactId,
    reviewedSha: truth.reviewedSha,
    reviewSequence: truth.reviewSequence,
    reviewGeneration: truth.reviewGeneration,
    reviewer: truth.reviewer,
    reviewVerdict: truth.verdict,
    reviewedAt: truth.reviewedAt,
    reviewSupersessionState: 'CURRENT',
    candidateTreeSha: task.capturedCandidate.treeSha,
    durableCandidateRef: task.capturedCandidate.ref,
    expectedPredecessorSha: state.integratedSha ?? task.baseSha,
    dependencies: [...task.dependencies],
    status: 'QUEUED',
    queuedAt: now,
  };
}

export async function git(
  worktree: string,
  args: readonly string[],
  gitControlDirectory?: string,
): Promise<string> {
  try {
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
  } catch (error) {
    if (error instanceof Error && 'stderr' in error && typeof error.stderr === 'string') {
      throw new Error(error.stderr.trim() || `git ${args.join(' ')} failed`, {
        cause: error,
      });
    }
    throw error;
  }
}

export async function materializeReviewCandidate(
  runtimeDir: string,
  taskId: string,
  generation: number,
  captured: CapturedCandidate,
  now: string,
): Promise<ReviewMaterialization> {
  const identity = createHash('sha256')
    .update(`${taskId}\0${String(generation)}\0${captured.candidateSha}`)
    .digest('hex');
  const checkout = path.join(runtimeDir, 'review-materializations', identity);
  await fs.mkdir(path.dirname(checkout), { recursive: true, mode: 0o700 });
  if ((await fs.lstat(checkout).catch(() => undefined)) === undefined) {
    await execFileAsync('git', [
      'clone',
      '--quiet',
      '--no-local',
      '--no-checkout',
      captured.storeGitDirectory,
      checkout,
    ]);
    await execFileAsync('git', [
      '-C',
      checkout,
      'fetch',
      '--quiet',
      '--no-tags',
      captured.storeGitDirectory,
      `${captured.ref}:${captured.ref}`,
    ]);
    await git(checkout, ['checkout', '--quiet', '--detach', captured.candidateSha]);
  }
  const actualCheckout = await trustedDirectory(checkout, 'review materialization');
  const gitControlDirectory = await trustedDirectory(
    path.join(actualCheckout, '.git'),
    'review Git control directory',
  );
  const head = await git(actualCheckout, ['rev-parse', 'HEAD']);
  const tree = await git(actualCheckout, ['rev-parse', 'HEAD^{tree}']);
  const dirty = await git(actualCheckout, ['status', '--porcelain']);
  if (head !== captured.candidateSha || tree !== captured.treeSha || dirty.length !== 0) {
    throw new Error('REVIEW_MATERIALIZATION_MISMATCH: controller checkout is not exact and clean');
  }
  const materialization: ReviewMaterialization = {
    id: identity,
    taskId,
    generation,
    candidateSha: captured.candidateSha,
    candidateTreeSha: captured.treeSha,
    durableCandidateRef: captured.ref,
    durableStoreGitDirectory: captured.storeGitDirectory,
    checkout: actualCheckout,
    gitControlDirectory,
    createdAt: now,
  };
  const metadata = path.join(actualCheckout, '.agent-os-review-materialization.json');
  await fs
    .writeFile(metadata, `${JSON.stringify(materialization, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    })
    .catch((error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    });
  await git(actualCheckout, ['reset', '--quiet', '--hard', captured.candidateSha]);
  await fs.unlink(metadata).catch(() => undefined);
  return materialization;
}

export async function verifyReviewMaterialization(
  task: TaskRecord,
  artifact: ReviewResultArtifact,
): Promise<string[]> {
  const materialization = task.reviewMaterialization;
  if (materialization === undefined)
    return ['REVIEW_MATERIALIZATION_MISMATCH: materialization is missing'];
  const errors: string[] = [];
  if (
    artifact.generation !== materialization.generation ||
    artifact.reviewMaterializationId !== materialization.id ||
    artifact.reviewCheckout !== materialization.checkout ||
    artifact.reviewedSha !== materialization.candidateSha ||
    artifact.candidateTreeSha !== materialization.candidateTreeSha ||
    artifact.durableCandidateRef !== materialization.durableCandidateRef ||
    artifact.durableStoreGitDirectory !== materialization.durableStoreGitDirectory
  ) {
    errors.push(
      'REVIEW_MATERIALIZATION_MISMATCH: artifact is not bound to the registered checkout',
    );
    return errors;
  }
  const registeredErrors = await verifyRegisteredReviewMaterialization(task);
  if (registeredErrors.length > 0) return registeredErrors;
  return [];
}

export async function verifyRegisteredReviewMaterialization(task: TaskRecord): Promise<string[]> {
  const materialization = task.reviewMaterialization;
  if (materialization === undefined)
    return ['REVIEW_MATERIALIZATION_MISMATCH: materialization is missing'];
  const errors: string[] = [];
  try {
    const store = await trustedDirectory(
      materialization.durableStoreGitDirectory,
      'durable candidate store',
    );
    const imported = await execFileAsync('git', [
      '--git-dir',
      store,
      'rev-parse',
      materialization.durableCandidateRef,
    ]).then((result) => result.stdout.trim());
    const importedTree = await execFileAsync('git', [
      '--git-dir',
      store,
      'rev-parse',
      `${materialization.durableCandidateRef}^{tree}`,
    ]).then((result) => result.stdout.trim());
    if (
      imported !== materialization.candidateSha ||
      importedTree !== materialization.candidateTreeSha
    ) {
      errors.push(
        'REVIEW_MATERIALIZATION_MISMATCH: durable candidate ref changed or is unavailable',
      );
      return errors;
    }
    const checkout = await trustedDirectory(materialization.checkout, 'review materialization');
    const gitControlDirectory = await trustedDirectory(
      materialization.gitControlDirectory,
      'review Git control directory',
    );
    if (gitControlDirectory !== path.resolve(path.join(checkout, '.git'))) {
      errors.push('REVIEW_MATERIALIZATION_MISMATCH: Git control directory changed');
      return errors;
    }
    const head = await git(checkout, ['rev-parse', 'HEAD']);
    const tree = await git(checkout, ['rev-parse', 'HEAD^{tree}']);
    const dirty = await git(checkout, ['status', '--porcelain']);
    if (
      head !== materialization.candidateSha ||
      tree !== materialization.candidateTreeSha ||
      dirty
    ) {
      errors.push('REVIEW_MATERIALIZATION_MISMATCH: review checkout changed or is unavailable');
    }
  } catch {
    errors.push('REVIEW_MATERIALIZATION_MISMATCH: review checkout changed or is unavailable');
  }
  return errors;
}

export async function verifyReviewSessionEnvironment(
  task: TaskRecord,
  environment: ReviewSessionEnvironment,
): Promise<string[]> {
  const materialization = task.reviewMaterialization;
  if (materialization === undefined)
    return ['CANDIDATE_UNAVAILABLE: review materialization is missing'];
  const errors: string[] = [];
  if (
    environment.taskId !== task.id ||
    environment.generation !== task.generation ||
    environment.materializationId !== materialization.id ||
    environment.candidateSha !== materialization.candidateSha ||
    environment.candidateTreeSha !== materialization.candidateTreeSha ||
    environment.durableCandidateRef !== materialization.durableCandidateRef ||
    environment.durableStoreGitDirectory !== materialization.durableStoreGitDirectory ||
    environment.workspace !== materialization.checkout ||
    environment.gitControlDirectory !== materialization.gitControlDirectory
  ) {
    errors.push('REVIEW_MATERIALIZATION_MISMATCH: reviewer session is bound to another checkout');
    return errors;
  }
  return errors.concat(await verifyRegisteredReviewMaterialization(task));
}

export async function verifyGitCandidate(candidate: GitCandidate): Promise<string[]> {
  const errors: string[] = [];
  const expectedWorktree = path.resolve(candidate.worktree);
  try {
    const actualRoot = path.resolve(
      await git(expectedWorktree, ['rev-parse', '--show-toplevel'], candidate.gitControlDirectory),
    );
    if (actualRoot !== expectedWorktree) errors.push(`worktree resolves to ${actualRoot}`);
    const branch = await git(
      expectedWorktree,
      ['branch', '--show-current'],
      candidate.gitControlDirectory,
    );
    if (branch !== candidate.branch)
      errors.push(`branch is ${branch || '(detached)'}, expected ${candidate.branch}`);
    const head = (
      await git(expectedWorktree, ['rev-parse', 'HEAD'], candidate.gitControlDirectory)
    ).toLowerCase();
    if (head !== candidate.resultSha)
      errors.push(`HEAD is ${head}, expected ${candidate.resultSha}`);
    await git(
      expectedWorktree,
      ['cat-file', '-e', `${candidate.resultSha}^{commit}`],
      candidate.gitControlDirectory,
    );
    try {
      await git(
        expectedWorktree,
        ['merge-base', '--is-ancestor', candidate.baseSha, candidate.resultSha],
        candidate.gitControlDirectory,
      );
    } catch {
      errors.push(`base SHA ${candidate.baseSha} is not an ancestor of ${candidate.resultSha}`);
    }
    if (candidate.previousSha !== undefined) {
      if (candidate.previousSha === candidate.resultSha)
        errors.push('correction must produce a new result SHA');
      else {
        try {
          await git(
            expectedWorktree,
            ['merge-base', '--is-ancestor', candidate.previousSha, candidate.resultSha],
            candidate.gitControlDirectory,
          );
        } catch {
          errors.push(
            `corrected SHA does not descend from prior candidate ${candidate.previousSha}`,
          );
        }
      }
    }
    const dirty = await git(
      expectedWorktree,
      ['status', '--porcelain'],
      candidate.gitControlDirectory,
    );
    if (dirty.length > 0)
      errors.push('worktree is dirty; exact-SHA reconciliation requires a clean worktree');
    const files = normalizePaths(
      (
        await git(
          expectedWorktree,
          ['diff', '--name-only', `${candidate.baseSha}..${candidate.resultSha}`],
          candidate.gitControlDirectory,
        )
      )
        .split('\n')
        .filter(Boolean),
    );
    if (!sameStrings(files, normalizePaths(candidate.filesChanged))) {
      errors.push(`filesChanged does not match Git (${files.join(', ') || 'none'})`);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

export async function capturedCandidateExists(
  task: TaskRecord,
  runtimeDir: string,
): Promise<boolean> {
  const captured = task.capturedCandidate;
  if (task.candidateSha === undefined || captured?.candidateSha !== task.candidateSha) return false;
  try {
    const expectedStore = path.join(runtimeDir, 'object-store.git');
    if (
      captured.storeGitDirectory !== expectedStore ||
      (await fs.realpath(captured.storeGitDirectory)) !== expectedStore ||
      captured.ref !== `refs/candidates/${task.id}/${captured.candidateSha}` ||
      (await fs.lstat(captured.storeGitDirectory)).isSymbolicLink() ||
      (await fs
        .lstat(path.join(captured.storeGitDirectory, 'objects', 'info', 'alternates'))
        .catch(() => undefined)) !== undefined
    ) {
      return false;
    }
    const commit = (
      await git(captured.storeGitDirectory, [
        '--git-dir',
        captured.storeGitDirectory,
        'rev-parse',
        captured.ref,
      ])
    ).toLowerCase();
    const tree = (
      await git(captured.storeGitDirectory, [
        '--git-dir',
        captured.storeGitDirectory,
        'rev-parse',
        `${captured.ref}^{tree}`,
      ])
    ).toLowerCase();
    return commit === captured.candidateSha && tree === captured.treeSha;
  } catch {
    return false;
  }
}

export function buildPrompt(task: TaskRecord): string {
  return `TASK ${task.id} — ${task.title}\nBase: ${task.baseSha}\nBranch: ${task.branch}\nWorktree: ${task.worktree}\nAcceptance:\n${task.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n')}\nStop by submitting a BUILDER_RESULT artifact with the exact committed SHA and evidence.`;
}

export function reviewPrompt(task: TaskRecord): string {
  const materialization = task.reviewMaterialization;
  return `REVIEW ${task.id} at exact SHA ${task.candidateSha ?? '(missing)'}\nController materialization: ${materialization?.checkout ?? '(missing)'}\nMaterialization ID: ${materialization?.id ?? '(missing)'}\nCandidate tree: ${materialization?.candidateTreeSha ?? '(missing)'}\nDurable ref: ${materialization?.durableCandidateRef ?? '(missing)'}\nDurable store: ${materialization?.durableStoreGitDirectory ?? '(missing)'}\nInspect only the controller materialization and verify HEAD/tree before review. If it is unavailable or mismatched, submit no verdict and report candidate-unavailable. Submit REVIEW_RESULT with PASS, CHANGES_REQUIRED, or BLOCKED only after exact materialization is verified. Do not review a different SHA.`;
}

export function integrationPrompt(state: OrchestrationState, task: TaskRecord): string {
  const captured = task.capturedCandidate;
  return `INTEGRATE ${task.id}\nAccepted source SHA: ${task.candidateSha ?? '(missing)'}\nDurable object store: ${captured?.storeGitDirectory ?? '(missing)'}\nDurable candidate ref: ${captured?.ref ?? '(missing)'}\nAccepted predecessor SHA: ${state.integratedSha ?? task.baseSha}\nPreserve dependency order: ${task.dependencies.join(', ') || 'none'}\nFetch only from the durable controller store and submit INTEGRATION_RESULT from the configured integration worktree; finish order does not override this order.`;
}

export function validationPrompt(task: TaskRecord, resultSha: string): string {
  const checks = task.validation?.checks ?? [];
  return `VALIDATE ${task.id} at exact integrated SHA ${resultSha}\n${checks
    .map(
      (check) =>
        `- ${check.checkId} (${check.resource}): ${check.command.join(' ')}; request/reuse exact-SHA evidence before acquiring resources`,
    )
    .join(
      '\n',
    )}\nSubmit VALIDATION_RESULT with the evidence IDs. Evidence for another SHA is invalid.`;
}
