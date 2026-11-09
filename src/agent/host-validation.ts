// src/agent/host-validation.ts
import { execFile, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { controllerRoot, ensureControllerRuntimeDirectory } from './controller-runtime';
import {
  dependencyBootstrapCommand,
  dependencyBootstrapEnvironment,
  dependencyPreparationIdentity,
  disposeProductValidationScratch,
  isRecord,
  prepareProductValidationScratch,
  productExecutionEnvironment,
  productExecutionIdentity,
  sandboxedHostCommand,
} from './host-validation-policy';
import { ResourceScheduler } from './resource-scheduler';
import { loadValidationProfile } from './validation-profile';
import { parseWorkerEnvironment } from './worker-workspace';

import type {
  BootstrapToolIdentity,
  HostValidationCheckId,
  HostValidationEnvironmentRegistration,
  HostValidationJob,
  HostValidationPolicy,
  HostValidationRequest,
  HostValidationRunnerOptions,
  HostValidationState,
} from './host-validation-types';
import type { RunRequest } from './resource-scheduler';
import type { ValidationServiceProfile } from './validation-profile';

const STATE_FILE = 'host-validation.json';
const LOCK_DIRECTORY = 'host-validation.lock';
const LOCK_OWNER_FILE = 'owner.json';
const LOCK_STALE_MS = 30_000;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/u;
const execFileAsync = promisify(execFile);

function defaultRuntimeDirectory(): string {
  return path.join(controllerRoot(), 'host-validation');
}

function defaultAllowedWorktreeRoots(): string[] {
  const roots = ['/tmp/agent-os-worker-workspaces'];
  const configured = process.env['AGENT_OS_ALLOWED_WORKTREE_ROOTS'];
  if (configured !== undefined) {
    roots.push(...configured.split(path.delimiter).filter((entry) => entry.trim().length > 0));
  }
  const repository = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  });
  if (repository.status === 0 && repository.stdout.trim().length > 0) {
    roots.push(repository.stdout.trim());
  }
  return roots;
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must not be empty`);
  return normalized;
}

function recordText(value: Record<string, unknown>, key: string, label: string): string {
  const candidate = value[key];
  if (typeof candidate !== 'string') throw new Error(`${label} must be text`);
  return requiredText(candidate, label);
}

function fullSha(value: string): string {
  const normalized = requiredText(value, 'candidateSha').toLowerCase();
  if (!SHA_PATTERN.test(normalized)) throw new Error('candidateSha must be a full commit SHA');
  return normalized;
}

function isCheckId(
  value: string,
  policies: Readonly<Record<string, HostValidationPolicy>>,
): value is HostValidationCheckId {
  return Object.hasOwn(policies, value);
}

function parseHostValidationRegistration(
  input: unknown,
  policies: Readonly<Record<string, HostValidationPolicy>>,
): HostValidationEnvironmentRegistration {
  if (!isRecord(input) || input['schemaVersion'] !== 1) {
    throw new Error('host-validation registration has an unsupported schema');
  }
  const generation = input['generation'];
  const allowedChecks = input['allowedChecks'];
  const eligibility = input['eligibility'];
  if (!Number.isSafeInteger(generation) || Number(generation) < 0) {
    throw new Error('host-validation registration has an invalid generation');
  }
  if (
    !Array.isArray(allowedChecks) ||
    allowedChecks.length === 0 ||
    !allowedChecks.every((check) => isCheckId(check, policies)) ||
    new Set(allowedChecks).size !== allowedChecks.length ||
    eligibility !== 'READY_FOR_VALIDATION'
  ) {
    throw new Error('host-validation registration has invalid eligibility or checks');
  }
  const gitControlDirectory = input['gitControlDirectory'];
  if (gitControlDirectory !== undefined && typeof gitControlDirectory !== 'string') {
    throw new Error('host-validation registration has an invalid Git control directory');
  }
  return {
    schemaVersion: 1,
    taskId: recordText(input, 'taskId', 'taskId'),
    generation: Number(generation),
    requestedBy: recordText(input, 'requestedBy', 'requestedBy'),
    worktree: recordText(input, 'worktree', 'worktree'),
    ...(gitControlDirectory === undefined ? {} : { gitControlDirectory }),
    candidateSha: fullSha(recordText(input, 'candidateSha', 'candidateSha')),
    treeSha: fullSha(recordText(input, 'treeSha', 'treeSha')),
    allowedChecks,
    eligibility,
    environment: parseWorkerEnvironment(input['environment']),
    registeredAt: recordText(input, 'registeredAt', 'registeredAt'),
  };
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isCodexSandbox(environment: NodeJS.ProcessEnv): boolean {
  if (environment['CODEX_SANDBOX_NETWORK_DISABLED'] !== undefined) return true;
  const profile = environment['CODEX_PERMISSION_PROFILE'];
  return profile?.includes('"network":"restricted"') === true;
}

function requestKey(
  request: HostValidationRequest,
  policy: HostValidationPolicy,
  dependencyPreparationKey: string,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        candidateSha: request.candidateSha,
        checkId: request.checkId,
        command: policy.command,
        environment: request.environment,
        dependencyPreparationKey,
      }),
    )
    .digest('hex');
}

function validationEnvironmentFingerprint(productEnvironmentFingerprint: string): string {
  return productEnvironmentFingerprint;
}

function normalizedRequest(
  input: unknown,
  policies: Readonly<Record<string, HostValidationPolicy>>,
): HostValidationRequest {
  if (!isRecord(input) || input['schemaVersion'] !== 1)
    throw new Error('host validation schemaVersion must be 1');
  const checkId = recordText(input, 'checkId', 'checkId');
  if (!isCheckId(checkId, policies)) {
    throw new Error(`unsupported host validation check: ${checkId}`);
  }
  const environment = parseWorkerEnvironment(input['environment']);
  const rawGitControlDirectory = input['gitControlDirectory'];
  if (rawGitControlDirectory !== undefined && typeof rawGitControlDirectory !== 'string') {
    throw new Error('gitControlDirectory must be text');
  }
  const request: HostValidationRequest = {
    schemaVersion: 1,
    taskId: recordText(input, 'taskId', 'taskId'),
    generation: Number(input['generation']),
    requestedBy: recordText(input, 'requestedBy', 'requestedBy'),
    checkId,
    candidateSha: fullSha(recordText(input, 'candidateSha', 'candidateSha')),
    worktree: path.resolve(recordText(input, 'worktree', 'worktree')),
    ...(rawGitControlDirectory === undefined
      ? {}
      : {
          gitControlDirectory: path.resolve(
            requiredText(rawGitControlDirectory, 'gitControlDirectory'),
          ),
        }),
    environment,
  };
  if (!Number.isSafeInteger(request.generation) || request.generation < 0) {
    throw new Error('host validation generation must be a non-negative integer');
  }
  if (request.environment.workspace !== request.worktree) {
    throw new Error('host validation worktree does not match its execution environment');
  }
  if (
    request.gitControlDirectory !== undefined &&
    request.environment.gitControlDirectory !== request.gitControlDirectory
  ) {
    throw new Error('host validation Git control directory does not match its environment');
  }
  return request;
}

async function acquireLock(runtimeDir: string, allowUnsafeTestRuntime: boolean): Promise<string> {
  await ensureControllerRuntimeDirectory(runtimeDir, {
    allowUnsafeTestRuntime,
  });
  const lock = path.join(runtimeDir, LOCK_DIRECTORY);
  for (;;) {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      await fs.writeFile(
        path.join(lock, LOCK_OWNER_FILE),
        `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
        { mode: 0o600 },
      );
      return lock;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const age = Date.now() - (await fs.stat(lock)).mtimeMs;
      if (age > LOCK_STALE_MS) {
        let ownerAlive = false;
        try {
          const owner = JSON.parse(await fs.readFile(path.join(lock, LOCK_OWNER_FILE), 'utf8')) as {
            pid?: number;
          };
          if (typeof owner.pid === 'number') {
            try {
              process.kill(owner.pid, 0);
              ownerAlive = true;
            } catch {
              ownerAlive = false;
            }
          }
        } catch {
          ownerAlive = false;
        }
        if (!ownerAlive) {
          await fs.unlink(path.join(lock, LOCK_OWNER_FILE)).catch(() => undefined);
          await fs.rmdir(lock).catch(() => undefined);
          continue;
        }
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
}

async function readState(runtimeDir: string): Promise<HostValidationState> {
  const statePath = path.join(runtimeDir, STATE_FILE);
  try {
    const state = JSON.parse(await fs.readFile(statePath, 'utf8')) as unknown;
    if (
      typeof state !== 'object' ||
      state === null ||
      !('version' in state) ||
      state.version !== 1 ||
      !('jobs' in state) ||
      !Array.isArray(state.jobs)
    ) {
      throw new Error(`host validation state has an unsupported schema: ${statePath}`);
    }
    const normalizedJobs = (state.jobs as unknown[]).map((job) => {
      if (typeof job === 'object' && job !== null && !Object.hasOwn(job, 'productExecutionKey')) {
        return { ...job, productExecutionKey: 'LEGACY_UNTRUSTED' };
      }
      return job;
    }) as HostValidationJob[];
    state.jobs = normalizedJobs;
    if (
      normalizedJobs.some((job) => {
        const entry = job as Partial<HostValidationJob> | null;
        return (
          entry === null ||
          typeof entry !== 'object' ||
          !Number.isSafeInteger(entry.attempt) ||
          !Number.isSafeInteger(entry.generation) ||
          typeof entry.environmentFingerprint !== 'string' ||
          typeof entry.productExecutionKey !== 'string' ||
          typeof entry.candidateSha !== 'string' ||
          (entry.status === 'RUNNING' && typeof entry.leaseToken !== 'string')
        );
      })
    ) {
      throw new Error(`host validation state lacks trusted lease/evidence fields: ${statePath}`);
    }
    return state as HostValidationState;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { version: 1, jobs: [] };
    }
    if (error instanceof SyntaxError) {
      throw new Error(`host validation state is unreadable: ${statePath}`, {
        cause: error,
      });
    }
    throw error;
  }
}

async function writeState(runtimeDir: string, state: HostValidationState): Promise<void> {
  const target = path.join(runtimeDir, STATE_FILE);
  const temporary = `${target}.${String(process.pid)}-${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, target);
  const directory = await fs.open(runtimeDir, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function withState<T>(
  runtimeDir: string,
  allowUnsafeTestRuntime: boolean,
  operation: (state: HostValidationState) => T | Promise<T>,
): Promise<T> {
  const lock = await acquireLock(runtimeDir, allowUnsafeTestRuntime);
  try {
    const state = await readState(runtimeDir);
    const result = await operation(state);
    await writeState(runtimeDir, state);
    return result;
  } finally {
    await fs.unlink(path.join(lock, LOCK_OWNER_FILE)).catch(() => undefined);
    await fs.rmdir(lock).catch(() => undefined);
  }
}

async function git(
  worktree: string,
  gitControlDirectory: string | undefined,
  argumentsToGit: readonly string[],
): Promise<string> {
  const environment =
    gitControlDirectory === undefined
      ? process.env
      : {
          ...process.env,
          GIT_DIR: gitControlDirectory,
          GIT_WORK_TREE: worktree,
        };
  const result = await execFileAsync('git', [...argumentsToGit], {
    cwd: worktree,
    env: environment,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function defaultProbe(
  serviceId: string,
  services: Readonly<Record<string, ValidationServiceProfile>>,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  const service = services[serviceId];
  if (service === undefined) return false;
  const configuredPort =
    service.portEnvironment === undefined ? undefined : environment[service.portEnvironment];
  const port = Number(configuredPort ?? service.defaultPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return false;
  return new Promise((resolveProbe) => {
    const socket = net.createConnection({ host: service.host, port });
    const finish = (available: boolean): void => {
      socket.destroy();
      resolveProbe(available);
    };
    socket.setTimeout(1_500);
    socket.once('connect', () => {
      finish(true);
    });
    socket.once('timeout', () => {
      finish(false);
    });
    socket.once('error', () => {
      finish(false);
    });
  });
}

export class HostValidationRunner {
  readonly runtimeDir: string;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly hostEnvironment: NodeJS.ProcessEnv;
  private readonly allowedWorktreeRoots: string[];
  private readonly verifyCandidate: (request: HostValidationRequest) => Promise<void>;
  private readonly probeService: (service: string) => Promise<boolean>;
  private readonly execute: (input: {
    request: HostValidationRequest;
    policy: HostValidationPolicy;
    dependencyPreparationKey: string;
    productExecutionKey: string;
    productEnvironment: Record<string, string>;
  }) => Promise<{
    exitCode: number;
    resourceJobId?: string;
    infrastructureFailure?: string;
  }>;
  private readonly leaseMs: number;
  private readonly allowUnsafeTestRuntime: boolean;
  private readonly bootstrapToolIdentity: BootstrapToolIdentity | undefined;
  private readonly bootstrapCommand: readonly string[];
  private readonly bootstrapEnvironment: Readonly<Record<string, string>>;
  private readonly dependencyFiles: readonly string[];
  private readonly scratchPaths: readonly string[];
  private readonly resourceAgent: string;
  private readonly policies: Readonly<Record<string, HostValidationPolicy>>;
  private readonly environmentNames: readonly string[];
  private readonly services: Readonly<Record<string, ValidationServiceProfile>>;

  constructor(options: HostValidationRunnerOptions = {}) {
    const profile = loadValidationProfile();
    this.runtimeDir = path.resolve(options.runtimeDir ?? defaultRuntimeDirectory());
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.hostEnvironment = options.hostEnvironment ?? process.env;
    this.bootstrapToolIdentity = options.bootstrapToolIdentity;
    this.bootstrapCommand = options.bootstrapCommand ?? profile.bootstrap.command;
    this.bootstrapEnvironment = options.bootstrapEnvironment ?? profile.bootstrap.environment;
    this.dependencyFiles = options.dependencyFiles ?? profile.bootstrap.dependencyFiles;
    this.scratchPaths = options.scratchPaths ?? profile.scratchPaths;
    this.policies = options.policies ?? profile.checks;
    this.environmentNames = options.environmentNames ?? profile.environmentNames;
    this.services = options.services ?? profile.services;
    this.resourceAgent = requiredText(
      options.resourceAgent ?? process.env['AGENT_OS_VALIDATION_RUNNER_ID'] ?? 'A11',
      'host validation resource agent',
    );
    this.allowedWorktreeRoots = (options.allowedWorktreeRoots ?? defaultAllowedWorktreeRoots()).map(
      (root) => path.resolve(root),
    );
    this.leaseMs = options.leaseMs ?? 60 * 60_000;
    this.allowUnsafeTestRuntime = options.allowUnsafeTestRuntime === true;
    this.verifyCandidate =
      options.verifyCandidate ??
      (async (request) => {
        const realWorktree = await fs.realpath(request.worktree);
        if (realWorktree !== request.worktree) {
          throw new Error('host validation worktree must not use a symlink alias');
        }
        const realRoots = await Promise.all(
          this.allowedWorktreeRoots.map((root) => fs.realpath(root).catch(() => undefined)),
        );
        if (!realRoots.some((root) => root !== undefined && isWithin(realWorktree, root))) {
          throw new Error(
            `worktree is outside approved host-validation roots: ${request.worktree}`,
          );
        }
        const head = (
          await git(request.worktree, request.gitControlDirectory, ['rev-parse', 'HEAD'])
        ).toLowerCase();
        if (head !== request.candidateSha) {
          throw new Error(`host validation candidate is ${head}, expected ${request.candidateSha}`);
        }
        const tree = (
          await git(request.worktree, request.gitControlDirectory, [
            'rev-parse',
            `${request.candidateSha}^{tree}`,
          ])
        ).toLowerCase();
        const registration = await this.registeredEnvironment(
          request.taskId,
          request.generation,
          request.candidateSha,
        );
        if (
          registration.requestedBy !== request.requestedBy ||
          registration.worktree !== request.worktree ||
          registration.gitControlDirectory !== request.gitControlDirectory ||
          registration.candidateSha !== request.candidateSha ||
          !registration.allowedChecks.includes(request.checkId) ||
          JSON.stringify(registration.environment) !== JSON.stringify(request.environment)
        ) {
          throw new Error('host validation job no longer matches controller registration');
        }
        if (tree !== registration.treeSha) {
          throw new Error(`host validation tree is ${tree}, expected ${registration.treeSha}`);
        }
        if (
          (await git(request.worktree, request.gitControlDirectory, ['status', '--porcelain']))
            .length > 0
        ) {
          throw new Error('host validation requires a clean exact-SHA worktree');
        }
      });
    this.probeService =
      options.probeService ??
      ((service) => defaultProbe(service, this.services, this.hostEnvironment));
    const scheduler = new ResourceScheduler();
    const runResourceJob =
      options.runResourceJob ??
      (async (input: RunRequest) => {
        return scheduler.run(input);
      });
    this.execute =
      options.execute ??
      (async ({
        request,
        policy,
        dependencyPreparationKey,
        productExecutionKey,
        productEnvironment,
      }) => {
        const bootstrapCommand = dependencyBootstrapCommand(this.bootstrapCommand);
        if (bootstrapCommand.length > 0) {
          const bootstrapEnvironment = dependencyBootstrapEnvironment(
            this.hostEnvironment,
            this.bootstrapEnvironment,
          );
          const bootstrap = await runResourceJob({
            agent: this.resourceAgent,
            resource: policy.resource,
            command: bootstrapCommand,
            worktree: request.worktree,
            candidateSha: request.candidateSha,
            environmentKey: dependencyPreparationKey,
            reuseEligible: false,
            childEnvironment: bootstrapEnvironment,
            childEnvironmentMode: 'replace',
          });
          if (bootstrap.exitCode !== 0) {
            return {
              exitCode: bootstrap.exitCode,
              resourceJobId: bootstrap.job.id,
              infrastructureFailure:
                'DEPENDENCY_BOOTSTRAP_FAILED: configured bootstrap command did not complete',
            };
          }
        }
        await this.verifyCandidate(request);
        const attestationToken = randomUUID();
        const scratchPreparation = await prepareProductValidationScratch(
          request.worktree,
          this.scratchPaths,
        );
        try {
          const result = await runResourceJob({
            agent: this.resourceAgent,
            resource: policy.resource,
            command: sandboxedHostCommand(request, policy, policy.command, this.scratchPaths),
            worktree: request.worktree,
            candidateSha: request.candidateSha,
            environmentKey: productExecutionKey,
            reuseEligible: true,
            executionAttestationRequired: true,
            childEnvironmentMode: 'replace',
            childEnvironment: {
              ...productEnvironment,
              AGENT_OS_PRODUCT_ATTESTATION_TOKEN: attestationToken,
            },
            executionAttestation: { token: attestationToken },
          });
          if (result.execution?.productStarted !== true) {
            return {
              exitCode: result.exitCode,
              resourceJobId: result.job.id,
              infrastructureFailure: `PRODUCT_EXECUTION_NOT_STARTED: ${result.execution?.failure ?? 'trusted execution attestation is absent'}`,
            };
          }
          return { exitCode: result.exitCode, resourceJobId: result.job.id };
        } finally {
          await disposeProductValidationScratch(scratchPreparation);
        }
      });
  }

  private registrationDirectory(): string {
    return path.join(this.runtimeDir, 'registered-environments');
  }

  private async registeredEnvironment(
    taskId: string,
    generation: number,
    candidateSha: string,
  ): Promise<HostValidationEnvironmentRegistration> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(taskId)) {
      throw new Error('invalid host validation task identity');
    }
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new Error('invalid host validation task generation');
    }
    const file = path.join(
      this.registrationDirectory(),
      `${taskId}-${String(generation)}-${fullSha(candidateSha)}.json`,
    );
    const value = parseHostValidationRegistration(
      JSON.parse(await fs.readFile(file, 'utf8')) as unknown,
      this.policies,
    );
    if (
      value.taskId !== taskId ||
      value.generation !== generation ||
      value.candidateSha !== candidateSha
    ) {
      throw new Error(`invalid registered host-validation environment: ${taskId}`);
    }
    return value;
  }

  async registerEnvironment(
    input: Omit<
      HostValidationEnvironmentRegistration,
      'schemaVersion' | 'treeSha' | 'registeredAt'
    >,
  ): Promise<HostValidationEnvironmentRegistration> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(input.taskId)) {
      throw new Error('invalid host validation task identity');
    }
    if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
      throw new Error('invalid host validation task generation');
    }
    requiredText(input.requestedBy, 'requestedBy');
    if (
      input.allowedChecks.length === 0 ||
      input.allowedChecks.some((check) => !isCheckId(check, this.policies)) ||
      new Set(input.allowedChecks).size !== input.allowedChecks.length
    ) {
      throw new Error('host validation registration has invalid policy eligibility');
    }
    const worktree = await fs.realpath(path.resolve(input.worktree));
    if (worktree !== path.resolve(input.worktree)) {
      throw new Error('registered worktree must not use a symlink alias');
    }
    const realRoots = await Promise.all(
      this.allowedWorktreeRoots.map((root) => fs.realpath(root).catch(() => undefined)),
    );
    if (!realRoots.some((root) => root !== undefined && isWithin(worktree, root))) {
      throw new Error(`worktree is outside approved host-validation roots: ${worktree}`);
    }
    const gitControlDirectory =
      input.gitControlDirectory === undefined
        ? undefined
        : await fs.realpath(path.resolve(input.gitControlDirectory));
    if (
      input.gitControlDirectory !== undefined &&
      gitControlDirectory !== path.resolve(input.gitControlDirectory)
    ) {
      throw new Error('registered Git control directory must not use a symlink alias');
    }
    const candidateSha = fullSha(input.candidateSha);
    const head = (await git(worktree, gitControlDirectory, ['rev-parse', 'HEAD'])).toLowerCase();
    if (head !== candidateSha)
      throw new Error('registered validation HEAD does not match candidate');
    if ((await git(worktree, gitControlDirectory, ['status', '--porcelain'])).length > 0) {
      throw new Error('registered validation worktree must be clean');
    }
    const treeSha = (
      await git(worktree, gitControlDirectory, ['rev-parse', `${candidateSha}^{tree}`])
    ).toLowerCase();
    const environment = parseWorkerEnvironment(input.environment);
    if (
      environment.environmentId !== input.taskId ||
      environment.workspace !== worktree ||
      environment.gitControlDirectory !== gitControlDirectory
    ) {
      throw new Error('registered environment does not match trusted worktree and Git control');
    }
    const registration: HostValidationEnvironmentRegistration = {
      ...input,
      schemaVersion: 1,
      worktree,
      gitControlDirectory,
      candidateSha,
      treeSha,
      environment,
      registeredAt: this.now().toISOString(),
    };
    await ensureControllerRuntimeDirectory(this.runtimeDir, {
      allowUnsafeTestRuntime: this.allowUnsafeTestRuntime,
    });
    const directory = this.registrationDirectory();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const target = path.join(
      directory,
      `${registration.taskId}-${String(registration.generation)}-${registration.candidateSha}.json`,
    );
    if (await fs.lstat(target).catch(() => undefined)) {
      const existing = await this.registeredEnvironment(
        registration.taskId,
        registration.generation,
        registration.candidateSha,
      );
      if (
        existing.requestedBy === registration.requestedBy &&
        existing.worktree === registration.worktree &&
        existing.gitControlDirectory === registration.gitControlDirectory &&
        existing.candidateSha === registration.candidateSha &&
        existing.treeSha === registration.treeSha &&
        JSON.stringify(existing.allowedChecks) === JSON.stringify(registration.allowedChecks) &&
        JSON.stringify(existing.environment) === JSON.stringify(registration.environment)
      ) {
        return existing;
      }
      throw new Error('host validation registration already exists with different authority');
    }
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(registration, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, target);
    const directoryHandle = await fs.open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return registration;
  }

  async request(input: unknown): Promise<HostValidationJob> {
    const supplied = normalizedRequest(input, this.policies);
    let registration: HostValidationEnvironmentRegistration;
    try {
      registration = await this.registeredEnvironment(
        supplied.taskId,
        supplied.generation,
        supplied.candidateSha,
      );
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new Error('host validation request is not authorized by controller registration');
      }
      throw error;
    }
    if (
      registration.requestedBy !== supplied.requestedBy ||
      registration.candidateSha !== supplied.candidateSha ||
      !registration.allowedChecks.includes(supplied.checkId)
    ) {
      throw new Error('host validation request is not authorized by controller registration');
    }
    const request: HostValidationRequest = {
      schemaVersion: 1,
      taskId: registration.taskId,
      generation: registration.generation,
      requestedBy: registration.requestedBy,
      checkId: supplied.checkId,
      candidateSha: registration.candidateSha,
      worktree: registration.worktree,
      ...(registration.gitControlDirectory === undefined
        ? {}
        : { gitControlDirectory: registration.gitControlDirectory }),
      environment: registration.environment,
    };
    const policy = this.policies[request.checkId];
    if (policy === undefined)
      throw new Error(`unsupported host validation check: ${request.checkId}`);
    const dependencyPreparation = dependencyPreparationIdentity(request.worktree, {
      hostEnvironment: this.hostEnvironment,
      bootstrapCommand: this.bootstrapCommand,
      bootstrapEnvironment: this.bootstrapEnvironment,
      dependencyFiles: this.dependencyFiles,
      ...(this.bootstrapToolIdentity === undefined
        ? {}
        : { bootstrapTool: this.bootstrapToolIdentity }),
    });
    const productExecution = productExecutionIdentity(
      request,
      policy,
      dependencyPreparation.key,
      this.hostEnvironment,
      this.environmentNames,
      this.scratchPaths,
    );
    const key = requestKey(request, policy, productExecution.key);
    return withState(this.runtimeDir, this.allowUnsafeTestRuntime, async (state) => {
      const reusable = state.jobs
        .slice()
        .reverse()
        .find((job) => job.key === key && job.status === 'PASS');
      const now = this.now().toISOString();
      const requiredHostService =
        'requiredHostService' in policy ? policy.requiredHostService : undefined;
      const reusePrerequisiteAvailable =
        reusable === undefined ||
        requiredHostService === undefined ||
        (await this.probeService(requiredHostService));
      if (reusable !== undefined && reusePrerequisiteAvailable) {
        const reused: HostValidationJob = {
          ...request,
          id: this.idFactory(),
          key,
          status: 'REUSED',
          command: [...policy.command],
          resource: policy.resource,
          environmentFingerprint: validationEnvironmentFingerprint(
            productExecution.environmentFingerprint,
          ),
          dependencyPreparationKey: dependencyPreparation.key,
          productExecutionKey: productExecution.key,
          requestedAt: now,
          updatedAt: now,
          attempt: reusable.attempt,
          finishedAt: now,
          exitCode: 0,
          reusedFrom: reusable.id,
        };
        state.jobs.push(reused);
        return structuredClone(reused);
      }
      const active = state.jobs.find(
        (job) => job.key === key && (job.status === 'QUEUED' || job.status === 'RUNNING'),
      );
      if (active !== undefined) return structuredClone(active);
      const job: HostValidationJob = {
        ...request,
        id: this.idFactory(),
        key,
        status: 'QUEUED',
        command: [...policy.command],
        resource: policy.resource,
        environmentFingerprint: validationEnvironmentFingerprint(
          productExecution.environmentFingerprint,
        ),
        dependencyPreparationKey: dependencyPreparation.key,
        productExecutionKey: productExecution.key,
        requestedAt: now,
        updatedAt: now,
        attempt: 0,
      };
      state.jobs.push(job);
      return structuredClone(job);
    });
  }

  async state(): Promise<HostValidationState> {
    return withState(this.runtimeDir, this.allowUnsafeTestRuntime, (state) =>
      structuredClone(state),
    );
  }

  async runNext(): Promise<HostValidationJob | undefined> {
    if (isCodexSandbox(this.hostEnvironment)) {
      throw new Error(
        'host validation runner must execute from the founder-owned host environment, not a Codex sandbox',
      );
    }
    const claimed = await withState(this.runtimeDir, this.allowUnsafeTestRuntime, (state) => {
      const claimTime = this.now();
      for (const stale of state.jobs.filter(
        (job) =>
          job.status === 'RUNNING' &&
          (job.leaseExpiresAt === undefined ||
            Date.parse(job.leaseExpiresAt) <= claimTime.getTime()),
      )) {
        stale.status = 'QUEUED';
        stale.summary = 'STALE_RUNNING_RECOVERED: prior host runner lease expired';
        stale.updatedAt = claimTime.toISOString();
        delete stale.startedAt;
        delete stale.leaseExpiresAt;
        delete stale.leaseToken;
        delete stale.finishedAt;
        delete stale.exitCode;
        delete stale.resourceJobId;
        delete stale.reusedFrom;
      }
      const job = state.jobs.find((candidate) => candidate.status === 'QUEUED');
      if (job === undefined) return undefined;
      const now = claimTime.toISOString();
      job.status = 'RUNNING';
      job.startedAt = now;
      job.updatedAt = now;
      job.attempt += 1;
      job.leaseToken = this.idFactory();
      job.leaseExpiresAt = new Date(claimTime.getTime() + this.leaseMs).toISOString();
      return structuredClone(job);
    });
    if (claimed === undefined) return undefined;
    const policy = this.policies[claimed.checkId];
    if (policy === undefined)
      throw new Error(`unsupported host validation check: ${claimed.checkId}`);
    const requiredHostService: string | undefined =
      'requiredHostService' in policy ? policy.requiredHostService : undefined;
    let outcome: Pick<HostValidationJob, 'status' | 'summary' | 'exitCode' | 'resourceJobId'>;
    try {
      const currentDependencyPreparation = dependencyPreparationIdentity(claimed.worktree, {
        hostEnvironment: this.hostEnvironment,
        bootstrapCommand: this.bootstrapCommand,
        bootstrapEnvironment: this.bootstrapEnvironment,
        dependencyFiles: this.dependencyFiles,
        ...(this.bootstrapToolIdentity === undefined
          ? {}
          : { bootstrapTool: this.bootstrapToolIdentity }),
      });
      if (currentDependencyPreparation.key !== claimed.dependencyPreparationKey) {
        throw new Error(
          'DEPENDENCY_PREPARATION_CHANGED: validation environment no longer matches the queued job',
        );
      }
      const currentProductExecution = productExecutionIdentity(
        claimed,
        policy,
        claimed.dependencyPreparationKey,
        this.hostEnvironment,
        this.environmentNames,
        this.scratchPaths,
      );
      if (currentProductExecution.key !== claimed.productExecutionKey) {
        throw new Error(
          'PRODUCT_EXECUTION_CHANGED: validation environment no longer matches the queued job',
        );
      }
      await this.verifyCandidate(claimed);
      if (requiredHostService !== undefined && !(await this.probeService(requiredHostService))) {
        outcome = {
          status: 'HOST_SERVICE_UNREACHABLE',
          summary: `${requiredHostService} is unreachable from the host validation runner`,
        };
      } else {
        const result = await this.execute({
          request: claimed,
          policy,
          dependencyPreparationKey: claimed.dependencyPreparationKey,
          productExecutionKey: claimed.productExecutionKey,
          productEnvironment: productExecutionEnvironment(
            this.hostEnvironment,
            claimed.gitControlDirectory,
            this.environmentNames,
          ),
        });
        if (result.infrastructureFailure !== undefined) {
          outcome = {
            status: 'ENVIRONMENT_BLOCKED',
            exitCode: result.exitCode,
            ...(result.resourceJobId === undefined ? {} : { resourceJobId: result.resourceJobId }),
            summary: result.infrastructureFailure,
          };
        } else {
          outcome = {
            status: result.exitCode === 0 ? 'PASS' : 'TARGET_TEST_FAILURE',
            exitCode: result.exitCode,
            ...(result.resourceJobId === undefined ? {} : { resourceJobId: result.resourceJobId }),
            summary:
              result.exitCode === 0
                ? 'Host validation passed'
                : 'Validation command ran with required host services available and failed',
          };
        }
      }
      await this.verifyCandidate(claimed);
    } catch (error) {
      outcome = {
        status: 'ENVIRONMENT_BLOCKED',
        summary: error instanceof Error ? error.message : String(error),
      };
    }
    return withState(this.runtimeDir, this.allowUnsafeTestRuntime, (state) => {
      const job = state.jobs.find((candidate) => candidate.id === claimed.id);
      if (
        job === undefined ||
        job.status !== 'RUNNING' ||
        job.attempt !== claimed.attempt ||
        job.leaseToken !== claimed.leaseToken
      ) {
        throw new Error(`host validation job changed while running: ${claimed.id}`);
      }
      const now = this.now().toISOString();
      Object.assign(job, outcome, { updatedAt: now, finishedAt: now });
      delete job.leaseExpiresAt;
      delete job.leaseToken;
      return structuredClone(job);
    });
  }
}
