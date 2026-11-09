// src/agent/host-validation-policy.ts
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { PRODUCT_VALIDATION_CACHE_POLICY } from './host-validation-types';
import { dependencyEnvironmentKey } from './resource-policy';
import { EXECUTION_ATTESTATION_PREFIX } from './resource-scheduler';
import { loadValidationProfile } from './validation-profile';

import type {
  BootstrapToolIdentity,
  DependencyPreparationIdentity,
  HostValidationPolicy,
  HostValidationRequest,
  ProductExecutionEnvironment,
  ProductExecutionIdentity,
  ProductTurboScratchPolicy,
  ProductValidationScratchPolicy,
} from './host-validation-types';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function dependencyBootstrapCommand(
  command: readonly string[] = loadValidationProfile().bootstrap.command,
): string[] {
  return [...command];
}

export const PRODUCT_EXECUTION_ENVIRONMENT_NAMES = loadValidationProfile().environmentNames;

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

export interface ProductScratchDirectoryPreparation {
  directory: string;
  createdDirectories: string[];
}

export interface ProductValidationScratchPreparation {
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

export async function prepareProductValidationScratch(
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

export async function disposeProductValidationScratch(
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
