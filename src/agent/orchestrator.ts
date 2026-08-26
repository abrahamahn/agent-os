// src/agent/orchestrator.ts
import { execFile } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { ValidationEvidenceStore } from '../validation/validation-evidence';

import { controllerRoot, ensureControllerRuntimeDirectory } from './controller-runtime';
import { HostValidationRunner } from './host-validation';
import { captureGitCandidate, parseWorkerEnvironment } from './worker-workspace';

import type { CapturedCandidate, WorkerEnvironmentCapabilities } from './worker-workspace';

export const TASK_STATUSES = [
  'READY',
  'DISPATCHED',
  'WORKING',
  'READY_FOR_REVIEW',
  'REVIEWING',
  'REVIEW_RETRYABLE',
  'CHANGES_REQUIRED',
  'BLOCKED',
  'REVIEW_PASS',
  'READY_FOR_INTEGRATION',
  'INTEGRATING',
  'VALIDATING',
  'ACCEPTED',
  'SUPERSEDED',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type AgentLifecycle =
  | 'IDLE'
  | 'DISPATCHED'
  | 'WORKING'
  | 'REVIEWING'
  | 'INTEGRATING'
  | 'VALIDATING'
  | 'BLOCKED'
  | 'OFFLINE';
export type CommandKind = 'BUILD' | 'REVIEW' | 'CORRECTION' | 'INTEGRATE' | 'VALIDATE';
export type CommandStatus = 'PENDING' | 'CLAIMED' | 'COMPLETED' | 'CANCELLED';

export interface ValidationRequirement {
  readonly checkId: string;
  readonly resource: 'medium' | 'heavy';
  readonly command: readonly string[];
  readonly environmentFingerprint?: string;
}

export interface TaskContract {
  readonly id: string;
  readonly cycle: string;
  readonly title: string;
  readonly priority: number;
  readonly ownerAgent: string;
  readonly reviewerAgent: string;
  readonly worktree: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly gitControlDirectory?: string;
  readonly environmentId?: string;
  readonly dependencies: readonly string[];
  readonly ownedPaths: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly supersedes?: string;
  readonly integration?: {
    readonly agent: string;
    readonly worktree: string;
    readonly branch: string;
    readonly gitControlDirectory?: string;
  };
  readonly validation?: {
    readonly agent: string;
    readonly checks: readonly ValidationRequirement[];
  };
}

export interface TaskRecord extends TaskContract {
  status: TaskStatus;
  generation: number;
  candidateSha?: string;
  acceptedSha?: string;
  blocker?: string;
  capturedCandidate?: CapturedCandidate;
  reviewMaterialization?: ReviewMaterialization;
  negativeReviewShas: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ReviewMaterialization {
  readonly id: string;
  readonly taskId: string;
  readonly generation: number;
  readonly candidateSha: string;
  readonly candidateTreeSha: string;
  readonly durableCandidateRef: string;
  readonly durableStoreGitDirectory: string;
  readonly checkout: string;
  readonly gitControlDirectory: string;
  readonly createdAt: string;
}

export interface ReviewExecutionBinding {
  readonly taskId: string;
  readonly generation: number;
  readonly commandId: string;
  readonly reviewerAgent: string;
  readonly reviewerSessionId: string;
  readonly candidateSha: string;
  readonly candidateTreeSha: string;
  readonly durableCandidateRef: string;
  readonly durableStoreGitDirectory: string;
  readonly materializationId: string;
  readonly reviewCheckout: string;
  readonly gitControlDirectory: string;
}

export interface ReviewSessionEnvironment {
  readonly sessionId: string;
  readonly taskId: string;
  readonly generation: number;
  readonly materializationId: string;
  readonly candidateSha: string;
  readonly candidateTreeSha: string;
  readonly durableCandidateRef: string;
  readonly durableStoreGitDirectory: string;
  readonly workspace: string;
  readonly gitControlDirectory: string;
}

export interface AgentRecord {
  id: string;
  role: string;
  lifecycle: AgentLifecycle;
  currentTask?: string;
  pid?: number;
  processStartTicks?: string;
  sessionId?: string;
  environment?: WorkerEnvironmentCapabilities;
  reviewEnvironment?: ReviewSessionEnvironment;
  lastHeartbeatAt?: string;
  updatedAt: string;
}

export interface AgentCommand {
  id: string;
  taskId: string;
  agent: string;
  kind: CommandKind;
  status: CommandStatus;
  generation: number;
  sessionId: string;
  artifactToken: string;
  prompt: string;
  createdAt: string;
  claimedAt?: string;
  completedAt?: string;
  reviewBinding?: ReviewExecutionBinding;
}

interface ArtifactBinding {
  readonly commandId: string;
  readonly generation: number;
  readonly candidateSha: string;
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly artifactType:
    'BUILDER_RESULT' | 'REVIEW_RESULT' | 'INTEGRATION_RESULT' | 'VALIDATION_RESULT';
  readonly artifactToken: string;
}

export interface TestEvidenceClaim {
  readonly checkId: string;
  readonly status: 'PASS' | 'FAIL' | 'ENVIRONMENT_BLOCKED';
  readonly command: readonly string[];
  readonly evidenceId?: string;
}

export interface BuilderResultArtifact extends ArtifactBinding {
  readonly schemaVersion: 1;
  readonly kind: 'BUILDER_RESULT';
  readonly taskId: string;
  readonly agent: string;
  readonly worktree: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly resultSha: string;
  readonly status: 'PASS' | 'FAILED' | 'BLOCKED';
  readonly filesChanged: readonly string[];
  readonly tests: readonly TestEvidenceClaim[];
  readonly blockers: readonly string[];
}

export interface ReviewFinding {
  readonly severity: 'P0' | 'P1' | 'P2' | 'P3';
  readonly summary: string;
  readonly requiredCorrection: string;
  readonly file?: string;
}

export interface ReviewResultArtifact extends ArtifactBinding {
  readonly schemaVersion: 1;
  readonly kind: 'REVIEW_RESULT';
  readonly taskId: string;
  readonly agent: string;
  readonly reviewedSha: string;
  readonly candidateTreeSha: string;
  readonly durableCandidateRef: string;
  readonly durableStoreGitDirectory: string;
  readonly reviewMaterializationId: string;
  readonly reviewCheckout: string;
  readonly status: 'PASS' | 'CHANGES_REQUIRED' | 'BLOCKED';
  readonly findings: readonly ReviewFinding[];
  readonly evidenceInspected: readonly string[];
}

export interface IntegrationResultArtifact extends ArtifactBinding {
  readonly schemaVersion: 1;
  readonly kind: 'INTEGRATION_RESULT';
  readonly taskId: string;
  readonly agent: string;
  readonly worktree: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly sourceSha: string;
  readonly resultSha: string;
  readonly status: 'PASS' | 'FAILED' | 'BLOCKED';
  readonly filesChanged: readonly string[];
  readonly blockers: readonly string[];
}

export interface ValidationResultArtifact extends ArtifactBinding {
  readonly schemaVersion: 1;
  readonly kind: 'VALIDATION_RESULT';
  readonly taskId: string;
  readonly agent: string;
  readonly resultSha: string;
  readonly status: 'PASS' | 'FAILED' | 'BLOCKED';
  readonly evidenceIds: readonly string[];
  readonly blockers: readonly string[];
}

export type AgentArtifact =
  | BuilderResultArtifact
  | ReviewResultArtifact
  | IntegrationResultArtifact
  | ValidationResultArtifact;

export interface StoredArtifact {
  id: string;
  sequence?: number;
  artifact: AgentArtifact;
  taskGeneration?: number;
  verification: 'ACCEPTED' | 'REJECTED';
  verificationErrors: string[];
  receivedAt: string;
  supersededAt?: string;
  supersededReason?: string;
}

export interface IntegrationEntry {
  taskId: string;
  sourceSha: string;
  candidateSha: string;
  reviewArtifactId: string;
  reviewedSha: string;
  reviewSequence: number;
  reviewGeneration: number;
  reviewer: string;
  reviewVerdict: 'PASS';
  reviewedAt: string;
  reviewSupersessionState: 'CURRENT' | 'SUPERSEDED';
  candidateTreeSha: string;
  durableCandidateRef: string;
  expectedPredecessorSha: string;
  dependencies: string[];
  status: 'QUEUED' | 'INTEGRATING' | 'VALIDATING' | 'ACCEPTED' | 'SUPERSEDED' | 'REMOVED';
  queuedAt: string;
  resultSha?: string;
  failureCode?: 'REVIEW_STATE_CONFLICT' | 'REVIEW_INVALIDATED' | 'INTEGRATION_OUTCOME_UNKNOWN';
}

export interface OrchestrationEvent {
  sequence: number;
  at: string;
  type: string;
  taskId?: string;
  agent?: string;
  detail: string;
}

export interface OrchestrationState {
  version: 1;
  sequence: number;
  cycle: string;
  integratedSha?: string;
  tasks: TaskRecord[];
  agents: AgentRecord[];
  commands: AgentCommand[];
  artifacts: StoredArtifact[];
  integrationQueue: IntegrationEntry[];
  events: OrchestrationEvent[];
  lastBriefSequence: number;
  updatedAt: string;
}

export interface ReconcileResult {
  changed: boolean;
  commandsCreated: AgentCommand[];
  events: OrchestrationEvent[];
}

interface GitCandidate {
  readonly worktree: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly resultSha: string;
  readonly filesChanged: readonly string[];
  readonly previousSha?: string;
  readonly gitControlDirectory?: string;
}

export interface ReviewTruth {
  eligible: boolean;
  conflict: boolean;
  invalidated?: boolean;
  code?: 'REVIEW_STATE_CONFLICT' | 'REVIEW_INVALIDATED';
  reason: string;
  reviewArtifactId?: string;
  reviewedSha?: string;
  reviewSequence?: number;
  reviewGeneration?: number;
  reviewer?: string;
  verdict?: ReviewResultArtifact['status'];
  reviewedAt?: string;
  supersessionState?: 'CURRENT';
}

interface EvidenceRecord {
  readonly state: string;
  readonly identity: {
    readonly candidateSha: string;
    readonly checkId: string;
    readonly environmentFingerprint?: string;
  };
}

export interface OrchestratorOptions {
  runtimeDir?: string;
  now?: () => Date;
  idFactory?: () => string;
  lockPollMs?: number;
  evidenceLookup?: (id: string) => Promise<EvidenceRecord | undefined>;
  allowUnsafeTestRuntime?: boolean;
}

const STATE_FILE = 'orchestration-state.json';
const LOCK_DIRECTORY = 'orchestration.lock';
const LOCK_OWNER_FILE = 'owner.json';
const LOCK_STALE_MS = 30_000;
const EVENT_HISTORY_LIMIT = 2_000;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/u;
const execFileAsync = promisify(execFile);

function defaultRuntimeDirectory(): string {
  return controllerRoot();
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function fullSha(value: unknown, label: string): string {
  const sha = requiredText(value, label).toLowerCase();
  if (!SHA_PATTERN.test(sha)) throw new Error(`${label} must be a full hexadecimal commit SHA`);
  return sha;
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const result = value.map((entry, index) => requiredText(entry, `${label}[${String(index)}]`));
  if (new Set(result).size !== result.length)
    throw new Error(`${label} must not contain duplicates`);
  return result;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function normalizePaths(values: readonly string[]): string[] {
  return [
    ...new Set(values.map((value) => value.replaceAll('\\', '/').replace(/^\.\//u, ''))),
  ].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function sameSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function processStartTicks(pid: number): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = await fs.readFile(`/proc/${String(pid)}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19];
  } catch {
    return undefined;
  }
}

async function sameProcess(pid: number, expectedStart?: string): Promise<boolean> {
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

async function trustedDirectory(value: string, label: string): Promise<string> {
  const resolved = path.resolve(value);
  const real = await fs.realpath(resolved);
  const status = await fs.lstat(resolved);
  if (real !== resolved || !status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory, not a symlink`);
  }
  return real;
}

function emptyState(now: string, cycle = 'UNASSIGNED'): OrchestrationState {
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

function validateState(value: unknown, statePath: string): OrchestrationState {
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

async function readState(runtimeDir: string, now: string): Promise<OrchestrationState> {
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

async function ensureRuntimeDirectory(
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

async function writeState(runtimeDir: string, state: OrchestrationState): Promise<void> {
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

async function releaseLock(lockDirectory: string): Promise<void> {
  await fs.rm(path.join(lockDirectory, LOCK_OWNER_FILE), { force: true });
  try {
    await fs.rmdir(lockDirectory);
  } catch {
    // Never recursively delete an unknown lock directory.
  }
}

async function acquireLock(
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

function activeTask(status: TaskStatus): boolean {
  return !['READY', 'BLOCKED', 'REVIEW_RETRYABLE', 'ACCEPTED', 'SUPERSEDED'].includes(status);
}

function parseReviewSessionEnvironment(value: unknown): ReviewSessionEnvironment {
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

function commandIsActiveIntegration(command: AgentCommand): boolean {
  return (
    command.kind === 'INTEGRATE' && (command.status === 'PENDING' || command.status === 'CLAIMED')
  );
}

function pathsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((leftPath) =>
    right.some(
      (rightPath) =>
        leftPath === rightPath ||
        leftPath.startsWith(`${rightPath}/`) ||
        rightPath.startsWith(`${leftPath}/`),
    ),
  );
}

function taskById(state: OrchestrationState, taskId: string): TaskRecord {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (task === undefined) throw new Error(`Unknown Agent OS task: ${taskId}`);
  return task;
}

function agentById(state: OrchestrationState, agentId: string): AgentRecord {
  const agent = state.agents.find((candidate) => candidate.id === agentId);
  if (agent === undefined) throw new Error(`Unknown Agent OS agent: ${agentId}`);
  return agent;
}

function ensureAgent(
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

function addEvent(
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

function completeCommand(state: OrchestrationState, commandId: string, now: string): void {
  const command = state.commands.find((candidate) => candidate.id === commandId);
  if (command === undefined || command.status !== 'CLAIMED') {
    throw new Error('cannot complete an unclaimed command');
  }
  command.status = 'COMPLETED';
  command.completedAt = now;
}

function releaseAgent(state: OrchestrationState, agentId: string, now: string): void {
  const agent = agentById(state, agentId);
  agent.lifecycle = 'IDLE';
  delete agent.currentTask;
  agent.updatedAt = now;
}

function invalidateIntegrationForReview(
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

function acceptedReviews(state: OrchestrationState, taskId: string): StoredArtifact[] {
  return state.artifacts.filter(
    (stored) =>
      stored.verification === 'ACCEPTED' &&
      stored.supersededAt === undefined &&
      stored.artifact.kind === 'REVIEW_RESULT' &&
      stored.artifact.taskId === taskId,
  );
}

function reviewBindingError(
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

function integrationBindingMatches(
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

function integrationEntryFromReview(
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

async function git(
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

async function materializeReviewCandidate(
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

async function verifyReviewMaterialization(
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

async function verifyRegisteredReviewMaterialization(task: TaskRecord): Promise<string[]> {
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

async function verifyReviewSessionEnvironment(
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

async function verifyGitCandidate(candidate: GitCandidate): Promise<string[]> {
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

async function capturedCandidateExists(task: TaskRecord, runtimeDir: string): Promise<boolean> {
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

function buildPrompt(task: TaskRecord): string {
  return `TASK ${task.id} — ${task.title}\nBase: ${task.baseSha}\nBranch: ${task.branch}\nWorktree: ${task.worktree}\nAcceptance:\n${task.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n')}\nStop by submitting a BUILDER_RESULT artifact with the exact committed SHA and evidence.`;
}

function reviewPrompt(task: TaskRecord): string {
  const materialization = task.reviewMaterialization;
  return `REVIEW ${task.id} at exact SHA ${task.candidateSha ?? '(missing)'}\nController materialization: ${materialization?.checkout ?? '(missing)'}\nMaterialization ID: ${materialization?.id ?? '(missing)'}\nCandidate tree: ${materialization?.candidateTreeSha ?? '(missing)'}\nDurable ref: ${materialization?.durableCandidateRef ?? '(missing)'}\nDurable store: ${materialization?.durableStoreGitDirectory ?? '(missing)'}\nInspect only the controller materialization and verify HEAD/tree before review. If it is unavailable or mismatched, submit no verdict and report candidate-unavailable. Submit REVIEW_RESULT with PASS, CHANGES_REQUIRED, or BLOCKED only after exact materialization is verified. Do not review a different SHA.`;
}

function integrationPrompt(state: OrchestrationState, task: TaskRecord): string {
  const captured = task.capturedCandidate;
  return `INTEGRATE ${task.id}\nAccepted source SHA: ${task.candidateSha ?? '(missing)'}\nDurable object store: ${captured?.storeGitDirectory ?? '(missing)'}\nDurable candidate ref: ${captured?.ref ?? '(missing)'}\nAccepted predecessor SHA: ${state.integratedSha ?? task.baseSha}\nPreserve dependency order: ${task.dependencies.join(', ') || 'none'}\nFetch only from the durable controller store and submit INTEGRATION_RESULT from the configured integration worktree; finish order does not override this order.`;
}

function validationPrompt(task: TaskRecord, resultSha: string): string {
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
