// src/agent/orchestrator-state.ts
import { randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { controllerRoot, ensureControllerRuntimeDirectory } from './controller-runtime';

import type {
  AgentArtifact,
  AgentCommand,
  ArtifactBinding,
  BuilderResultArtifact,
  IntegrationEntry,
  IntegrationResultArtifact,
  OrchestrationState,
  ReviewFinding,
  ReviewResultArtifact,
  ReviewSessionEnvironment,
  StoredArtifact,
  TaskContract,
  TaskRecord,
  TestEvidenceClaim,
  ValidationRequirement,
  ValidationResultArtifact,
} from './orchestrator-types';

const STATE_FILE = 'orchestration-state.json';
const LOCK_DIRECTORY = 'orchestration.lock';
const LOCK_OWNER_FILE = 'owner.json';
const LOCK_STALE_MS = 30_000;
const EVENT_HISTORY_LIMIT = 2_000;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/u;

export function defaultRuntimeDirectory(): string {
  return controllerRoot();
}

export function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function fullSha(value: unknown, label: string): string {
  const sha = requiredText(value, label).toLowerCase();
  if (!SHA_PATTERN.test(sha)) throw new Error(`${label} must be a full hexadecimal commit SHA`);
  return sha;
}

export function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const result = value.map((entry, index) => requiredText(entry, `${label}[${String(index)}]`));
  if (new Set(result).size !== result.length)
    throw new Error(`${label} must not contain duplicates`);
  return result;
}

export function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function normalizePaths(values: readonly string[]): string[] {
  return [
    ...new Set(values.map((value) => value.replaceAll('\\', '/').replace(/^\.\//u, ''))),
  ].sort();
}

export function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

export function sameSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export async function processStartTicks(pid: number): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = await fs.readFile(`/proc/${String(pid)}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19];
  } catch {
    return undefined;
  }
}

export async function sameProcess(pid: number, expectedStart?: string): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (expectedStart === undefined || process.platform !== 'linux') return true;
  try {
    const stat = await fs.readFile(`/proc/${String(pid)}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19] === expectedStart;
  } catch {
    return false;
  }
}

export async function trustedDirectory(value: string, label: string): Promise<string> {
  const resolved = path.resolve(value);
  const real = await fs.realpath(resolved);
  const status = await fs.lstat(resolved);
  if (real !== resolved || !status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory, not a symlink`);
  }
  return real;
}

export function emptyState(now: string, cycle = 'UNASSIGNED'): OrchestrationState {
  return {
    version: 1,
    sequence: 0,
    cycle,
    tasks: [],
    agents: [],
    commands: [],
    artifacts: [],
    integrationQueue: [],
    events: [],
    lastBriefSequence: 0,
    updatedAt: now,
  };
}

export function validateState(value: unknown, statePath: string): OrchestrationState {
  const candidate = record(value, 'orchestration state');
  if (
    candidate['version'] !== 1 ||
    typeof candidate['sequence'] !== 'number' ||
    typeof candidate['cycle'] !== 'string' ||
    !Array.isArray(candidate['tasks']) ||
    !Array.isArray(candidate['agents']) ||
    !Array.isArray(candidate['commands']) ||
    !Array.isArray(candidate['artifacts']) ||
    !Array.isArray(candidate['integrationQueue']) ||
    !Array.isArray(candidate['events']) ||
    typeof candidate['lastBriefSequence'] !== 'number' ||
    typeof candidate['updatedAt'] !== 'string'
  ) {
    throw new Error(`orchestration state has an unsupported schema: ${statePath}`);
  }
  if (
    candidate['tasks'].some(
      (task) =>
        typeof task !== 'object' ||
        task === null ||
        !Array.isArray((task as Partial<TaskRecord>).negativeReviewShas),
    ) ||
    candidate['commands'].some((command) => {
      const entry = command as Partial<AgentCommand> | null;
      return (
        entry === null ||
        typeof entry !== 'object' ||
        typeof entry.sessionId !== 'string' ||
        typeof entry.artifactToken !== 'string' ||
        (entry.kind === 'REVIEW' &&
          (entry.reviewBinding === undefined || typeof entry.reviewBinding !== 'object'))
      );
    }) ||
    candidate['artifacts'].some((stored) => {
      const artifact = (stored as Partial<StoredArtifact> | null)?.artifact;
      return (
        artifact === undefined ||
        typeof artifact.commandId !== 'string' ||
        typeof artifact.idempotencyKey !== 'string' ||
        artifact.artifactType !== artifact.kind
      );
    }) ||
    candidate['integrationQueue'].some((queued) => {
      const entry = queued as Partial<IntegrationEntry> | null;
      return (
        entry === null ||
        typeof entry !== 'object' ||
        typeof entry.candidateTreeSha !== 'string' ||
        typeof entry.durableCandidateRef !== 'string' ||
        typeof entry.expectedPredecessorSha !== 'string'
      );
    })
  ) {
    throw new Error(`orchestration state lacks command-bound authority fields: ${statePath}`);
  }
  return candidate as unknown as OrchestrationState;
}

export async function readState(runtimeDir: string, now: string): Promise<OrchestrationState> {
  const statePath = path.join(runtimeDir, STATE_FILE);
  try {
    return validateState(JSON.parse(await fs.readFile(statePath, 'utf8')) as unknown, statePath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return emptyState(now);
    if (error instanceof SyntaxError) {
      throw new Error(`orchestration state is unreadable: ${statePath}`, {
        cause: error,
      });
    }
    throw error;
  }
}

export async function ensureRuntimeDirectory(
  runtimeDir: string,
  allowUnsafeTestRuntime: boolean,
): Promise<void> {
  await ensureControllerRuntimeDirectory(runtimeDir, {
    allowUnsafeTestRuntime,
  });
  await Promise.all(
    ['inbox', 'archive', 'rejected'].map((name) =>
      fs.mkdir(path.join(runtimeDir, name), { recursive: true, mode: 0o700 }),
    ),
  );
}

export async function writeState(runtimeDir: string, state: OrchestrationState): Promise<void> {
  if (state.events.length > EVENT_HISTORY_LIMIT)
    state.events = state.events.slice(-EVENT_HISTORY_LIMIT);
  const destination = path.join(runtimeDir, STATE_FILE);
  const temporary = `${destination}.${String(process.pid)}-${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, destination);
  const directory = await fs.open(runtimeDir, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function releaseLock(lockDirectory: string): Promise<void> {
  await fs.rm(path.join(lockDirectory, LOCK_OWNER_FILE), { force: true });
  try {
    await fs.rmdir(lockDirectory);
  } catch {
    // Never recursively delete an unknown lock directory.
  }
}

export async function acquireLock(
  runtimeDir: string,
  pollMs: number,
  allowUnsafeTestRuntime: boolean,
): Promise<string> {
  await ensureRuntimeDirectory(runtimeDir, allowUnsafeTestRuntime);
  const lockDirectory = path.join(runtimeDir, LOCK_DIRECTORY);
  for (;;) {
    try {
      await fs.mkdir(lockDirectory, { mode: 0o700 });
      await fs.writeFile(
        path.join(lockDirectory, LOCK_OWNER_FILE),
        `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
        { mode: 0o600 },
      );
      return lockDirectory;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      let stale = false;
      try {
        stale = Date.now() - (await fs.stat(lockDirectory)).mtimeMs > LOCK_STALE_MS;
      } catch {
        continue;
      }
      let ownerPid: number | undefined;
      try {
        const owner = record(
          JSON.parse(
            await fs.readFile(path.join(lockDirectory, LOCK_OWNER_FILE), 'utf8'),
          ) as unknown,
          'lock owner',
        );
        if (typeof owner['pid'] === 'number') ownerPid = owner['pid'];
      } catch {
        // An unreadable owner is stale only after the age threshold.
      }
      if (stale && (ownerPid === undefined || !(await sameProcess(ownerPid)))) {
        await releaseLock(lockDirectory);
        continue;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, pollMs));
    }
  }
}

function parseTestClaims(value: unknown): TestEvidenceClaim[] {
  if (!Array.isArray(value)) throw new Error('tests must be an array');
  return value.map((entry, index) => {
    const item = record(entry, `tests[${String(index)}]`);
    const status = requiredText(item['status'], `tests[${String(index)}].status`);
    if (!['PASS', 'FAIL', 'ENVIRONMENT_BLOCKED'].includes(status)) {
      throw new Error(`tests[${String(index)}].status is invalid`);
    }
    const evidenceId = item['evidenceId'];
    return {
      checkId: requiredText(item['checkId'], `tests[${String(index)}].checkId`),
      status: status as TestEvidenceClaim['status'],
      command: stringList(item['command'], `tests[${String(index)}].command`),
      ...(evidenceId === undefined
        ? {}
        : {
            evidenceId: requiredText(evidenceId, `tests[${String(index)}].evidenceId`),
          }),
    };
  });
}

export function parseTaskContract(value: unknown): TaskContract {
  const item = record(value, 'task contract');
  const rawPriority = item['priority'];
  if (!Number.isSafeInteger(rawPriority) || (rawPriority as number) < 0) {
    throw new Error('task priority must be a non-negative integer');
  }
  const supersedes = item['supersedes'];
  const integrationValue = item['integration'];
  const validationValue = item['validation'];
  let integration: TaskContract['integration'];
  if (integrationValue !== undefined) {
    const parsed = record(integrationValue, 'task integration');
    integration = {
      agent: requiredText(parsed['agent'], 'integration.agent'),
      worktree: path.resolve(requiredText(parsed['worktree'], 'integration.worktree')),
      branch: requiredText(parsed['branch'], 'integration.branch'),
      ...(parsed['gitControlDirectory'] === undefined
        ? {}
        : {
            gitControlDirectory: path.resolve(
              requiredText(parsed['gitControlDirectory'], 'integration.gitControlDirectory'),
            ),
          }),
    };
  }
  let validation: TaskContract['validation'];
  if (validationValue !== undefined) {
    const parsed = record(validationValue, 'task validation');
    if (!Array.isArray(parsed['checks'])) throw new Error('validation.checks must be an array');
    validation = {
      agent: requiredText(parsed['agent'], 'validation.agent'),
      checks: parsed['checks'].map((entry, index): ValidationRequirement => {
        const check = record(entry, `validation.checks[${String(index)}]`);
        const resource = requiredText(check['resource'], 'validation resource');
        if (resource !== 'medium' && resource !== 'heavy') {
          throw new Error('validation resource must be medium or heavy');
        }
        return {
          checkId: requiredText(check['checkId'], 'validation checkId'),
          resource,
          command: stringList(check['command'], 'validation command'),
          ...(check['environmentFingerprint'] === undefined
            ? {}
            : {
                environmentFingerprint: requiredText(
                  check['environmentFingerprint'],
                  'validation environmentFingerprint',
                ),
              }),
        };
      }),
    };
  }
  return {
    id: requiredText(item['id'], 'task id'),
    cycle: requiredText(item['cycle'], 'task cycle'),
    title: requiredText(item['title'], 'task title'),
    priority: rawPriority as number,
    ownerAgent: requiredText(item['ownerAgent'], 'task ownerAgent'),
    reviewerAgent: requiredText(item['reviewerAgent'], 'task reviewerAgent'),
    worktree: path.resolve(requiredText(item['worktree'], 'task worktree')),
    branch: requiredText(item['branch'], 'task branch'),
    baseSha: fullSha(item['baseSha'], 'task baseSha'),
    ...(item['gitControlDirectory'] === undefined
      ? {}
      : {
          gitControlDirectory: path.resolve(
            requiredText(item['gitControlDirectory'], 'task gitControlDirectory'),
          ),
        }),
    ...(item['environmentId'] === undefined
      ? {}
      : {
          environmentId: requiredText(item['environmentId'], 'task environmentId'),
        }),
    dependencies: stringList(item['dependencies'], 'task dependencies'),
    ownedPaths: normalizePaths(stringList(item['ownedPaths'], 'task ownedPaths')),
    acceptanceCriteria: stringList(item['acceptanceCriteria'], 'task acceptanceCriteria'),
    ...(supersedes === undefined
      ? {}
      : { supersedes: requiredText(supersedes, 'task supersedes') }),
    ...(integration === undefined ? {} : { integration }),
    ...(validation === undefined ? {} : { validation }),
  };
}

export function parseAgentArtifact(value: unknown): AgentArtifact {
  const item = record(value, 'artifact');
  if (item['schemaVersion'] !== 1) throw new Error('artifact.schemaVersion must be 1');
  const kind = requiredText(item['kind'], 'artifact.kind');
  const artifactType = requiredText(item['artifactType'], 'artifact.artifactType');
  if (artifactType !== kind) throw new Error('artifactType must match artifact.kind');
  const common = {
    schemaVersion: 1 as const,
    taskId: requiredText(item['taskId'], 'artifact.taskId'),
    agent: requiredText(item['agent'], 'artifact.agent'),
    commandId: requiredText(item['commandId'], 'artifact.commandId'),
    generation: Number(item['generation']),
    candidateSha: fullSha(item['candidateSha'], 'artifact.candidateSha'),
    sessionId: requiredText(item['sessionId'], 'artifact.sessionId'),
    idempotencyKey: requiredText(item['idempotencyKey'], 'artifact.idempotencyKey'),
    artifactType: artifactType as ArtifactBinding['artifactType'],
    artifactToken: requiredText(item['artifactToken'], 'artifact.artifactToken'),
  };
  if (!Number.isSafeInteger(common.generation) || common.generation < 0) {
    throw new Error('artifact.generation must be a non-negative integer');
  }
  if (kind === 'BUILDER_RESULT') {
    const status = requiredText(item['status'], 'artifact.status');
    if (!['PASS', 'FAILED', 'BLOCKED'].includes(status))
      throw new Error('builder status is invalid');
    return {
      ...common,
      kind,
      worktree: path.resolve(requiredText(item['worktree'], 'artifact.worktree')),
      branch: requiredText(item['branch'], 'artifact.branch'),
      baseSha: fullSha(item['baseSha'], 'artifact.baseSha'),
      resultSha: fullSha(item['resultSha'], 'artifact.resultSha'),
      status: status as BuilderResultArtifact['status'],
      filesChanged: normalizePaths(stringList(item['filesChanged'], 'artifact.filesChanged')),
      tests: parseTestClaims(item['tests']),
      blockers: stringList(item['blockers'], 'artifact.blockers'),
    };
  }
  if (kind === 'REVIEW_RESULT') {
    const status = requiredText(item['status'], 'artifact.status');
    if (!['PASS', 'CHANGES_REQUIRED', 'BLOCKED'].includes(status)) {
      throw new Error('review status is invalid');
    }
    if (!Array.isArray(item['findings'])) throw new Error('artifact.findings must be an array');
    const findings = item['findings'].map((entry, index): ReviewFinding => {
      const finding = record(entry, `artifact.findings[${String(index)}]`);
      const severity = requiredText(finding['severity'], 'finding.severity');
      if (!['P0', 'P1', 'P2', 'P3'].includes(severity))
        throw new Error('finding severity is invalid');
      const file = finding['file'];
      return {
        severity: severity as ReviewFinding['severity'],
        summary: requiredText(finding['summary'], 'finding.summary'),
        requiredCorrection: requiredText(
          finding['requiredCorrection'],
          'finding.requiredCorrection',
        ),
        ...(file === undefined ? {} : { file: requiredText(file, 'finding.file') }),
      };
    });
    return {
      ...common,
      kind,
      reviewedSha: fullSha(item['reviewedSha'], 'artifact.reviewedSha'),
      candidateTreeSha: fullSha(item['candidateTreeSha'], 'artifact.candidateTreeSha'),
      durableCandidateRef: requiredText(
        item['durableCandidateRef'],
        'artifact.durableCandidateRef',
      ),
      durableStoreGitDirectory: path.resolve(
        requiredText(item['durableStoreGitDirectory'], 'artifact.durableStoreGitDirectory'),
      ),
      reviewMaterializationId: requiredText(
        item['reviewMaterializationId'],
        'artifact.reviewMaterializationId',
      ),
      reviewCheckout: path.resolve(requiredText(item['reviewCheckout'], 'artifact.reviewCheckout')),
      status: status as ReviewResultArtifact['status'],
      findings,
      evidenceInspected: stringList(item['evidenceInspected'], 'artifact.evidenceInspected'),
    };
  }
  if (kind === 'INTEGRATION_RESULT') {
    const status = requiredText(item['status'], 'artifact.status');
    if (!['PASS', 'FAILED', 'BLOCKED'].includes(status))
      throw new Error('integration status is invalid');
    return {
      ...common,
      kind,
      worktree: path.resolve(requiredText(item['worktree'], 'artifact.worktree')),
      branch: requiredText(item['branch'], 'artifact.branch'),
      baseSha: fullSha(item['baseSha'], 'artifact.baseSha'),
      sourceSha: fullSha(item['sourceSha'], 'artifact.sourceSha'),
      resultSha: fullSha(item['resultSha'], 'artifact.resultSha'),
      status: status as IntegrationResultArtifact['status'],
      filesChanged: normalizePaths(stringList(item['filesChanged'], 'artifact.filesChanged')),
      blockers: stringList(item['blockers'], 'artifact.blockers'),
    };
  }
  if (kind === 'VALIDATION_RESULT') {
    const status = requiredText(item['status'], 'artifact.status');
    if (!['PASS', 'FAILED', 'BLOCKED'].includes(status))
      throw new Error('validation status is invalid');
    return {
      ...common,
      kind,
      resultSha: fullSha(item['resultSha'], 'artifact.resultSha'),
      status: status as ValidationResultArtifact['status'],
      evidenceIds: stringList(item['evidenceIds'], 'artifact.evidenceIds'),
      blockers: stringList(item['blockers'], 'artifact.blockers'),
    };
  }
  throw new Error(`unsupported artifact kind: ${kind}`);
}

export function parseReviewSessionEnvironment(value: unknown): ReviewSessionEnvironment {
  const item = record(value, 'reviewEnvironment');
  const generation = item['generation'];
  if (!Number.isSafeInteger(generation) || (generation as number) < 0)
    throw new Error('reviewEnvironment.generation must be a non-negative integer');
  const text = (key: string): string => requiredText(item[key], `reviewEnvironment.${key}`);
  return {
    sessionId: text('sessionId'),
    taskId: text('taskId'),
    generation: generation as number,
    materializationId: text('materializationId'),
    candidateSha: fullSha(item['candidateSha'], 'reviewEnvironment.candidateSha'),
    candidateTreeSha: fullSha(item['candidateTreeSha'], 'reviewEnvironment.candidateTreeSha'),
    durableCandidateRef: text('durableCandidateRef'),
    durableStoreGitDirectory: path.resolve(text('durableStoreGitDirectory')),
    workspace: path.resolve(text('workspace')),
    gitControlDirectory: path.resolve(text('gitControlDirectory')),
  };
}
