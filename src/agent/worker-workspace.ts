// src/agent/worker-workspace.ts
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { controllerRoot } from './controller-runtime';

const execFileAsync = promisify(execFile);
const DEFAULT_WORKSPACE_ROOT = '/tmp/agent-os-worker-workspaces';
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const FULL_SHA = /^[0-9a-f]{40,64}$/u;

export interface WorkerEnvironmentCapabilities {
  schemaVersion: 1;
  environmentId: string;
  workspace: string;
  gitControlDirectory: string;
  branch: string;
  baseSha: string;
  gitCommit: 'DIRECT_WITH_EXPORTED_GIT_DIR';
  hostLoopback: 'UNAVAILABLE';
  sharedRuntime: 'VIA_HOST_VALIDATION_RUNNER';
  postgres: 'VIA_HOST_VALIDATION_RUNNER';
  networkNamespace: 'CODEX_ISOLATED';
  createdAt: string;
}

export interface WorkerWorkspace {
  taskId: string;
  workspace: string;
  gitControlDirectory: string;
  branch: string;
  baseSha: string;
  environmentFile: string;
  capabilities: WorkerEnvironmentCapabilities;
}

export interface CodexLaunchPlan {
  executable: 'codex';
  arguments: string[];
  cwd: string;
  environment: {
    GIT_DIR: string;
    GIT_WORK_TREE: string;
    AGENT_OS_EXECUTION_ENVIRONMENT_FILE: string;
  };
}

export interface ProvisionWorkerOptions {
  taskId: string;
  sourceRepository: string;
  baseSha: string;
  branch: string;
  workspaceRoot?: string;
  now?: Date;
}

export interface AttachWorkerOptions {
  taskId: string;
  generation: number;
  registryDirectory?: string;
  workspaceRoot?: string;
  now?: Date;
}

export interface FrozenCandidateRegistration {
  schemaVersion: 1;
  taskId: string;
  generation: number;
  sourceRepository: string;
  expectedWorktree: string;
  branch: string;
  registeredBaseSha: string;
  contentFingerprint: string;
  stateFingerprint: string;
  registeredAt: string;
}

export interface CapturedCandidate {
  schemaVersion: 1;
  taskId: string;
  candidateSha: string;
  treeSha: string;
  storeGitDirectory: string;
  ref: string;
  capturedAt: string;
}

export interface CaptureCandidateOptions {
  taskId: string;
  worktree: string;
  candidateSha: string;
  gitControlDirectory?: string;
  storeGitDirectory?: string;
  now?: Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must not be empty`);
  return normalized;
}

function taskId(value: string): string {
  const normalized = requiredText(value, 'taskId');
  if (!SAFE_TASK_ID.test(normalized)) {
    throw new Error('taskId must use letters, numbers, dots, underscores, or hyphens');
  }
  return normalized;
}

function sha(value: string): string {
  const normalized = requiredText(value, 'baseSha').toLowerCase();
  if (!FULL_SHA.test(normalized)) throw new Error('baseSha must be a full hexadecimal commit SHA');
  return normalized;
}

export function parseWorkerEnvironment(value: unknown): WorkerEnvironmentCapabilities {
  if (
    !isRecord(value) ||
    value['schemaVersion'] !== 1 ||
    typeof value['environmentId'] !== 'string' ||
    typeof value['workspace'] !== 'string' ||
    typeof value['gitControlDirectory'] !== 'string' ||
    typeof value['branch'] !== 'string' ||
    typeof value['baseSha'] !== 'string' ||
    value['gitCommit'] !== 'DIRECT_WITH_EXPORTED_GIT_DIR' ||
    value['hostLoopback'] !== 'UNAVAILABLE' ||
    value['sharedRuntime'] !== 'VIA_HOST_VALIDATION_RUNNER' ||
    value['postgres'] !== 'VIA_HOST_VALIDATION_RUNNER' ||
    value['networkNamespace'] !== 'CODEX_ISOLATED' ||
    typeof value['createdAt'] !== 'string'
  ) {
    throw new Error('unsupported worker environment file');
  }
  return {
    schemaVersion: 1,
    environmentId: requiredText(value['environmentId'], 'environmentId'),
    workspace: path.resolve(requiredText(value['workspace'], 'workspace')),
    gitControlDirectory: path.resolve(
      requiredText(value['gitControlDirectory'], 'gitControlDirectory'),
    ),
    branch: requiredText(value['branch'], 'branch'),
    baseSha: sha(value['baseSha']),
    gitCommit: 'DIRECT_WITH_EXPORTED_GIT_DIR',
    hostLoopback: 'UNAVAILABLE',
    sharedRuntime: 'VIA_HOST_VALIDATION_RUNNER',
    postgres: 'VIA_HOST_VALIDATION_RUNNER',
    networkNamespace: 'CODEX_ISOLATED',
    createdAt: requiredText(value['createdAt'], 'createdAt'),
  };
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function git(
  argumentsToGit: readonly string[],
  options: { cwd?: string; environment?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  try {
    const result = await execFileAsync('git', [...argumentsToGit], {
      cwd: options.cwd,
      env: options.environment ?? process.env,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    if (error instanceof Error && 'stderr' in error && typeof error.stderr === 'string') {
      throw new Error(error.stderr.trim() || `git ${argumentsToGit.join(' ')} failed`, {
        cause: error,
      });
    }
    throw error;
  }
}

function workerEnvironment(workspace: WorkerWorkspace): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_DIR: workspace.gitControlDirectory,
    GIT_WORK_TREE: workspace.workspace,
  };
}

async function verifyBranch(branch: string): Promise<string> {
  const normalized = requiredText(branch, 'branch');
  await git(['check-ref-format', '--branch', normalized]);
  return normalized;
}

async function writeEnvironment(
  root: string,
  input: Omit<WorkerWorkspace, 'environmentFile' | 'capabilities'>,
  now: Date,
): Promise<WorkerWorkspace> {
  const environmentFile = path.join(root, 'worker-environment.json');
  const capabilities: WorkerEnvironmentCapabilities = {
    schemaVersion: 1,
    environmentId: input.taskId,
    workspace: input.workspace,
    gitControlDirectory: input.gitControlDirectory,
    branch: input.branch,
    baseSha: input.baseSha,
    gitCommit: 'DIRECT_WITH_EXPORTED_GIT_DIR',
    hostLoopback: 'UNAVAILABLE',
    sharedRuntime: 'VIA_HOST_VALIDATION_RUNNER',
    postgres: 'VIA_HOST_VALIDATION_RUNNER',
    networkNamespace: 'CODEX_ISOLATED',
    createdAt: now.toISOString(),
  };
  await fs.writeFile(environmentFile, `${JSON.stringify(capabilities, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  return { ...input, environmentFile, capabilities };
}

async function cloneMetadata(
  sourceRepository: string,
  stagingWorkspace: string,
  gitControlDirectory: string,
): Promise<void> {
  // --no-hardlinks keeps the worker independent from the source object store. The
  // candidate is still not durable until captureGitCandidate imports it below.
  await git(['clone', '--no-hardlinks', '--no-checkout', sourceRepository, stagingWorkspace]);
  await fs.rename(path.join(stagingWorkspace, '.git'), gitControlDirectory);
  if (await fs.lstat(path.join(stagingWorkspace, '.git')).catch(() => undefined)) {
    throw new Error('worker workspace must not retain a .git path');
  }
}

async function realDirectory(value: string, label: string): Promise<string> {
  const resolved = path.resolve(requiredText(value, label));
  const real = await fs.realpath(resolved);
  const status = await fs.lstat(resolved);
  if (!status.isDirectory() || status.isSymbolicLink() || real !== resolved) {
    throw new Error(`${label} must be a real directory, not a symlink`);
  }
  return real;
}

async function changedPaths(
  worktree: string,
  baseSha: string,
  gitControlDirectory?: string,
): Promise<string[]> {
  const environment =
    gitControlDirectory === undefined
      ? process.env
      : {
          ...process.env,
          GIT_DIR: gitControlDirectory,
          GIT_WORK_TREE: worktree,
        };
  const outputs = await Promise.all([
    git(['diff', '--name-only', '-z', baseSha, '--'], {
      cwd: worktree,
      environment,
    }),
    git(['diff', '--cached', '--name-only', '-z', baseSha, '--'], {
      cwd: worktree,
      environment,
    }),
    git(['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd: worktree,
      environment,
    }),
  ]);
  return [...new Set(outputs.flatMap((output) => output.split('\0').filter(Boolean)))].sort();
}

export async function candidateFingerprints(input: {
  worktree: string;
  baseSha: string;
  gitControlDirectory?: string;
}): Promise<{ contentFingerprint: string; stateFingerprint: string }> {
  const worktree = await realDirectory(input.worktree, 'worktree');
  const baseSha = sha(input.baseSha);
  const paths = await changedPaths(worktree, baseSha, input.gitControlDirectory);
  const content = createHash('sha256');
  for (const relative of paths) {
    if (path.isAbsolute(relative) || relative.split('/').includes('..')) {
      throw new Error('candidate path escapes the registered worktree');
    }
    const target = path.join(worktree, relative);
    const status = await fs.lstat(target).catch(() => undefined);
    content.update(`${relative}\0`);
    if (status === undefined) {
      content.update('deleted\0');
    } else if (status.isSymbolicLink()) {
      content.update(`symlink\0${await fs.readlink(target)}\0`);
    } else if (status.isFile()) {
      content.update(`file:${String(status.mode & 0o111)}\0`);
      content.update(await fs.readFile(target));
      content.update('\0');
    } else {
      throw new Error(`unsupported candidate filesystem entry: ${relative}`);
    }
  }
  const environment =
    input.gitControlDirectory === undefined
      ? process.env
      : {
          ...process.env,
          GIT_DIR: input.gitControlDirectory,
          GIT_WORK_TREE: worktree,
        };
  const porcelain = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: worktree,
    environment,
  });
  return {
    contentFingerprint: content.digest('hex'),
    stateFingerprint: createHash('sha256').update(porcelain).digest('hex'),
  };
}

async function durableWrite(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${String(process.pid)}-${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
  const directory = await fs.open(path.dirname(file), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function parseFrozenCandidateRegistration(value: unknown): FrozenCandidateRegistration {
  if (
    !isRecord(value) ||
    value['schemaVersion'] !== 1 ||
    typeof value['taskId'] !== 'string' ||
    !Number.isSafeInteger(value['generation']) ||
    Number(value['generation']) < 0 ||
    typeof value['sourceRepository'] !== 'string' ||
    typeof value['expectedWorktree'] !== 'string' ||
    typeof value['branch'] !== 'string' ||
    typeof value['registeredBaseSha'] !== 'string' ||
    typeof value['contentFingerprint'] !== 'string' ||
    typeof value['stateFingerprint'] !== 'string' ||
    typeof value['registeredAt'] !== 'string'
  ) {
    throw new Error('controller frozen-candidate registration is corrupt');
  }
  return {
    schemaVersion: 1,
    taskId: taskId(value['taskId']),
    generation: Number(value['generation']),
    sourceRepository: path.resolve(value['sourceRepository']),
    expectedWorktree: path.resolve(value['expectedWorktree']),
    branch: requiredText(value['branch'], 'branch'),
    registeredBaseSha: sha(value['registeredBaseSha']),
    contentFingerprint: requiredText(value['contentFingerprint'], 'contentFingerprint'),
    stateFingerprint: requiredText(value['stateFingerprint'], 'stateFingerprint'),
    registeredAt: requiredText(value['registeredAt'], 'registeredAt'),
  };
}

export async function loadFrozenCandidateRegistration(input: {
  taskId: string;
  generation: number;
  registryDirectory?: string;
}): Promise<FrozenCandidateRegistration> {
  const normalizedTask = taskId(input.taskId);
  if (!Number.isSafeInteger(input.generation) || input.generation < 0)
    throw new Error('generation must be a non-negative integer');
  const registryDirectory = await realDirectory(
    path.resolve(input.registryDirectory ?? path.join(controllerRoot(), 'frozen-candidates')),
    'controller registry directory',
  );
  const destination = path.join(
    registryDirectory,
    `${normalizedTask}.g${String(input.generation)}.json`,
  );
  let raw: string;
  try {
    raw = await fs.readFile(destination, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      const registrations = await fs.readdir(registryDirectory);
      if (registrations.some((entry) => entry.startsWith(`${normalizedTask}.g`))) {
        throw new Error(
          `FROZEN_CANDIDATE_DRIFT: ${normalizedTask} has no controller registration for generation ${String(input.generation)}`,
        );
      }
    }
    throw error;
  }
  const registration = parseFrozenCandidateRegistration(JSON.parse(raw) as unknown);
  if (registration.taskId !== normalizedTask) {
    throw new Error('controller registration task mismatch');
  }
  if (registration.generation !== input.generation) {
    throw new Error(
      `FROZEN_CANDIDATE_DRIFT: ${normalizedTask} registration generation ${String(registration.generation)} does not match ${String(input.generation)}`,
    );
  }
  return registration;
}

export async function registerFrozenCandidate(input: {
  taskId: string;
  generation: number;
  sourceRepository: string;
  worktree: string;
  branch: string;
  baseSha: string;
  registryDirectory?: string;
  now?: Date;
}): Promise<FrozenCandidateRegistration> {
  const normalizedTask = taskId(input.taskId);
  if (!Number.isSafeInteger(input.generation) || input.generation < 0)
    throw new Error('generation must be a non-negative integer');
  const expectedWorktree = await realDirectory(input.worktree, 'worktree');
  const sourceRepository = await realDirectory(input.sourceRepository, 'sourceRepository');
  const branch = await verifyBranch(input.branch);
  const registeredBaseSha = sha(input.baseSha);
  const fingerprints = await candidateFingerprints({
    worktree: expectedWorktree,
    baseSha: registeredBaseSha,
  });
  const registration: FrozenCandidateRegistration = {
    schemaVersion: 1,
    taskId: normalizedTask,
    generation: input.generation,
    sourceRepository,
    expectedWorktree,
    branch,
    registeredBaseSha,
    ...fingerprints,
    registeredAt: (input.now ?? new Date()).toISOString(),
  };
  const registryDirectory = path.resolve(
    input.registryDirectory ?? path.join(controllerRoot(), 'frozen-candidates'),
  );
  await fs.mkdir(registryDirectory, { recursive: true, mode: 0o700 });
  await realDirectory(registryDirectory, 'controller registry directory');
  const destination = path.join(
    registryDirectory,
    `${normalizedTask}.g${String(input.generation)}.json`,
  );
  if (await fs.lstat(destination).catch(() => undefined)) {
    throw new Error(`frozen candidate registration already exists: ${normalizedTask}`);
  }
  await durableWrite(destination, registration);
  return registration;
}

export async function verifyFrozenCandidate(
  registration: FrozenCandidateRegistration,
): Promise<void> {
  taskId(registration.taskId);
  await realDirectory(registration.sourceRepository, 'registered source repository');
  const worktree = await realDirectory(registration.expectedWorktree, 'registered worktree');
  const actual = await candidateFingerprints({
    worktree,
    baseSha: registration.registeredBaseSha,
  });
  if (
    actual.contentFingerprint !== registration.contentFingerprint ||
    actual.stateFingerprint !== registration.stateFingerprint
  ) {
    throw new Error(
      `FROZEN_CANDIDATE_DRIFT: ${registration.taskId} no longer matches its controller registration`,
    );
  }
}

async function syncStableDirectoryFiles(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const entries = (await fs.readdir(directory).catch(() => [])).sort((left, right) =>
      left.localeCompare(right),
    );
    let changedDuringSync = false;
    for (const entry of entries) {
      let handle;
      try {
        handle = await fs.open(path.join(directory, entry), 'r');
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          changedDuringSync = true;
          break;
        }
        throw error;
      }
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    if (changedDuringSync) continue;
    const after = (await fs.readdir(directory).catch(() => [])).sort((left, right) =>
      left.localeCompare(right),
    );
    if (JSON.stringify(after) === JSON.stringify(entries)) return;
  }
  throw new Error(`Git object directory did not stabilize during durability sync: ${directory}`);
}

export async function fsyncGitStore(storeGitDirectory: string, ref: string): Promise<void> {
  const packDirectory = path.join(storeGitDirectory, 'objects', 'pack');
  await syncStableDirectoryFiles(packDirectory);
  for (const directoryPath of [
    packDirectory,
    path.join(storeGitDirectory, 'objects'),
    storeGitDirectory,
  ]) {
    const handle = await fs.open(directoryPath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const refPath = path.join(storeGitDirectory, ...ref.split('/'));
  const refHandle = await fs.open(refPath, 'r');
  try {
    await refHandle.sync();
  } finally {
    await refHandle.close();
  }
  for (const directoryPath of [path.dirname(refPath), path.dirname(path.dirname(refPath))]) {
    const handle = await fs.open(directoryPath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

export async function captureGitCandidate(
  options: CaptureCandidateOptions,
): Promise<CapturedCandidate> {
  const normalizedTask = taskId(options.taskId);
  const candidateSha = sha(options.candidateSha);
  const worktree = await realDirectory(options.worktree, 'worktree');
  const storeGitDirectory = path.resolve(
    options.storeGitDirectory ?? path.join(controllerRoot(), 'object-store.git'),
  );
  const storeParent = path.dirname(storeGitDirectory);
  await fs.mkdir(storeParent, { recursive: true, mode: 0o700 });
  await realDirectory(storeParent, 'controller object-store parent');
  const parentStatus = await fs.lstat(storeParent);
  const uid = process.getuid?.();
  if ((uid !== undefined && parentStatus.uid !== uid) || (parentStatus.mode & 0o077) !== 0) {
    throw new Error('controller object-store parent must be owner-only');
  }
  if (!(await fs.lstat(storeGitDirectory).catch(() => undefined))) {
    await git(['init', '--bare', storeGitDirectory]);
  }
  const storeStatus = await fs.lstat(storeGitDirectory);
  if (!storeStatus.isDirectory() || storeStatus.isSymbolicLink()) {
    throw new Error('controller object store must be a real directory');
  }
  if ((await fs.realpath(storeGitDirectory)) !== storeGitDirectory) {
    throw new Error('controller object store must not traverse a symlink');
  }
  if (
    (await fs
      .lstat(path.join(storeGitDirectory, 'objects', 'info', 'alternates'))
      .catch(() => undefined)) !== undefined
  ) {
    throw new Error('controller object store must own its objects and cannot use alternates');
  }
  if (
    (await git(['--git-dir', storeGitDirectory, 'rev-parse', '--is-bare-repository'])) !== 'true'
  ) {
    throw new Error('controller object store must be a bare Git repository');
  }
  const workerEnvironment =
    options.gitControlDirectory === undefined
      ? process.env
      : {
          ...process.env,
          GIT_DIR: options.gitControlDirectory,
          GIT_WORK_TREE: worktree,
        };
  const head = (
    await git(['rev-parse', 'HEAD'], {
      cwd: worktree,
      environment: workerEnvironment,
    })
  ).toLowerCase();
  if (head !== candidateSha) throw new Error(`candidate HEAD is ${head}, expected ${candidateSha}`);
  const treeSha = (
    await git(['rev-parse', `${candidateSha}^{tree}`], {
      cwd: worktree,
      environment: workerEnvironment,
    })
  ).toLowerCase();
  const bundle = path.join(storeParent, `.candidate-${normalizedTask}-${randomUUID()}.bundle`);
  const ref = `refs/candidates/${normalizedTask}/${candidateSha}`;
  try {
    await git(['bundle', 'create', bundle, 'HEAD'], {
      cwd: worktree,
      environment: workerEnvironment,
    });
    await git([
      '-c',
      'fetch.unpackLimit=0',
      '-c',
      'gc.auto=0',
      '-c',
      'maintenance.auto=false',
      '--git-dir',
      storeGitDirectory,
      'fetch',
      '--no-tags',
      bundle,
      `${candidateSha}:${ref}`,
    ]);
    const imported = (await git(['--git-dir', storeGitDirectory, 'rev-parse', ref])).toLowerCase();
    const importedTree = (
      await git(['--git-dir', storeGitDirectory, 'rev-parse', `${ref}^{tree}`])
    ).toLowerCase();
    if (imported !== candidateSha || importedTree !== treeSha) {
      throw new Error('controller object import did not preserve the exact commit and tree');
    }
    await git(['--git-dir', storeGitDirectory, 'fsck', '--connectivity-only', candidateSha]);
    await fsyncGitStore(storeGitDirectory, ref);
    const captured: CapturedCandidate = {
      schemaVersion: 1,
      taskId: normalizedTask,
      candidateSha,
      treeSha,
      storeGitDirectory,
      ref,
      capturedAt: (options.now ?? new Date()).toISOString(),
    };
    const records = path.join(storeParent, 'captures');
    await fs.mkdir(records, { recursive: true, mode: 0o700 });
    await durableWrite(path.join(records, `${normalizedTask}-${candidateSha}.json`), captured);
    return captured;
  } finally {
    await fs.unlink(bundle).catch(() => undefined);
  }
}

export async function provisionWorkerWorkspace(
  options: ProvisionWorkerOptions,
): Promise<WorkerWorkspace> {
  const normalizedTask = taskId(options.taskId);
  const baseSha = sha(options.baseSha);
  const branch = await verifyBranch(options.branch);
  const sourceRepository = path.resolve(requiredText(options.sourceRepository, 'sourceRepository'));
  const workspaceRoot = path.resolve(options.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT);
  const root = path.join(workspaceRoot, normalizedTask);
  if (!isWithin(root, workspaceRoot) || root === workspaceRoot)
    throw new Error('unsafe worker root');
  await fs.mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  await realDirectory(workspaceRoot, 'workspaceRoot');
  await fs.mkdir(root, { mode: 0o700 });
  const workspace = path.join(root, 'workspace');
  const gitControlDirectory = path.join(root, 'git-control');
  try {
    await cloneMetadata(sourceRepository, workspace, gitControlDirectory);
    const provisional: Omit<WorkerWorkspace, 'environmentFile' | 'capabilities'> = {
      taskId: normalizedTask,
      workspace,
      gitControlDirectory,
      branch,
      baseSha,
    };
    const environment = {
      ...process.env,
      GIT_DIR: gitControlDirectory,
      GIT_WORK_TREE: workspace,
    };
    await git(['checkout', '-b', branch, baseSha], {
      cwd: workspace,
      environment,
    });
    if ((await git(['rev-parse', 'HEAD'], { cwd: workspace, environment })) !== baseSha) {
      throw new Error('worker checkout did not land on the approved base SHA');
    }
    if ((await git(['status', '--porcelain'], { cwd: workspace, environment })).length > 0) {
      throw new Error('new worker checkout is not clean');
    }
    return await writeEnvironment(root, provisional, options.now ?? new Date());
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function attachWorkerMetadata(options: AttachWorkerOptions): Promise<WorkerWorkspace> {
  const registration = await loadFrozenCandidateRegistration({
    taskId: options.taskId,
    generation: options.generation,
    ...(options.registryDirectory === undefined
      ? {}
      : { registryDirectory: options.registryDirectory }),
  });
  await verifyFrozenCandidate(registration);
  const normalizedTask = taskId(registration.taskId);
  const baseSha = sha(registration.registeredBaseSha);
  const branch = await verifyBranch(registration.branch);
  const sourceRepository = registration.sourceRepository;
  const existingWorkspace = registration.expectedWorktree;
  const workspaceRoot = path.resolve(options.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT);
  const root = path.join(workspaceRoot, normalizedTask);
  if (!isWithin(root, workspaceRoot) || root === workspaceRoot)
    throw new Error('unsafe worker root');
  const workspaceStatus = await fs.lstat(existingWorkspace);
  if (!workspaceStatus.isDirectory()) throw new Error('existingWorkspace must be a directory');
  await fs.mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  await realDirectory(workspaceRoot, 'workspaceRoot');
  await fs.mkdir(root, { mode: 0o700 });
  const stagingWorkspace = path.join(root, 'metadata-staging');
  const gitControlDirectory = path.join(root, 'git-control');
  try {
    await cloneMetadata(sourceRepository, stagingWorkspace, gitControlDirectory);
    await fs.rmdir(stagingWorkspace);
    await git(['update-ref', `refs/heads/${branch}`, baseSha], {
      environment: { ...process.env, GIT_DIR: gitControlDirectory },
    });
    await git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], {
      environment: { ...process.env, GIT_DIR: gitControlDirectory },
    });
    // Clone preparation may take time. Re-check controller-owned bytes immediately
    // before the first index mutation so a racing worker cannot evade the freeze.
    await verifyFrozenCandidate(registration);
    await git(['read-tree', baseSha], {
      environment: {
        ...process.env,
        GIT_DIR: gitControlDirectory,
        GIT_WORK_TREE: existingWorkspace,
      },
    });
    await verifyFrozenCandidate(registration);
    return await writeEnvironment(
      root,
      {
        taskId: normalizedTask,
        workspace: existingWorkspace,
        gitControlDirectory,
        branch,
        baseSha,
      },
      options.now ?? new Date(),
    );
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

export function buildCodexLaunchPlan(workspace: WorkerWorkspace, prompt: string): CodexLaunchPlan {
  return {
    executable: 'codex',
    arguments: [
      '--ask-for-approval',
      'never',
      '--sandbox',
      'workspace-write',
      '--add-dir',
      workspace.gitControlDirectory,
      '--cd',
      workspace.workspace,
      'exec',
      '--skip-git-repo-check',
      requiredText(prompt, 'prompt'),
    ],
    cwd: workspace.workspace,
    environment: {
      GIT_DIR: workspace.gitControlDirectory,
      GIT_WORK_TREE: workspace.workspace,
      AGENT_OS_EXECUTION_ENVIRONMENT_FILE: workspace.environmentFile,
    },
  };
}

export async function workerGit(
  workspace: WorkerWorkspace,
  argumentsToGit: readonly string[],
): Promise<string> {
  return git(argumentsToGit, {
    cwd: workspace.workspace,
    environment: workerEnvironment(workspace),
  });
}
