// src/agent/controller-runtime.ts
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const FULL_SHA = /^[0-9a-f]{40,64}$/u;

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function taskId(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_TASK_ID.test(value) ? value : undefined;
}

function fullSha(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.toLowerCase();
  return FULL_SHA.test(normalized) ? normalized : undefined;
}

async function git(args: readonly string[]): Promise<string> {
  return (
    await execFileAsync('git', [...args], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout.trim();
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

async function ensureDurableObjectStore(store: string): Promise<void> {
  if ((await fs.lstat(store).catch(() => undefined)) === undefined) {
    await git(['init', '--bare', store]);
    await fs.chmod(store, 0o700);
  }
  const status = await fs.lstat(store);
  if (!status.isDirectory() || status.isSymbolicLink() || (await fs.realpath(store)) !== store) {
    throw new Error('controller object store must be a real directory');
  }
  if (
    (await fs.lstat(path.join(store, 'objects', 'info', 'alternates')).catch(() => undefined)) !==
    undefined
  ) {
    throw new Error('controller object store cannot use object alternates');
  }
  if ((await git(['--git-dir', store, 'rev-parse', '--is-bare-repository'])) !== 'true') {
    throw new Error('controller object store must be bare');
  }
}

async function fsyncImportedGit(store: string, ref: string): Promise<void> {
  const packDirectory = path.join(store, 'objects', 'pack');
  for (const entry of await fs.readdir(packDirectory).catch(() => [])) {
    const handle = await fs.open(path.join(packDirectory, entry), 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const refFile = path.join(store, ...ref.split('/'));
  const refHandle = await fs.open(refFile, 'r');
  try {
    await refHandle.sync();
  } finally {
    await refHandle.close();
  }
  for (const directoryPath of [
    packDirectory,
    path.join(store, 'objects'),
    path.dirname(refFile),
    store,
  ]) {
    const handle = await fs.open(directoryPath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

export function controllerRoot(): string {
  return path.resolve(
    process.env['AGENT_OS_CONTROLLER_DIR'] ?? path.join(homedir(), '.local', 'state', 'agent-os'),
  );
}

export interface LegacyAdoptionReport {
  schemaVersion: 2;
  authority: 'NON_AUTHORITATIVE';
  legacyRoot: string;
  quarantineManifest: string;
  adopted: Array<{
    taskId: string;
    generation: number;
    taskBinding: 'LEGACY_DISCOVERY_ONLY';
    candidateSha: string;
    candidateTreeSha: string;
    durableCandidateRef: string;
    durableStoreGitDirectory: string;
    captureRecord: string;
    reviewStatus: 'REVIEW_REQUIRED';
  }>;
  unresolved: string[];
  createdAt: string;
}

interface LegacyCandidateDiscovery {
  taskId: string;
  generation: number;
  candidateSha: string;
  candidateTreeSha: string;
  legacyStore: string;
}

function discoverLegacyCandidate(value: unknown): LegacyCandidateDiscovery | string {
  if (typeof value !== 'object' || value === null) return 'task record is malformed';
  const task = value as Record<string, unknown>;
  const normalizedTask = taskId(task['id']);
  const generation = task['generation'];
  if (normalizedTask === undefined || !Number.isSafeInteger(generation) || Number(generation) < 0) {
    return 'task identity or generation is missing';
  }
  const captured = task['capturedCandidate'];
  if (typeof captured !== 'object' || captured === null) {
    return `${normalizedTask}: durable candidate capture is missing`;
  }
  const candidate = captured as Record<string, unknown>;
  const candidateSha = fullSha(candidate['candidateSha']);
  const candidateTreeSha = fullSha(candidate['treeSha']);
  const legacyStore =
    typeof candidate['storeGitDirectory'] === 'string'
      ? path.resolve(candidate['storeGitDirectory'])
      : undefined;
  if (candidateSha === undefined || candidateTreeSha === undefined || legacyStore === undefined) {
    return `${normalizedTask}: capture record is incomplete`;
  }
  return {
    taskId: normalizedTask,
    generation: Number(generation),
    candidateSha,
    candidateTreeSha,
    legacyStore,
  };
}

async function importLegacyCandidate(
  discovery: LegacyCandidateDiscovery,
  hostRoot: string,
  now: string,
): Promise<LegacyAdoptionReport['adopted'][number]> {
  const legacyStore = await fs.realpath(discovery.legacyStore);
  const sourceCommit = await git([
    '--git-dir',
    legacyStore,
    'rev-parse',
    '--verify',
    `${discovery.candidateSha}^{commit}`,
  ]);
  const sourceTree = await git([
    '--git-dir',
    legacyStore,
    'rev-parse',
    '--verify',
    `${discovery.candidateSha}^{tree}`,
  ]);
  if (sourceCommit !== discovery.candidateSha || sourceTree !== discovery.candidateTreeSha) {
    throw new Error('legacy candidate SHA/tree cannot be verified');
  }

  const store = path.join(hostRoot, 'object-store.git');
  await ensureDurableObjectStore(store);
  const ref = `refs/candidates/${discovery.taskId}/${discovery.candidateSha}`;
  await git([
    '-c',
    'fetch.unpackLimit=0',
    '--git-dir',
    store,
    'fetch',
    '--no-tags',
    legacyStore,
    `${discovery.candidateSha}:${ref}`,
  ]);
  const imported = await git(['--git-dir', store, 'rev-parse', '--verify', ref]);
  const importedTree = await git(['--git-dir', store, 'rev-parse', '--verify', `${ref}^{tree}`]);
  if (imported !== discovery.candidateSha || importedTree !== discovery.candidateTreeSha) {
    throw new Error('controller import did not preserve candidate SHA/tree');
  }
  await git(['--git-dir', store, 'fsck', '--connectivity-only', discovery.candidateSha]);
  await fsyncImportedGit(store, ref);

  const captureDirectory = path.join(hostRoot, 'captures');
  await fs.mkdir(captureDirectory, { recursive: true, mode: 0o700 });
  const captureRecord = path.join(
    captureDirectory,
    `${discovery.taskId}.g${String(discovery.generation)}-${discovery.candidateSha}.json`,
  );
  const adopted: LegacyAdoptionReport['adopted'][number] = {
    taskId: discovery.taskId,
    generation: discovery.generation,
    taskBinding: 'LEGACY_DISCOVERY_ONLY',
    candidateSha: discovery.candidateSha,
    candidateTreeSha: discovery.candidateTreeSha,
    durableCandidateRef: ref,
    durableStoreGitDirectory: store,
    captureRecord,
    reviewStatus: 'REVIEW_REQUIRED',
  };
  await durableWrite(captureRecord, {
    schemaVersion: 1,
    source: 'LEGACY_DISCOVERY_IMPORT',
    ...adopted,
    capturedAt: now,
  });
  return adopted;
}

/**
 * Legacy state is discovery input only. Candidate objects may be imported into
 * the new controller store, but no legacy review or readiness claim is copied.
 */
export async function adoptLegacyState(input: {
  legacyRoot: string;
  hostRoot?: string;
  now?: Date;
  allowUnsafeTestRuntime?: boolean;
}): Promise<LegacyAdoptionReport> {
  const legacyRoot = await fs.realpath(path.resolve(input.legacyRoot));
  const hostRoot = path.resolve(input.hostRoot ?? controllerRoot());
  await ensureControllerRuntimeDirectory(hostRoot, {
    allowUnsafeTestRuntime: input.allowUnsafeTestRuntime === true,
  });
  if (isWithin(legacyRoot, hostRoot) || isWithin(hostRoot, legacyRoot)) {
    throw new Error('legacy state root must be separate from the controller-owned host root');
  }

  const unresolved: string[] = [];
  const adopted: LegacyAdoptionReport['adopted'] = [];
  const statePath = path.join(legacyRoot, 'orchestration-state.json');
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(await fs.readFile(statePath, 'utf8')) as Record<string, unknown>;
  } catch {
    unresolved.push('orchestration-state.json is missing or unreadable');
    state = {};
  }
  const tasks = Array.isArray(state['tasks']) ? state['tasks'] : [];
  for (const value of tasks) {
    const discovery = discoverLegacyCandidate(value);
    if (typeof discovery === 'string') {
      unresolved.push(discovery);
      continue;
    }
    try {
      adopted.push(
        await importLegacyCandidate(discovery, hostRoot, (input.now ?? new Date()).toISOString()),
      );
      unresolved.push(
        `${discovery.taskId}@${String(discovery.generation)}: legacy task/review authority is untrusted; REVIEW_REQUIRED`,
      );
    } catch (error) {
      unresolved.push(
        `${discovery.taskId}@${String(discovery.generation)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const createdAt = (input.now ?? new Date()).toISOString();
  const digest = createHash('sha256')
    .update(
      `${legacyRoot}\0${createdAt}\0${JSON.stringify(adopted)}\0${JSON.stringify(unresolved)}`,
    )
    .digest('hex');
  const quarantineDirectory = path.join(hostRoot, 'legacy-quarantine');
  await fs.mkdir(quarantineDirectory, { recursive: true, mode: 0o700 });
  const quarantineManifest = path.join(quarantineDirectory, `${digest}.json`);
  const report: LegacyAdoptionReport = {
    schemaVersion: 2,
    authority: 'NON_AUTHORITATIVE',
    legacyRoot,
    quarantineManifest,
    adopted,
    unresolved,
    createdAt,
  };
  await durableWrite(quarantineManifest, report);
  return report;
}

export async function ensureControllerRuntimeDirectory(
  runtimeDirectory: string,
  options: { allowUnsafeTestRuntime?: boolean } = {},
): Promise<void> {
  const runtimeDir = path.resolve(runtimeDirectory);
  const authorityRoot = controllerRoot();
  if (options.allowUnsafeTestRuntime !== true) {
    if (!isWithin(runtimeDir, authorityRoot)) {
      throw new Error(`controller runtime must be within ${authorityRoot}`);
    }
    if (isWithin(authorityRoot, '/tmp') || isWithin(authorityRoot, process.cwd())) {
      throw new Error(
        'controller runtime is worker-writable; authoritative state requires a host-only root',
      );
    }
  }
  await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const status = await fs.lstat(runtimeDir);
  const real = await fs.realpath(runtimeDir);
  const uid = process.getuid?.();
  if (
    status.isSymbolicLink() ||
    real !== runtimeDir ||
    !status.isDirectory() ||
    (uid !== undefined && status.uid !== uid) ||
    (status.mode & 0o077) !== 0
  ) {
    throw new Error(`Unsafe controller runtime directory: ${runtimeDir}`);
  }
}
