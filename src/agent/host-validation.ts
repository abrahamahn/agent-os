// src/agent/host-validation.ts
import { execFile, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { controllerRoot, ensureControllerRuntimeDirectory } from './controller-runtime';
import {
  dependencyEnvironmentKey,
  EXECUTION_ATTESTATION_PREFIX,
  ResourceScheduler,
} from './resource-scheduler';
import { parseWorkerEnvironment } from './worker-workspace';
import { loadValidationProfile } from './validation-profile';

import type { ResourceClass, RunExecutionEvidence, RunRequest } from './resource-scheduler';
import type { ValidationServiceProfile } from './validation-profile';
import type { WorkerEnvironmentCapabilities } from './worker-workspace';

export const HOST_VALIDATION_RESULTS = [
  'QUEUED',
  'RUNNING',
  'PASS',
  'TARGET_TEST_FAILURE',
  'HOST_SERVICE_UNREACHABLE',
  'ENVIRONMENT_BLOCKED',
  'CANCELLED',
  'REUSED',
] as const;

export type HostValidationResult = (typeof HOST_VALIDATION_RESULTS)[number];
export type HostValidationCheckId = string;

export interface HostValidationPolicy {
  resource: ResourceClass;
  command: readonly string[];
  requiredHostService?: string;
}

export interface HostValidationRequest {
  schemaVersion: 1;
  taskId: string;
  generation: number;
  requestedBy: string;
  checkId: HostValidationCheckId;
  candidateSha: string;
  worktree: string;
  gitControlDirectory?: string;
  environment: WorkerEnvironmentCapabilities;
}

export interface HostValidationEnvironmentRegistration {
  schemaVersion: 1;
  taskId: string;
  generation: number;
  requestedBy: string;
  worktree: string;
  gitControlDirectory?: string;
  candidateSha: string;
  treeSha: string;
  allowedChecks: HostValidationCheckId[];
  eligibility: 'READY_FOR_VALIDATION';
  environment: WorkerEnvironmentCapabilities;
  registeredAt: string;
}

export interface HostValidationJob extends HostValidationRequest {
  id: string;
  key: string;
  status: HostValidationResult;
  command: string[];
  resource: ResourceClass;
  environmentFingerprint: string;
  dependencyPreparationKey: string;
  productExecutionKey: string;
  requestedAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  resourceJobId?: string;
  reusedFrom?: string;
  summary?: string;
  leaseExpiresAt?: string;
  leaseToken?: string;
  attempt: number;
}

export interface HostValidationState {
  version: 1;
  jobs: HostValidationJob[];
}

export interface HostValidationRunnerOptions {
  runtimeDir?: string;
  now?: () => Date;
  idFactory?: () => string;
  hostEnvironment?: NodeJS.ProcessEnv;
  allowedWorktreeRoots?: readonly string[];
  verifyCandidate?: (request: HostValidationRequest) => Promise<void>;
  probeService?: (service: string) => Promise<boolean>;
  execute?: (input: {
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
  runResourceJob?: (input: RunRequest) => Promise<{
    exitCode: number;
    job: { id: string };
    execution?: RunExecutionEvidence;
  }>;
  bootstrapToolIdentity?: BootstrapToolIdentity;
  bootstrapCommand?: readonly string[];
  bootstrapEnvironment?: Readonly<Record<string, string>>;
  dependencyFiles?: readonly string[];
  scratchPaths?: readonly string[];
  leaseMs?: number;
  allowUnsafeTestRuntime?: boolean;
  resourceAgent?: string;
  policies?: Readonly<Record<string, HostValidationPolicy>>;
  environmentNames?: readonly string[];
  services?: Readonly<Record<string, ValidationServiceProfile>>;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function recordText(value: Record<string, unknown>, key: string, label: string): string {
  const candidate = value[key];
  if (typeof candidate !== 'string') throw new Error(`${label} must be text`);
  return requiredText(candidate, label);
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

export function dependencyBootstrapCommand(
  command: readonly string[] = loadValidationProfile().bootstrap.command,
): string[] {
  return [...command];
}

export interface BootstrapToolIdentity {
  executable: string;
  version: string;
}

export interface DependencyPreparationIdentity {
  schemaVersion: 1;
  key: string;
  bootstrapTool: BootstrapToolIdentity;
  command: string[];
  environment: Record<string, string>;
  node: {
    executable: string;
    version: string;
    platform: NodeJS.Platform;
    architecture: string;
  };
  candidateDependencyKey: string;
}

export const PRODUCT_EXECUTION_ENVIRONMENT_NAMES = loadValidationProfile().environmentNames;

export type ProductExecutionEnvironment = Record<string, string>;

const productEnvironmentDefaults: Readonly<Record<string, string>> = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: homedir(),
  CI: 'true',
  NODE_ENV: 'test',
  TMPDIR: '/tmp',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  XDG_CACHE_HOME: '/tmp/cache',
  GIT_DIR: '/tmp/agent-os-validation-git-control',
  GIT_WORK_TREE: '/tmp/agent-os-validation-workspace',
};

const fixedProductEnvironmentNames = new Set([
  'TMPDIR',
  'XDG_CACHE_HOME',
  'GIT_DIR',
  'GIT_WORK_TREE',
]);

export function productExecutionEnvironment(
  hostEnvironment: NodeJS.ProcessEnv = process.env,
  gitControlDirectory?: string,
  environmentNames: readonly string[] = PRODUCT_EXECUTION_ENVIRONMENT_NAMES,
): ProductExecutionEnvironment {
  const environment: ProductExecutionEnvironment = {};
  for (const name of environmentNames) {
    const value = fixedProductEnvironmentNames.has(name)
      ? productEnvironmentDefaults[name]
      : (hostEnvironment[name] ?? productEnvironmentDefaults[name]);
    if (value !== undefined) environment[name] = value;
  }
  if (gitControlDirectory === undefined) {
    delete environment['GIT_DIR'];
    delete environment['GIT_WORK_TREE'];
  }
  return environment;
}

function secretSafeEnvironmentFingerprint(
  environment: ProductExecutionEnvironment,
  environmentNames: readonly string[],
): string {
  const hash = createHash('sha256');
  for (const name of environmentNames) {
    hash.update(name);
    hash.update('\0');
    hash.update(
      createHash('sha256')
        .update(environment[name] ?? '<missing>')
        .digest('hex'),
    );
    hash.update('\0');
  }
  return hash.digest('hex');
}

export interface ProductExecutionIdentity {
  schemaVersion: 1;
  key: string;
  environmentFingerprint: string;
  sandboxCachePolicy: ProductValidationCachePolicy;
  turboScratchPolicy: ProductTurboScratchPolicy;
  validationToolScratchPolicy: ProductValidationScratchPolicy;
  dependencyPreparationKey: string;
  candidateSha: string;
  checkId: HostValidationCheckId;
  command: string[];
  node: {
    executable: string;
    version: string;
    platform: NodeJS.Platform;
    architecture: string;
  };
}

export interface ProductValidationCachePolicy {
  schemaVersion: 1;
  mount: 'tmpfs';
  target: string;
  writable: true;
  disposable: true;
}

export const PRODUCT_VALIDATION_CACHE_POLICY: ProductValidationCachePolicy = {
  schemaVersion: 1,
  mount: 'tmpfs',
  target: '/tmp/agent-os-validation-workspace/node_modules/.cache',
  writable: true,
  disposable: true,
};

export interface ProductTurboScratchPolicy {
  schemaVersion: 1;
  mount: 'tmpfs';
  roots: string[];
  writable: true;
  disposable: true;
}

export interface ProductValidationScratchPolicy {
  schemaVersion: 1;
  mount: 'tmpfs';
  /** Relative to the read-only validation workspace; contents are disposable. */
  mounts: string[];
  writable: true;
  disposable: true;
}

const WORKSPACE_DISCOVERY_FORBIDDEN_DIRECTORIES = new Set(['.git', '.turbo', 'node_modules']);

function isWithinRoot(candidate: string, root: string): boolean {
  const relativePath = path.relative(root, candidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function workspaceYamlScalar(value: string, source: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'") || trimmed.length < 2) {
      throw new Error(`Invalid quoted pnpm workspace package pattern in ${source}`);
    }
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === 'string') return parsed;
    } catch {
      // Fall through to the fail-closed error below.
    }
    throw new Error(`Invalid quoted pnpm workspace package pattern in ${source}`);
  }
  const comment = trimmed.indexOf(' #');
  const bare = (comment === -1 ? trimmed : trimmed.slice(0, comment)).trim();
  if (bare.length === 0) {
    throw new Error(`Ambiguous pnpm workspace package pattern in ${source}`);
  }
  return bare;
}

function validatedWorkspacePattern(
  value: string,
  source: string,
): {
  excluded: boolean;
  pattern: string;
} {
  const excluded = value.startsWith('!');
  const pattern = excluded ? value.slice(1) : value;
  if (
    pattern.length === 0 ||
    path.posix.isAbsolute(pattern) ||
    path.win32.isAbsolute(pattern) ||
    pattern.includes('\\') ||
    pattern.includes('\0')
  ) {
    throw new Error(`Unsafe pnpm workspace package pattern in ${source}: ${value}`);
  }
  const segments = pattern.split('/');
  if (
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        (!excluded && WORKSPACE_DISCOVERY_FORBIDDEN_DIRECTORIES.has(segment)),
    )
  ) {
    throw new Error(`Unsafe pnpm workspace package pattern in ${source}: ${value}`);
  }
  try {
    path.matchesGlob('workspace-pattern-probe', pattern);
  } catch {
    throw new Error(`Invalid pnpm workspace package pattern in ${source}: ${value}`);
  }
  return { excluded, pattern };
}

function pnpmWorkspacePatterns(worktree: string): Array<{
  excluded: boolean;
  pattern: string;
}> {
  const source = path.join(worktree, 'pnpm-workspace.yaml');
  const lines = readFileSync(source, 'utf8').split(/\r?\n/u);
  const patterns: string[] = [];
  let packagesSeen = false;
  let inPackages = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const indentation = line.length - line.trimStart().length;
    if (indentation === 0) {
      inPackages = false;
      if (/^packages\s*:/u.test(trimmed)) {
        if (trimmed !== 'packages:' || packagesSeen) {
          throw new Error(`Ambiguous packages definition in ${source}`);
        }
        packagesSeen = true;
        inPackages = true;
      }
      continue;
    }
    if (!inPackages) continue;
    const item = trimmed.match(/^-\s+(.+)$/u);
    if (item?.[1] === undefined) {
      throw new Error(`Invalid packages sequence in ${source}`);
    }
    patterns.push(workspaceYamlScalar(item[1], source));
  }
  if (!packagesSeen || patterns.length === 0) {
    throw new Error(`pnpm workspace packages are missing from ${source}`);
  }
  return patterns.map((pattern) => validatedWorkspacePattern(pattern, source));
}

function directoryEntries(directory: string) {
  return readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function workspacePatternDirectories(root: string, pattern: string): string[] {
  const segments = pattern.split('/');
  const matches = new Set<string>();
  const visit = (directory: string, index: number): void => {
    if (index === segments.length) {
      matches.add(directory);
      return;
    }
    const segment = segments[index];
    if (segment === undefined) return;
    if (segment === '**') {
      visit(directory, index + 1);
      for (const entry of directoryEntries(directory)) {
        if (WORKSPACE_DISCOVERY_FORBIDDEN_DIRECTORIES.has(entry.name)) continue;
        if (entry.isSymbolicLink()) {
          throw new Error(
            `pnpm workspace pattern traversed a symlink: ${path.join(directory, entry.name)}`,
          );
        }
        if (entry.isDirectory()) visit(path.join(directory, entry.name), index);
      }
      return;
    }
    const hasGlob = /[*?[\]{}()]/u.test(segment);
    if (!hasGlob) {
      const child = path.join(directory, segment);
      let metadata;
      try {
        metadata = lstatSync(child);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
        throw error;
      }
      if (metadata.isSymbolicLink()) {
        throw new Error(`pnpm workspace pattern traversed a symlink: ${child}`);
      }
      if (metadata.isDirectory()) visit(child, index + 1);
      return;
    }
    for (const entry of directoryEntries(directory)) {
      if (WORKSPACE_DISCOVERY_FORBIDDEN_DIRECTORIES.has(entry.name)) continue;
      if (!path.matchesGlob(entry.name, segment)) continue;
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`pnpm workspace pattern traversed a symlink: ${child}`);
      }
      if (entry.isDirectory()) visit(child, index + 1);
    }
  };
  visit(root, 0);
  return [...matches];
}

export function discoverTurboScratchRoots(worktree: string): string[] {
  const resolvedRoot = path.resolve(worktree);
  const root = realpathSync(resolvedRoot);
  if (root !== resolvedRoot) {
    throw new Error('Turbo scratch discovery requires a real workspace path');
  }
  const workspaceFile = path.join(root, 'pnpm-workspace.yaml');
  try {
    lstatSync(workspaceFile);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    const rootManifest = path.join(root, 'package.json');
    try {
      const metadata = lstatSync(rootManifest);
      if (metadata.isSymbolicLink()) {
        throw new Error(`package manifest must not be a symlink: ${rootManifest}`);
      }
      return metadata.isFile() ? [''] : [];
    } catch (manifestError) {
      if (
        manifestError instanceof Error &&
        'code' in manifestError &&
        manifestError.code === 'ENOENT'
      ) {
        return [];
      }
      throw manifestError;
    }
  }
  const patterns = pnpmWorkspacePatterns(root);
  const includes = patterns.filter((entry) => !entry.excluded).map((entry) => entry.pattern);
  const excludes = patterns.filter((entry) => entry.excluded).map((entry) => entry.pattern);
  if (includes.length === 0) {
    throw new Error('pnpm workspace must contain at least one package include pattern');
  }
  const candidates = new Set<string>([root]);
  for (const pattern of includes) {
    for (const directory of workspacePatternDirectories(root, pattern)) {
      if (!isWithinRoot(directory, root) || realpathSync(directory) !== directory) {
        throw new Error(`Turbo scratch discovery escaped the validation workspace: ${directory}`);
      }
      candidates.add(directory);
    }
  }
  return [...candidates]
    .filter((directory) => {
      const relative = path.relative(root, directory).replaceAll(path.sep, '/');
      if (relative !== '' && excludes.some((pattern) => path.matchesGlob(relative, pattern))) {
        return false;
      }
      const manifest = path.join(directory, 'package.json');
      let metadata;
      try {
        metadata = lstatSync(manifest);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
        throw error;
      }
      if (metadata.isSymbolicLink()) {
        throw new Error(`pnpm workspace package manifest must not be a symlink: ${manifest}`);
      }
      return metadata.isFile();
    })
    .map((directory) => path.relative(root, directory).replaceAll(path.sep, '/'))
    .sort((left, right) => left.localeCompare(right));
}

export function productTurboScratchPolicy(worktree: string): ProductTurboScratchPolicy {
  return {
    schemaVersion: 1,
    mount: 'tmpfs',
    roots: discoverTurboScratchRoots(worktree),
    writable: true,
    disposable: true,
  };
}

function scratchAncestors(root: string): string[] {
  const result: string[] = [];
  let current = root;
  for (;;) {
    result.push(current);
    if (current === '') return result;
    const parent = path.posix.dirname(current);
    current = parent === '.' ? '' : parent;
  }
}

function canonicalScratchPath(value: string): string {
  const normalized = path.posix.normalize(value).replace(/^\.\//u, '');
  if (
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('\\') ||
    path.posix.isAbsolute(normalized) ||
    normalized.split('/').some((segment) => segment === '..' || segment === '')
  ) {
    throw new Error(`Validation scratch path escaped the workspace: ${value}`);
  }
  return normalized;
}

const CACHE_LOCATION_ARGUMENT =
  /(?:^|\s)--cache-location(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/gu;

function configuredCacheDirectories(worktree: string, packageRoots: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const packageRoot of packageRoots) {
    const manifestPath = path.join(worktree, packageRoot, 'package.json');
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
    } catch (error) {
      throw new Error(`Unable to read authoritative package manifest: ${manifestPath}`, {
        cause: error,
      });
    }
    if (!isRecord(manifest) || !isRecord(manifest['scripts'])) {
      continue;
    }
    for (const [scriptName, scriptValue] of Object.entries(manifest['scripts'])) {
      if (typeof scriptValue !== 'string') {
        throw new Error(`Unsupported non-text package script: ${manifestPath}#${scriptName}`);
      }
      const locations = [...scriptValue.matchAll(CACHE_LOCATION_ARGUMENT)];
      if (scriptValue.includes('--cache-location') && locations.length === 0) {
        throw new Error(`Unsupported cache-location syntax: ${manifestPath}#${scriptName}`);
      }
      for (const locationMatch of locations) {
        const configuredPath = locationMatch[1] ?? locationMatch[2] ?? locationMatch[3];
        if (
          configuredPath === undefined ||
          configuredPath.length === 0 ||
          configuredPath.includes('\0') ||
          configuredPath.includes('\\') ||
          configuredPath.includes('$') ||
          configuredPath.includes('*') ||
          configuredPath.startsWith('~') ||
          path.posix.isAbsolute(configuredPath) ||
          path.win32.isAbsolute(configuredPath)
        ) {
          throw new Error(`Unsafe configured cache location: ${manifestPath}#${scriptName}`);
        }
        const packageDirectory = path.resolve(worktree, packageRoot);
        const configuredAbsolute = path.resolve(packageDirectory, configuredPath);
        if (!isWithinRoot(configuredAbsolute, worktree)) {
          throw new Error(
            `Configured cache location escaped the validation workspace: ${configuredPath}`,
          );
        }
        const relativeConfigured = path.relative(worktree, configuredAbsolute);
        const cacheMarker = relativeConfigured
          .replaceAll(path.sep, '/')
          .split('/')
          .indexOf('.cache');
        const relativeSegments = relativeConfigured.replaceAll(path.sep, '/').split('/');
        const nodeModulesIndex = relativeSegments.indexOf('node_modules');
        if (nodeModulesIndex < 0 || cacheMarker < 0 || cacheMarker !== nodeModulesIndex + 1) {
          throw new Error(
            `Configured cache location is outside node_modules/.cache: ${configuredPath}`,
          );
        }
        const targetAbsolute =
          configuredPath.endsWith('/') || path.posix.basename(configuredPath) === '.cache'
            ? configuredAbsolute
            : path.dirname(configuredAbsolute);
        const targetRelative = canonicalScratchPath(
          path.relative(worktree, targetAbsolute).replaceAll(path.sep, '/'),
        );
        const targetSegments = targetRelative.split('/');
        const targetNodeModulesIndex = targetSegments.indexOf('node_modules');
        if (targetNodeModulesIndex < 0 || targetSegments[targetNodeModulesIndex + 1] !== '.cache') {
          throw new Error(
            `Configured cache directory is outside node_modules/.cache: ${configuredPath}`,
          );
        }
        directories.add(targetRelative);
      }
    }
  }
  return [...directories].sort((left, right) => left.localeCompare(right));
}

/**
 * Derive the complete, bounded write surface before product execution.
 * Workspace-package ancestors are included only for the cache family because
 * pnpm scripts resolve tools such as ESLint from those shared ancestors.
 */
export function productValidationScratchPolicy(
  worktree: string,
  scratchPaths: readonly string[] = [],
): ProductValidationScratchPolicy {
  const packageRoots = discoverTurboScratchRoots(worktree);
  const mounts = new Set<string>(scratchPaths.map(canonicalScratchPath));
  for (const configuredDirectory of configuredCacheDirectories(worktree, packageRoots)) {
    mounts.add(configuredDirectory);
  }
  for (const packageRoot of packageRoots) {
    for (const ancestor of scratchAncestors(packageRoot)) {
      if (ancestor === '') {
        mounts.add(canonicalScratchPath(path.posix.join(ancestor, 'node_modules/.cache')));
      }
    }
    mounts.add(canonicalScratchPath(path.posix.join(packageRoot, 'node_modules/.cache')));
    mounts.add(canonicalScratchPath(path.posix.join(packageRoot, 'node_modules/.vite-temp')));
    mounts.add(canonicalScratchPath(path.posix.join(packageRoot, '.turbo')));
  }
  return {
    schemaVersion: 1,
    mount: 'tmpfs',
    mounts: [...mounts].sort((left, right) => {
      const depth = (value: string) => value.split('/').length;
      return depth(left) - depth(right) || left.localeCompare(right);
    }),
    writable: true,
    disposable: true,
  };
}

export function productExecutionIdentity(
  request: HostValidationRequest,
  policy: HostValidationPolicy,
  dependencyPreparationKey: string,
  hostEnvironment: NodeJS.ProcessEnv = process.env,
  environmentNames: readonly string[] = PRODUCT_EXECUTION_ENVIRONMENT_NAMES,
  scratchPaths: readonly string[] = [],
): ProductExecutionIdentity {
  const environmentFingerprint = secretSafeEnvironmentFingerprint(
    productExecutionEnvironment(hostEnvironment, request.gitControlDirectory, environmentNames),
    environmentNames,
  );
  const turboScratchPolicy = productTurboScratchPolicy(request.worktree);
  const validationToolScratchPolicy = productValidationScratchPolicy(
    request.worktree,
    scratchPaths,
  );
  const details = {
    schemaVersion: 1 as const,
    environmentFingerprint,
    sandboxCachePolicy: PRODUCT_VALIDATION_CACHE_POLICY,
    turboScratchPolicy,
    validationToolScratchPolicy,
    dependencyPreparationKey,
    candidateSha: request.candidateSha,
    checkId: request.checkId,
    command: [...policy.command],
    node: {
      executable: realpathSync(process.execPath),
      version: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
  };
  return {
    ...details,
    key: createHash('sha256').update(JSON.stringify(details)).digest('hex'),
  };
}

export function dependencyBootstrapEnvironment(
  hostEnvironment: NodeJS.ProcessEnv = process.env,
  configuredEnvironment: Readonly<Record<string, string>> = loadValidationProfile().bootstrap
    .environment,
): Record<string, string> {
  return {
    PATH: hostEnvironment['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: hostEnvironment['HOME'] ?? homedir(),
    CI: 'true',
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    ...configuredEnvironment,
  };
}

function resolvedBootstrapToolIdentity(
  command: readonly string[],
  environment: Record<string, string>,
): BootstrapToolIdentity {
  const tool = command[0];
  if (tool === undefined) return { executable: 'NONE', version: 'NONE' };
  const result = spawnSync(tool, ['--version'], {
    encoding: 'utf8',
    env: environment,
  });
  const version =
    result.status === 0 ? result.stdout.trim() : `UNAVAILABLE:${result.error?.message ?? 'exit'}`;
  let executable = `UNRESOLVED:${tool}`;
  for (const directory of (environment['PATH'] ?? '').split(path.delimiter)) {
    const candidate = path.join(directory, process.platform === 'win32' ? `${tool}.cmd` : tool);
    try {
      accessSync(candidate, constants.X_OK);
      executable = realpathSync(candidate);
      break;
    } catch {
      // Continue through the fixed PATH until the executable is resolved.
    }
  }
  return { executable, version };
}

export function dependencyPreparationIdentity(
  worktree: string,
  options: {
    hostEnvironment?: NodeJS.ProcessEnv;
    bootstrapTool?: BootstrapToolIdentity;
    bootstrapCommand?: readonly string[];
    bootstrapEnvironment?: Readonly<Record<string, string>>;
    dependencyFiles?: readonly string[];
  } = {},
): DependencyPreparationIdentity {
  const profile = loadValidationProfile();
  const command = dependencyBootstrapCommand(options.bootstrapCommand ?? profile.bootstrap.command);
  const environment = dependencyBootstrapEnvironment(
    options.hostEnvironment,
    options.bootstrapEnvironment ?? profile.bootstrap.environment,
  );
  const bootstrapTool =
    options.bootstrapTool ?? resolvedBootstrapToolIdentity(command, environment);
  const details = {
    schemaVersion: 1 as const,
    bootstrapTool,
    command,
    environment,
    node: {
      executable: realpathSync(process.execPath),
      version: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    candidateDependencyKey: dependencyEnvironmentKey(
      worktree,
      environment,
      options.dependencyFiles ?? profile.bootstrap.dependencyFiles,
    ),
  };
  const key = createHash('sha256').update(JSON.stringify(details)).digest('hex');
  return { ...details, key };
}

const PRODUCT_EXECUTION_WRAPPER = String.raw`
const { spawn } = require('node:child_process');
const token = process.env.AGENT_OS_PRODUCT_ATTESTATION_TOKEN;
const command = process.argv[1];
const args = process.argv.slice(2);
const childEnvironment = { ...process.env };
delete childEnvironment.AGENT_OS_PRODUCT_ATTESTATION_TOKEN;
let attestationWritten = false;
const attest = (productStarted, failure) => {
  if (attestationWritten) return;
  attestationWritten = true;
  const payload = { schemaVersion: 1, token, productStarted, ...(failure ? { failure } : {}) };
  process.stdout.write(${JSON.stringify(EXECUTION_ATTESTATION_PREFIX)} + JSON.stringify(payload) + '\n');
};
if (!token || !command) {
  attest(false, 'trusted product launcher input is missing');
  process.exit(127);
}
const child = spawn(command, args, { env: childEnvironment, stdio: 'inherit' });
child.once('spawn', () => attest(true));
child.once('error', (error) => {
  attest(false, error.message);
  process.exitCode = 127;
});
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 128 : 1);
});
`;

export function sandboxedHostCommand(
  request: HostValidationRequest,
  policy: HostValidationPolicy,
  command: readonly string[] = policy.command,
  scratchPaths: readonly string[] = [],
): string[] {
  const workspace = '/tmp/agent-os-validation-workspace';
  const gitControl = '/tmp/agent-os-validation-git-control';
  const scratchPolicy = productValidationScratchPolicy(request.worktree, scratchPaths);
  const scratchMounts = scratchPolicy.mounts.flatMap((relativePath) => [
    '--tmpfs',
    path.posix.join(workspace, relativePath),
  ]);
  return [
    'bwrap',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--die-with-parent',
    '--new-session',
    '--ro-bind',
    '/',
    '/',
    '--proc',
    '/proc',
    '--dev-bind',
    '/dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--ro-bind',
    request.worktree,
    workspace,
    ...scratchMounts,
    ...(request.gitControlDirectory === undefined
      ? []
      : [
          '--ro-bind',
          request.gitControlDirectory,
          gitControl,
          '--setenv',
          'GIT_DIR',
          gitControl,
          '--setenv',
          'GIT_WORK_TREE',
          workspace,
        ]),
    '--setenv',
    'TMPDIR',
    '/tmp',
    '--setenv',
    'XDG_CACHE_HOME',
    '/tmp/cache',
    '--chdir',
    workspace,
    '--',
    realpathSync(process.execPath),
    '-e',
    PRODUCT_EXECUTION_WRAPPER,
    '--',
    ...command,
  ];
}

interface ProductScratchDirectoryPreparation {
  directory: string;
  createdDirectories: string[];
}

interface ProductValidationScratchPreparation {
  directories: ProductScratchDirectoryPreparation[];
}

async function prepareScratchDirectory(
  worktree: string,
  relativePath: string,
): Promise<ProductScratchDirectoryPreparation> {
  const directory = path.join(worktree, ...relativePath.split('/'));
  const missing: string[] = [];
  let current = worktree;
  for (const segment of relativePath.split('/')) {
    current = path.join(current, segment);
    const existing = await fs.lstat(current).catch(() => undefined);
    if (existing === undefined) {
      missing.push(current);
      continue;
    }
    if (existing.isSymbolicLink()) {
      throw new Error(`validation scratch path traversed a symlink: ${current}`);
    }
    if (!existing.isDirectory()) {
      throw new Error(`validation scratch path is not a directory: ${current}`);
    }
  }
  if (missing.length > 0) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  return { directory, createdDirectories: missing };
}

async function prepareProductValidationScratch(
  worktree: string,
  scratchPaths: readonly string[] = [],
): Promise<ProductValidationScratchPreparation> {
  const directories: ProductScratchDirectoryPreparation[] = [];
  try {
    for (const relativePath of productValidationScratchPolicy(worktree, scratchPaths).mounts) {
      directories.push(await prepareScratchDirectory(worktree, relativePath));
    }
    return { directories };
  } catch (error) {
    await disposeProductValidationScratch({ directories });
    throw error;
  }
}

async function disposeProductValidationScratch(
  preparation: ProductValidationScratchPreparation,
): Promise<void> {
  const created = new Set<string>();
  for (const directory of preparation.directories) {
    for (const createdDirectory of directory.createdDirectories) created.add(createdDirectory);
  }
  for (const directory of [...created].sort((left, right) => right.length - left.length)) {
    await fs.rmdir(directory).catch(() => undefined);
  }
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
