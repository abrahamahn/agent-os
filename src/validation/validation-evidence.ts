// src/validation/validation-evidence.ts
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import process from 'node:process';

import { controlPlaneRuntimeChild } from '../control-plane/runtime';

export const VALIDATION_STATES = [
  'QUEUED',
  'RUNNING',
  'PASS',
  'FAIL',
  'ENVIRONMENT_BLOCKED',
  'CANCELLED',
  'REUSED',
] as const;

export type ValidationState = (typeof VALIDATION_STATES)[number];
export type StoredValidationState = Exclude<ValidationState, 'REUSED'>;
export type CompletedValidationState = Extract<
  StoredValidationState,
  'PASS' | 'FAIL' | 'ENVIRONMENT_BLOCKED' | 'CANCELLED'
>;

export interface EvidenceIdentity {
  candidateSha: string;
  checkId: string;
  commandFingerprint: string;
  dependencyFingerprint: string;
  environmentFingerprint: string;
}

export interface EvidenceJob {
  id: string;
  key: string;
  identity: EvidenceIdentity;
  state: StoredValidationState;
  runnerOwner: string;
  subscribers: string[];
  requestedAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  runnerPid?: number;
  summary?: string;
}

export interface EvidenceState {
  version: 1;
  jobs: EvidenceJob[];
}

export type EvidenceRequest =
  | { action: 'RUN'; state: 'QUEUED'; job: EvidenceJob }
  | { action: 'WAIT'; state: 'QUEUED' | 'RUNNING'; job: EvidenceJob }
  | { action: 'REUSE'; state: 'REUSED'; job: EvidenceJob; sourceJobId: string };

export interface EvidenceStoreOptions {
  runtimeDir?: string;
  now?: () => Date;
  idFactory?: () => string;
  lockPollMs?: number;
}

export interface BuildIdentityInput {
  candidateSha: string;
  checkId: string;
  command: readonly string[];
  dependencyFingerprint: string;
  environmentFingerprint?: string;
}

interface LockOwner {
  pid: number;
  acquiredAt: string;
}

const STATE_FILE = 'validation-evidence.json';
const LOCK_DIR = 'validation-evidence.lock';
const LOCK_OWNER_FILE = 'owner.json';
const LOCK_STALE_MS = 30_000;
const DEFAULT_DEPENDENCY_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'turbo.json',
  'tsconfig.json',
  'tsconfig.base.json',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
  'pyproject.toml',
  'uv.lock',
  'poetry.lock',
  'requirements.txt',
  'Gemfile',
  'Gemfile.lock',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
] as const;

function defaultRuntimeDir(): string {
  return controlPlaneRuntimeChild('validation-evidence');
}

function hashParts(parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part)));
    hash.update(':');
    hash.update(part);
  }
  return hash.digest('hex');
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must not be empty`);
  return normalized;
}

function normalizedSha(value: string): string {
  const sha = requiredText(value, 'candidateSha').toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(sha)) {
    throw new Error('candidateSha must be a full 40-64 character hexadecimal object ID');
  }
  return sha;
}

export function fingerprintCommand(command: readonly string[]): string {
  if (command.length === 0) throw new Error('validation command must not be empty');
  return hashParts(command);
}

export function fingerprintEnvironment(
  variableNames: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const names = [
    ...new Set(variableNames.map((name) => requiredText(name, 'environment name'))),
  ].sort();
  if (names.length === 0) return 'portable';
  return hashParts(names.flatMap((name) => [name, environment[name] ?? '<missing>']));
}

function dependencyPath(root: string, input: string): { absolute: string; relative: string } {
  const normalizedRoot = resolve(root);
  const absolute = resolve(normalizedRoot, input);
  const relativePath = relative(normalizedRoot, absolute);
  if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith('../')) {
    throw new Error(`dependency input must stay within the worktree: ${input}`);
  }
  return { absolute, relative: relativePath.replaceAll('\\', '/') };
}

export function fingerprintDependencyFiles(
  root: string,
  inputs: readonly string[] = DEFAULT_DEPENDENCY_FILES,
): string {
  const files = [...new Set(inputs.map((input) => requiredText(input, 'dependency input')))].sort();
  if (files.length === 0) throw new Error('at least one dependency input is required');

  const parts: string[] = [];
  for (const input of files) {
    const file = dependencyPath(root, input);
    parts.push(file.relative);
    try {
      const stat = statSync(file.absolute);
      if (!stat.isFile()) throw new Error(`dependency input is not a regular file: ${input}`);
      parts.push(readFileSync(file.absolute).toString('base64'));
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code !== 'ENOENT') throw error;
      parts.push('<missing>');
    }
  }
  return hashParts(parts);
}

export function buildEvidenceIdentity(input: BuildIdentityInput): EvidenceIdentity {
  return {
    candidateSha: normalizedSha(input.candidateSha),
    checkId: requiredText(input.checkId, 'checkId'),
    commandFingerprint: fingerprintCommand(input.command),
    dependencyFingerprint: requiredText(input.dependencyFingerprint, 'dependencyFingerprint'),
    environmentFingerprint: requiredText(
      input.environmentFingerprint ?? 'portable',
      'environmentFingerprint',
    ),
  };
}

export function evidenceKey(identity: EvidenceIdentity): string {
  return hashParts([
    normalizedSha(identity.candidateSha),
    requiredText(identity.checkId, 'checkId'),
    requiredText(identity.commandFingerprint, 'commandFingerprint'),
    requiredText(identity.dependencyFingerprint, 'dependencyFingerprint'),
    requiredText(identity.environmentFingerprint, 'environmentFingerprint'),
  ]);
}

function emptyState(): EvidenceState {
  return { version: 1, jobs: [] };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function readState(runtimeDir: string): EvidenceState {
  const stateFile = resolve(runtimeDir, STATE_FILE);
  let state: unknown;
  try {
    state = JSON.parse(readFileSync(stateFile, 'utf8')) as unknown;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return emptyState();
    throw new Error(`validation evidence state is unreadable: ${stateFile}`, { cause: error });
  }
  if (
    typeof state !== 'object' ||
    state === null ||
    !('version' in state) ||
    state.version !== 1 ||
    !('jobs' in state) ||
    !Array.isArray(state.jobs)
  ) {
    throw new Error(`validation evidence state has an unsupported schema: ${stateFile}`);
  }
  return state as EvidenceState;
}

function ensureRuntimeDir(runtimeDir: string): void {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
}

function writeState(runtimeDir: string, state: EvidenceState): void {
  const temporary = resolve(runtimeDir, `.evidence-${String(process.pid)}-${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, resolve(runtimeDir, STATE_FILE));
}

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function releaseLock(lockDir: string): void {
  rmSync(resolve(lockDir, LOCK_OWNER_FILE), { force: true });
  try {
    rmdirSync(lockDir);
  } catch {
    // Do not recursively remove an unknown lock directory.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function acquireLock(runtimeDir: string, pollMs: number): Promise<string> {
  ensureRuntimeDir(runtimeDir);
  const lockDir = resolve(runtimeDir, LOCK_DIR);

  for (;;) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      const owner: LockOwner = { pid: process.pid, acquiredAt: new Date().toISOString() };
      writeFileSync(resolve(lockDir, LOCK_OWNER_FILE), `${JSON.stringify(owner)}\n`, {
        mode: 0o600,
      });
      return lockDir;
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code !== 'EEXIST') throw error;

      const owner = readJson(resolve(lockDir, LOCK_OWNER_FILE));
      const ownerPid =
        typeof owner === 'object' &&
        owner !== null &&
        'pid' in owner &&
        typeof owner.pid === 'number'
          ? owner.pid
          : undefined;
      let stale = false;
      try {
        stale = Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS;
      } catch {
        continue;
      }
      if (stale && (ownerPid === undefined || !processExists(ownerPid))) {
        releaseLock(lockDir);
        continue;
      }
      await delay(pollMs);
    }
  }
}

function cloneJob(job: EvidenceJob): EvidenceJob {
  return structuredClone(job);
}

function addSubscriber(job: EvidenceJob, owner: string, now: string): void {
  if (!job.subscribers.includes(owner)) job.subscribers.push(owner);
  job.updatedAt = now;
}

function terminal(state: StoredValidationState): boolean {
  return !['QUEUED', 'RUNNING'].includes(state);
}

export class ValidationEvidenceStore {
  readonly runtimeDir: string;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly lockPollMs: number;

  constructor(options: EvidenceStoreOptions = {}) {
    this.runtimeDir = resolve(
      options.runtimeDir ?? process.env['AGENT_OS_EVIDENCE_DIR'] ?? defaultRuntimeDir(),
    );
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.lockPollMs = options.lockPollMs ?? 25;
  }

  private async withState<T>(operation: (state: EvidenceState) => T): Promise<T> {
    const lockDir = await acquireLock(this.runtimeDir, this.lockPollMs);
    try {
      const state = readState(this.runtimeDir);
      const result = operation(state);
      writeState(this.runtimeDir, state);
      return result;
    } finally {
      releaseLock(lockDir);
    }
  }

  async request(identity: EvidenceIdentity, requestedBy: string): Promise<EvidenceRequest> {
    const owner = requiredText(requestedBy, 'requestedBy');
    const key = evidenceKey(identity);
    const now = this.now().toISOString();

    return this.withState((state) => {
      const matching = state.jobs.filter((job) => job.key === key);
      const passed = matching
        .slice()
        .reverse()
        .find((job) => job.state === 'PASS');
      if (passed !== undefined) {
        addSubscriber(passed, owner, now);
        return { action: 'REUSE', state: 'REUSED', job: cloneJob(passed), sourceJobId: passed.id };
      }

      const active = matching
        .slice()
        .reverse()
        .find((job) => job.state === 'QUEUED' || job.state === 'RUNNING');
      if (active !== undefined) {
        addSubscriber(active, owner, now);
        const activeState = active.state;
        if (activeState !== 'QUEUED' && activeState !== 'RUNNING') {
          throw new Error(`unexpected active validation state: ${activeState}`);
        }
        return { action: 'WAIT', state: activeState, job: cloneJob(active) };
      }

      const job: EvidenceJob = {
        id: this.idFactory(),
        key,
        identity: structuredClone(identity),
        state: 'QUEUED',
        runnerOwner: owner,
        subscribers: [owner],
        requestedAt: now,
        updatedAt: now,
      };
      state.jobs.push(job);
      return { action: 'RUN', state: 'QUEUED', job: cloneJob(job) };
    });
  }

  async start(jobId: string, runnerOwner: string, runnerPid = process.pid): Promise<EvidenceJob> {
    const id = requiredText(jobId, 'jobId');
    const owner = requiredText(runnerOwner, 'runnerOwner');
    if (!Number.isSafeInteger(runnerPid) || runnerPid <= 0) {
      throw new Error('runnerPid must be a positive integer');
    }

    return this.withState((state) => {
      const job = state.jobs.find((candidate) => candidate.id === id);
      if (job === undefined) throw new Error(`unknown validation evidence job: ${id}`);
      if (job.runnerOwner !== owner) {
        throw new Error(`validation job ${id} is reserved for ${job.runnerOwner}`);
      }
      if (job.state === 'RUNNING') return cloneJob(job);
      if (job.state !== 'QUEUED') throw new Error(`cannot start validation job in ${job.state}`);

      const now = this.now().toISOString();
      job.state = 'RUNNING';
      job.runnerPid = runnerPid;
      job.startedAt = now;
      job.updatedAt = now;
      return cloneJob(job);
    });
  }

  async complete(
    jobId: string,
    result: { state: CompletedValidationState; summary?: string },
  ): Promise<EvidenceJob> {
    if (result.state === 'CANCELLED') return this.cancel(jobId, result.summary);
    const summary = result.summary?.trim();

    return this.withState((state) => {
      const job = state.jobs.find((candidate) => candidate.id === jobId);
      if (job === undefined) throw new Error(`unknown validation evidence job: ${jobId}`);
      if (terminal(job.state)) {
        if (job.state === result.state && job.summary === summary) return cloneJob(job);
        throw new Error(`validation job ${jobId} already completed as ${job.state}`);
      }
      if (job.state !== 'RUNNING')
        throw new Error(`cannot complete validation job in ${job.state}`);

      const now = this.now().toISOString();
      job.state = result.state;
      job.updatedAt = now;
      job.finishedAt = now;
      if (summary !== undefined && summary.length > 0) job.summary = summary;
      return cloneJob(job);
    });
  }

  async cancel(jobId: string, summary?: string): Promise<EvidenceJob> {
    const normalizedSummary = summary?.trim();
    return this.withState((state) => {
      const job = state.jobs.find((candidate) => candidate.id === jobId);
      if (job === undefined) throw new Error(`unknown validation evidence job: ${jobId}`);
      if (job.state === 'CANCELLED') return cloneJob(job);
      if (terminal(job.state))
        throw new Error(`validation job ${jobId} already completed as ${job.state}`);

      const now = this.now().toISOString();
      job.state = 'CANCELLED';
      job.updatedAt = now;
      job.finishedAt = now;
      if (normalizedSummary !== undefined && normalizedSummary.length > 0) {
        job.summary = normalizedSummary;
      }
      return cloneJob(job);
    });
  }

  async job(jobId: string): Promise<EvidenceJob | undefined> {
    const state = await this.snapshot();
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    return job === undefined ? undefined : cloneJob(job);
  }

  async jobsFor(identity: EvidenceIdentity): Promise<EvidenceJob[]> {
    const key = evidenceKey(identity);
    const state = await this.snapshot();
    return state.jobs.filter((job) => job.key === key).map(cloneJob);
  }

  async snapshot(): Promise<EvidenceState> {
    return this.withState((state) => structuredClone(state));
  }

  async wait(jobId: string, timeoutMs: number, pollMs = 100): Promise<EvidenceJob> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
      throw new Error('timeoutMs must be non-negative');
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await this.job(jobId);
      if (job === undefined) throw new Error(`unknown validation evidence job: ${jobId}`);
      if (terminal(job.state)) return job;
      if (Date.now() >= deadline) return job;
      await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
  }
}
