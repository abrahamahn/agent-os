// src/agent/resource-scheduler.ts
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { cpus, freemem, loadavg, platform, totalmem } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';

import {
  hasCapability,
  loadCapabilityManifest,
  workerCapabilities,
  workerPriority,
  type CapabilityManifest,
} from '../control-plane/capability-manifest';
import { controlPlaneRuntime } from '../control-plane/runtime';

export type AgentId = string;

export const RESOURCE_LIMITS = { medium: 2, heavy: 1 } as const;
export const JOB_STATUSES = [
  'RUNNING',
  'QUEUED',
  'REUSED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

export type ResourceClass = keyof typeof RESOURCE_LIMITS;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface ResourceJob {
  id: string;
  agent: AgentId;
  resource: ResourceClass;
  command: string[];
  commandKey: string;
  broad: boolean;
  operatingPhase: string;
  worktree: string;
  candidateSha?: string | undefined;
  environmentKey: string;
  reuseEligible: boolean;
  executionAttestationRequired?: boolean;
  executionAttested?: boolean;
  status: JobStatus;
  ownerPid: number;
  ownerStartTicks?: string | undefined;
  childPid?: number | undefined;
  childStartTicks?: string | undefined;
  processGroup?: number | undefined;
  queuedAt: string;
  startedAt?: string;
  leaseAt?: string;
  finishedAt?: string;
  exitCode?: number | undefined;
  reusedFrom?: string;
  duplicateOf?: string;
  failure?: string | undefined;
  orphaned?: boolean;
}

export interface ResourceState {
  version: 1;
  duplicateJobsPrevented: number;
  jobs: ResourceJob[];
}

export interface JobRequest {
  agent: AgentId;
  resource: ResourceClass;
  command: string[];
  worktree: string;
  candidateSha?: string | undefined;
  environmentKey?: string;
  reuseEligible?: boolean;
  executionAttestationRequired?: boolean;
}

export interface RunRequest extends JobRequest {
  childEnvironment?: Readonly<Record<string, string | undefined>>;
  childEnvironmentMode?: 'merge' | 'replace';
  executionAttestation?: {
    token: string;
  };
}

export interface RunExecutionEvidence {
  productStarted: boolean;
  source: 'ATTESTED' | 'REUSED';
  failure?: string;
}

export interface RunResult {
  job: ResourceJob;
  exitCode: number;
  commandStarted: boolean;
  execution?: RunExecutionEvidence;
}

export type ResourceRunResult = RunResult;

export interface ResourceRunHooks {
  onLeaseAcquired?: (job: ResourceJob) => void | Promise<void>;
}

export const EXECUTION_ATTESTATION_PREFIX = 'AGENT_OS_EXECUTION_ATTESTATION:';

export interface MachinePressure {
  high: boolean;
  reasons: string[];
  loadRatio: number;
  freeMemoryRatio: number;
  processCount: number;
}

export interface SharedDevProcess {
  pid: number;
  cwd: string;
  command: string;
}

export interface SharedDevStatus {
  state: 'healthy' | 'stopped' | 'unobservable';
  matches: SharedDevProcess[];
}

export interface SchedulerOptions {
  runtimeDir?: string;
  pollMs?: number;
  pressureProvider?: () => MachinePressure;
  now?: () => Date;
  capabilities?: CapabilityManifest;
  capabilityManifest?: CapabilityManifest;
  capabilityManifestProvider?: () => CapabilityManifest;
}

export interface CleanupResult {
  staleLeases: number;
  orphanProcesses: number;
}

const STATE_FILE = 'state.json';
const LOCK_DIR = 'state.lock';
const LOCK_OWNER_FILE = 'owner.json';
const HISTORY_LIMIT = 250;
const LOCK_STALE_MS = 30_000;
const CONTROL_PLANE_COMMAND_PATTERN =
  /(?:src\/(?:agent|control-plane|process|validation)|agent-(?:os|substrate|resource)|process-guardian|quality-control|validation-evidence|resource-(?:run|status|cleanup)|process-(?:status|cleanup)|git\s+commit)/iu;

function emptyState(): ResourceState {
  return { version: 1, duplicateJobsPrevented: 0, jobs: [] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function ensureRuntimeDir(runtimeDir: string): void {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
}

function readProcessStartTicks(pid: number): string | undefined {
  if (pid <= 0 || platform() !== 'linux') return undefined;
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
    return fields[19];
  } catch {
    return undefined;
  }
}

function isSameProcess(pid: number | undefined, startTicks?: string): boolean {
  if (pid === undefined || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (startTicks === undefined || platform() !== 'linux') return true;
  return readProcessStartTicks(pid) === startTicks;
}

function terminateTrackedProcessGroup(job: ResourceJob): boolean {
  if (!isSameProcess(job.childPid, job.childStartTicks)) return false;
  try {
    if (platform() !== 'win32' && job.processGroup !== undefined) {
      process.kill(-job.processGroup, 'SIGTERM');
    } else if (job.childPid !== undefined) {
      process.kill(job.childPid, 'SIGTERM');
    }
    return true;
  } catch {
    return false;
  }
}

function trimHistory(state: ResourceState): void {
  if (state.jobs.length <= HISTORY_LIMIT) return;
  const active = state.jobs.filter((job) => job.status === 'RUNNING' || job.status === 'QUEUED');
  const settled = state.jobs.filter((job) => job.status !== 'RUNNING' && job.status !== 'QUEUED');
  state.jobs = [...settled.slice(-(HISTORY_LIMIT - active.length)), ...active];
}

function cleanupStaleState(state: ResourceState, now: string): CleanupResult {
  let staleLeases = 0;
  let orphanProcesses = 0;

  for (const job of state.jobs) {
    if (job.status === 'CANCELLED' && job.orphaned === true) {
      if (!isSameProcess(job.childPid, job.childStartTicks)) {
        job.orphaned = false;
      } else if (terminateTrackedProcessGroup(job)) {
        orphanProcesses += 1;
      }
      continue;
    }
    if (job.status !== 'RUNNING' && job.status !== 'QUEUED') continue;
    if (isSameProcess(job.ownerPid, job.ownerStartTicks)) continue;

    staleLeases += 1;
    if (job.status === 'RUNNING' && isSameProcess(job.childPid, job.childStartTicks)) {
      if (terminateTrackedProcessGroup(job)) orphanProcesses += 1;
      job.orphaned = isSameProcess(job.childPid, job.childStartTicks);
    }
    job.status = 'CANCELLED';
    job.finishedAt = now;
    job.failure = 'stale lease owner exited';
  }

  return { staleLeases, orphanProcesses };
}

function writeState(runtimeDir: string, state: ResourceState): void {
  trimHistory(state);
  const temporary = join(runtimeDir, `.state-${String(process.pid)}-${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, join(runtimeDir, STATE_FILE));
}

function readState(runtimeDir: string): ResourceState {
  const statePath = join(runtimeDir, STATE_FILE);
  let state: unknown;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8')) as unknown;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return emptyState();
    throw new Error(`resource scheduler state is unreadable: ${statePath}`, {
      cause: error,
    });
  }
  if (
    typeof state !== 'object' ||
    state === null ||
    !('version' in state) ||
    state.version !== 1 ||
    !('duplicateJobsPrevented' in state) ||
    typeof state.duplicateJobsPrevented !== 'number' ||
    !('jobs' in state) ||
    !Array.isArray(state.jobs)
  ) {
    throw new Error(`resource scheduler state has an unsupported schema: ${statePath}`);
  }
  return state as ResourceState;
}

function releaseLock(lockDir: string): void {
  rmSync(join(lockDir, LOCK_OWNER_FILE), { force: true });
  try {
    rmdirSync(lockDir);
  } catch {
    // A future lock version may add diagnostics. Never remove an unknown directory tree.
  }
}

async function acquireLock(runtimeDir: string, pollMs: number): Promise<string> {
  ensureRuntimeDir(runtimeDir);
  const lockDir = join(runtimeDir, LOCK_DIR);

  for (;;) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      writeFileSync(
        join(lockDir, LOCK_OWNER_FILE),
        `${JSON.stringify({ pid: process.pid, startTicks: readProcessStartTicks(process.pid) })}\n`,
        { mode: 0o600 },
      );
      return lockDir;
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code !== 'EEXIST') throw error;

      const owner = readJson(join(lockDir, LOCK_OWNER_FILE)) as
        { pid: number; startTicks?: string } | undefined;
      let oldEnough = false;
      try {
        oldEnough = Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS;
      } catch {
        // The lock disappeared between reads; retry immediately.
      }
      if (oldEnough && (owner === undefined || !isSameProcess(owner.pid, owner.startTicks))) {
        releaseLock(lockDir);
        continue;
      }
      await sleep(pollMs);
    }
  }
}

export function normalizeCommand(command: readonly string[]): string {
  return JSON.stringify(command);
}

function commandText(command: readonly string[]): string {
  return command.join(' ').toLowerCase();
}

export function isForbiddenAgentCommand(command: readonly string[]): boolean {
  if (command.length === 0) return true;
  const executable = basename(command[0] ?? '').toLowerCase();
  const text = commandText(command);
  const pnpmPersistent =
    /(?:^|\s)(?:pnpm(?:\.cjs)?|npm|yarn|bun)\s+(?:(?:-w|--workspace-root|--filter(?:=\S+|\s+\S+))\s+)*(?:run\s+)?(?:dev(?::[\w-]+)?|serve|start)(?:\s|$)/i.test(
      text,
    );
  const persistent =
    executable === 'vite' ||
    executable === 'uvicorn' ||
    executable === 'gunicorn' ||
    /(?:^|\s)vite(?:\s|$)/i.test(text) ||
    executable === 'nohup' ||
    /(?:^|\s)nohup(?:\s|$)/i.test(text) ||
    /(?:^|\s)tmux[^\n]*(?:\s-ds?(?:\s|$)|new-session\s+-d)/i.test(text) ||
    /(?:^|\s)docker(?:\s+compose)?[^\n]*(?:\s--detach|\s-d)(?:\s|$)/i.test(text) ||
    /(?:^|\s)(?:--watch|--watchall|--persistent)(?:=|\s|$)/i.test(text) ||
    /turbo[^\n]*(?:watch|--watch|--persistent)/i.test(text) ||
    /(?:^|\s)(?:cargo\s+watch|watchexec|air)(?:\s|$)/i.test(text) ||
    /(?:^|\s)(?:cargo|go|dotnet)\s+run(?:\s|$)/i.test(text) ||
    /(?:^|\s)(?:python(?:\d+(?:\.\d+)*)?\s+-m\s+(?:http\.server|uvicorn)|flask\s+run)(?:\s|$)/i.test(
      text,
    ) ||
    /main\/tools\/scripts\/dev\/main\.ts/i.test(text) ||
    command.some((part) => part === '&' || /(?:^|[^&])&$/.test(part));
  return pnpmPersistent || persistent;
}

export function isBroadCommand(command: readonly string[]): boolean {
  const executable = basename(command[0] ?? '').toLowerCase();
  const args = command.slice(1);
  const text = args.join(' ').toLowerCase();
  const hasFilter = args.some((arg) => arg === '--filter' || arg.startsWith('--filter='));

  if (/(?:^|\s)ci:[\w:-]+(?:\s|$)/.test(text)) {
    return true;
  }
  if (executable === 'pnpm' && !hasFilter) {
    const withoutOptions = args.filter(
      (arg) =>
        arg !== 'run' && arg !== '-w' && arg !== '--workspace-root' && !arg.startsWith('--dir'),
    );
    const script = withoutOptions[0] ?? '';
    if (
      [
        'lint',
        'lint:fast',
        'lint:merge-gate',
        'type-check',
        'test',
        'test:coverage',
        'test:full',
        'build',
        'check:changed',
      ].includes(script)
    ) {
      return true;
    }
  }
  if (['npm', 'yarn', 'bun'].includes(executable) && !hasFilter) {
    const script = args.find((arg) => arg !== 'run' && !arg.startsWith('-')) ?? '';
    if (/^(?:lint|type-?check|test|build|check)(?::[\w-]+)?$/u.test(script)) return true;
  }
  if (['pnpm', 'npm', 'yarn', 'bun'].includes(executable)) {
    const execIndex = args.findIndex((arg) => arg === 'exec' || arg === 'x');
    if (execIndex >= 0) {
      const nestedCommand = args.slice(execIndex + 1).filter((arg) => arg !== '--');
      if (nestedCommand.length > 0 && isBroadCommand(nestedCommand)) return true;
    }
  }
  if ((executable === 'turbo' || /(?:^|\s)turbo(?:\s|$)/.test(text)) && !hasFilter) {
    return /(?:^|\s)(?:run\s+)?(?:lint|type-check|test|build)(?:\s|$)/.test(text);
  }
  if (executable === 'cargo') {
    return (
      /^(?:build|check|clippy|doc|test|bench)$/u.test(args[0] ?? '') &&
      !args.some((arg) => ['-p', '--package', '--bin', '--example', '--test'].includes(arg))
    );
  }
  if (executable === 'go' && args[0] === 'test') return args.includes('./...');
  if (executable === 'pytest' || executable === 'py.test') {
    return !args.some((arg) => !arg.startsWith('-'));
  }
  if (['mvn', 'mvnw', 'gradle', 'gradlew', 'dotnet'].includes(executable)) {
    return args.some((arg) => /^(?:build|check|package|test|verify)$/u.test(arg));
  }
  if (['make', 'gmake'].includes(executable)) {
    return args.some((arg) => /^(?:all|build|check|test|verify)$/u.test(arg));
  }
  if (executable === 'tsc') {
    const hasProject = args.some(
      (arg, index) =>
        arg === '--project' ||
        arg === '-p' ||
        arg.startsWith('--project=') ||
        ((args[index - 1] === '--build' || args[index - 1] === '-b') && !arg.startsWith('-')),
    );
    const hasSourceFile = args.some((arg) => /\.[cm]?[jt]sx?$/iu.test(arg));
    return !hasProject && !hasSourceFile;
  }
  if (executable === 'vitest') {
    const targets = args.filter(
      (arg) => !arg.startsWith('-') && !['run', 'watch', 'related'].includes(arg),
    );
    return targets.length === 0;
  }
  if (executable === 'eslint') {
    const targets = args.filter((arg) => !arg.startsWith('-'));
    return targets.length === 0 || targets.includes('.');
  }
  return false;
}

export function requiredResource(command: readonly string[]): ResourceClass | undefined {
  const text = commandText(command);
  if (
    isBroadCommand(command) ||
    isDeployCommand(command) ||
    isReleaseCommand(command) ||
    /(?:playwright|test(?::|-)e2e|real-db|postgres-smoke|docker\s+(?:compose\s+)?build)/i.test(text)
  ) {
    return 'heavy';
  }
  return undefined;
}

export function isDeployCommand(command: readonly string[]): boolean {
  const text = commandText(command);
  return (
    /(?:^|\s)(?:pnpm|npm|yarn)(?:\s+run)?\s+deploy(?::[\w-]+)?(?:\s|$)/u.test(text) ||
    /(?:^|\s)wrangler\s+deploy(?:\s|$)/u.test(text) ||
    /main\/tools\/scripts\/deploy\//u.test(text)
  );
}

export function isReleaseCommand(command: readonly string[]): boolean {
  const text = commandText(command);
  return (
    /(?:^|\s)git\s+push(?:\s|$)/u.test(text) ||
    /(?:^|\s)gh\s+release(?:\s|$)/u.test(text) ||
    /(?:^|\s)(?:npm|pnpm)\s+publish(?:\s|$)/u.test(text)
  );
}

export function rolePolicy(
  agent: AgentId,
  manifest = loadCapabilityManifest(),
): string | undefined {
  const policy = workerCapabilities(manifest, agent);
  if (policy === undefined) return undefined;
  const roles = policy.lifecycleRoles?.join(', ') || 'worker';
  return `${roles}. Capabilities: ${policy.capabilities.join(', ') || 'light only'}.`;
}

export function dispatchPolicy(agent: AgentId, manifest = loadCapabilityManifest()): string {
  const policy = rolePolicy(agent, manifest);
  if (policy === undefined) throw new Error(`Unknown agent: ${agent}`);
  return [
    `RESOURCE POLICY (${manifest.activePhase}; ${agent}): ${policy}`,
    'Persistent development processes are target-owned and must follow the target adapter policy.',
    'Never start, restart, stop, or kill shared servers/watchers without explicit target authorization.',
    'Run MEDIUM/HEAVY commands only through: pnpm agent-resource run --worktree <path> --agent ' +
      `${agent} --resource <medium|heavy> -- <command>.`,
    'Continue LIGHT coding/review work while a validation job is queued.',
  ].join('\n');
}

export function authorizeCommand(
  agent: AgentId,
  resource: ResourceClass,
  command: readonly string[],
  manifest = loadCapabilityManifest(),
): string | undefined {
  const policy = workerCapabilities(manifest, agent);
  if (policy === undefined) return `Unknown worker in ${manifest.activePhase}: ${agent}`;
  if (isForbiddenAgentCommand(command)) {
    return 'Agents may not start persistent dev servers, watchers, or background sessions.';
  }
  const required = requiredResource(command);
  if (required === 'heavy' && resource !== 'heavy') {
    return 'This command is HEAVY and must request the heavy resource class.';
  }
  if (!hasCapability(manifest, agent, `resource:${resource}`)) {
    return `${agent} lacks resource:${resource} in phase ${manifest.activePhase}.`;
  }
  if (isBroadCommand(command) && !hasCapability(manifest, agent, 'validation:broad')) {
    return `${agent} lacks validation:broad in phase ${manifest.activePhase}.`;
  }
  if (isDeployCommand(command) && !policy.lifecycleRoles?.includes('release')) {
    return `${agent} lacks the release role in phase ${manifest.activePhase}.`;
  }
  if (isReleaseCommand(command) && !policy.lifecycleRoles?.includes('release')) {
    return `${agent} lacks the release role in phase ${manifest.activePhase}.`;
  }
  if (
    policy.lifecycleRoles?.includes('control-plane-recovery') === true &&
    !CONTROL_PLANE_COMMAND_PATTERN.test(commandText(command))
  ) {
    return `${agent}'s assignment is limited to control-plane commands in phase ${manifest.activePhase}.`;
  }
  return undefined;
}

export function getMachinePressure(): MachinePressure {
  const cpuCount = Math.max(1, cpus().length);
  const loadRatio = (loadavg()[0] ?? 0) / cpuCount;
  const freeMemoryRatio = totalmem() === 0 ? 0 : freemem() / totalmem();
  let processCount = 0;
  try {
    processCount = readdirSync('/proc').filter((entry) => /^\d+$/.test(entry)).length;
  } catch {
    // Non-Linux platforms do not expose /proc. CPU and memory still protect the slot.
  }

  const maxLoadRatio = Number(process.env['AGENT_OS_MAX_LOAD_RATIO'] ?? '0.9');
  const minFreeMemoryRatio = Number(process.env['AGENT_OS_AGENT_MIN_FREE_MEMORY_RATIO'] ?? '0.15');
  const maxProcesses = Number(process.env['AGENT_OS_MAX_PROCESSES'] ?? '700');
  const reasons: string[] = [];
  if (loadRatio >= maxLoadRatio)
    reasons.push(`CPU load ${loadRatio.toFixed(2)} >= ${String(maxLoadRatio)}`);
  if (freeMemoryRatio <= minFreeMemoryRatio) {
    reasons.push(`free memory ${freeMemoryRatio.toFixed(2)} <= ${String(minFreeMemoryRatio)}`);
  }
  if (processCount >= maxProcesses)
    reasons.push(`processes ${String(processCount)} >= ${String(maxProcesses)}`);
  return {
    high: reasons.length > 0,
    reasons,
    loadRatio,
    freeMemoryRatio,
    processCount,
  };
}

export function inspectSharedDev(
  processes: readonly SharedDevProcess[],
  worktree: string,
  observation: 'host' | 'sandbox' = 'host',
): SharedDevStatus {
  const target = resolve(worktree);
  const matches = processes.filter(
    (candidate) =>
      /(?:(?:pnpm(?:\.cjs)?|npm|yarn|bun)\s+(?:run\s+)?(?:dev|serve|start)(?::[\w-]+)?(?:\s|$)|(?:^|\s)(?:vite|next|astro|webpack|uvicorn|gunicorn|flask|cargo\s+run|go\s+run)(?:\s|$))/iu.test(
        candidate.command,
      ) &&
      (resolve(candidate.cwd) === target || resolve(candidate.cwd).startsWith(`${target}/`)),
  );
  return {
    state: matches.length > 0 ? 'healthy' : observation === 'sandbox' ? 'unobservable' : 'stopped',
    matches,
  };
}

export function scanSharedDev(worktree = process.cwd()): SharedDevStatus {
  if (platform() !== 'linux') return { state: 'stopped', matches: [] };
  const candidates: SharedDevProcess[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync('/proc').filter((entry) => /^\d+$/.test(entry));
  } catch {
    return { state: 'stopped', matches: [] };
  }

  for (const entry of entries) {
    try {
      const command = readFileSync(`/proc/${entry}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
      if (
        !/(?:pnpm|npm|yarn|bun|vite|next|astro|webpack|uvicorn|gunicorn|flask|cargo|go)/i.test(
          command,
        )
      )
        continue;
      candidates.push({
        pid: Number(entry),
        cwd: readlinkSync(`/proc/${entry}/cwd`),
        command,
      });
    } catch {
      // Processes may exit or deny inspection between directory reads.
    }
  }
  return inspectSharedDev(
    candidates,
    worktree,
    process.env['CODEX_SANDBOX_NETWORK_DISABLED'] === undefined ? 'host' : 'sandbox',
  );
}

export function dependencyEnvironmentKey(
  worktree: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  dependencyFiles: readonly string[] = [
    'package.json',
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
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
  ],
): string {
  const hash = createHash('sha256');
  hash.update(
    JSON.stringify({
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    }),
  );
  for (const name of dependencyFiles) {
    try {
      hash.update(name);
      hash.update(readFileSync(join(worktree, name)));
    } catch {
      hash.update(`${name}:missing`);
    }
  }
  for (const name of ['CI', 'NODE_ENV']) {
    hash.update(name);
    hash.update(environment[name] ?? '');
  }
  return hash.digest('hex');
}

export function candidateContext(
  worktree: string,
  explicitSha?: string,
): {
  candidateSha: string | undefined;
  reuseEligible: boolean;
  clean: boolean;
} {
  if (explicitSha !== undefined && !/^[0-9a-f]{40,64}$/u.test(explicitSha)) {
    throw new Error('candidate SHA must be a full lowercase hexadecimal Git object ID');
  }
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: worktree,
    encoding: 'utf8',
  });
  const status = spawnSync('git', ['status', '--porcelain'], {
    cwd: worktree,
    encoding: 'utf8',
  });
  const discoveredSha = head.status === 0 ? head.stdout.trim().toLowerCase() : undefined;
  if (explicitSha !== undefined) {
    if (discoveredSha === undefined) {
      throw new Error('candidate SHA cannot be verified because Git HEAD is unavailable');
    }
    if (explicitSha !== discoveredSha) {
      throw new Error(
        `CANDIDATE_SHA_MISMATCH: reported ${explicitSha}, actual worktree HEAD ${discoveredSha}`,
      );
    }
  }
  const candidateSha = explicitSha ?? discoveredSha;
  if (candidateSha !== undefined && !/^[0-9a-f]{40,64}$/u.test(candidateSha)) {
    throw new Error('Git HEAD did not resolve to a full hexadecimal object ID');
  }
  const clean =
    candidateSha !== undefined && status.status === 0 && status.stdout.trim().length === 0;
  return { candidateSha, reuseEligible: clean, clean };
}

export class ResourceScheduler {
  readonly runtimeDir: string;
  private readonly capabilityManifestProvider: () => CapabilityManifest;
  private readonly pollMs: number;
  private readonly pressureProvider: () => MachinePressure;
  private readonly now: () => Date;

  constructor(options: SchedulerOptions = {}) {
    this.runtimeDir = resolve(options.runtimeDir ?? controlPlaneRuntime());
    this.pollMs = options.pollMs ?? 100;
    this.pressureProvider = options.pressureProvider ?? getMachinePressure;
    this.now = options.now ?? (() => new Date());
    const configuredManifest = options.capabilityManifest ?? options.capabilities;
    this.capabilityManifestProvider =
      options.capabilityManifestProvider ??
      (configuredManifest === undefined ? loadCapabilityManifest : () => configuredManifest);
  }

  get capabilityManifest(): CapabilityManifest {
    return this.capabilityManifestProvider();
  }

  private async withState<T>(operation: (state: ResourceState) => T): Promise<T> {
    const lockDir = await acquireLock(this.runtimeDir, this.pollMs);
    try {
      const state = readState(this.runtimeDir);
      cleanupStaleState(state, this.now().toISOString());
      const result = operation(state);
      writeState(this.runtimeDir, state);
      return result;
    } finally {
      releaseLock(lockDir);
    }
  }

  async state(): Promise<ResourceState> {
    return this.withState((state) => structuredClone(state));
  }

  async cleanup(): Promise<CleanupResult> {
    const lockDir = await acquireLock(this.runtimeDir, this.pollMs);
    try {
      const state = readState(this.runtimeDir);
      const result = cleanupStaleState(state, this.now().toISOString());
      writeState(this.runtimeDir, state);
      return result;
    } finally {
      releaseLock(lockDir);
    }
  }

  async enqueue(request: JobRequest): Promise<ResourceJob> {
    return this.withState((state) => {
      const reuseEligible = request.reuseEligible ?? false;
      const environmentKey = request.environmentKey ?? dependencyEnvironmentKey(request.worktree);
      if (
        reuseEligible &&
        request.candidateSha !== undefined &&
        !/^[0-9a-f]{40,64}$/u.test(request.candidateSha)
      ) {
        throw new Error('candidate SHA must be a full lowercase hexadecimal Git object ID');
      }
      if (reuseEligible && request.candidateSha === undefined) {
        throw new Error('reusable resource evidence requires an exact candidate SHA');
      }
      if (reuseEligible && request.candidateSha !== undefined) {
        candidateContext(request.worktree, request.candidateSha);
      }
      const manifest = this.capabilityManifest;
      const operatingPhase = manifest.activePhase;
      const denial = authorizeCommand(request.agent, request.resource, request.command, manifest);
      if (denial !== undefined) throw new Error(denial);
      const now = this.now().toISOString();
      const commandKey = normalizeCommand(request.command);
      const broad = isBroadCommand(request.command);

      if (reuseEligible && request.candidateSha !== undefined) {
        const equivalents = state.jobs
          .slice()
          .reverse()
          .filter(
            (job) =>
              job.candidateSha === request.candidateSha &&
              job.commandKey === commandKey &&
              job.environmentKey === environmentKey &&
              job.reuseEligible,
          );
        const completed = equivalents.find(
          (job) =>
            job.status === 'COMPLETED' &&
            job.exitCode === 0 &&
            (request.executionAttestationRequired !== true || job.executionAttested === true),
        );
        if (completed !== undefined) {
          state.duplicateJobsPrevented += 1;
          const reused: ResourceJob = {
            ...request,
            environmentKey,
            reuseEligible,
            id: randomUUID(),
            commandKey,
            broad,
            operatingPhase,
            status: 'REUSED',
            ownerPid: process.pid,
            ownerStartTicks: readProcessStartTicks(process.pid),
            queuedAt: now,
            finishedAt: now,
            exitCode: 0,
            reusedFrom: completed.id,
            ...(request.executionAttestationRequired === true ? { executionAttested: true } : {}),
          };
          state.jobs.push(reused);
          return structuredClone(reused);
        }
        const activeEquivalent = equivalents.find(
          (job) => job.status === 'RUNNING' || job.status === 'QUEUED',
        );
        if (broad && activeEquivalent !== undefined) {
          state.duplicateJobsPrevented += 1;
          const cancelled: ResourceJob = {
            ...request,
            environmentKey,
            reuseEligible,
            id: randomUUID(),
            commandKey,
            broad,
            operatingPhase,
            status: 'CANCELLED',
            ownerPid: process.pid,
            ownerStartTicks: readProcessStartTicks(process.pid),
            queuedAt: now,
            finishedAt: now,
            duplicateOf: activeEquivalent.id,
            failure: `equivalent job already ${activeEquivalent.status}`,
          };
          state.jobs.push(cancelled);
          return structuredClone(cancelled);
        }
      }

      const job: ResourceJob = {
        ...request,
        environmentKey,
        reuseEligible,
        id: randomUUID(),
        commandKey,
        broad,
        operatingPhase,
        status: 'QUEUED',
        ownerPid: process.pid,
        ownerStartTicks: readProcessStartTicks(process.pid),
        queuedAt: now,
      };
      state.jobs.push(job);
      return structuredClone(job);
    });
  }

  async tryClaim(jobId: string): Promise<{ claimed: boolean; pressure?: MachinePressure }> {
    return this.withState((state) => {
      const manifest = this.capabilityManifest;
      const operatingPhase = manifest.activePhase;
      const now = this.now().toISOString();
      for (const queued of state.jobs.filter((candidate) => candidate.status === 'QUEUED')) {
        const denial = authorizeCommand(queued.agent, queued.resource, queued.command, manifest);
        if (queued.operatingPhase !== operatingPhase || denial !== undefined) {
          queued.status = 'CANCELLED';
          queued.finishedAt = now;
          queued.failure =
            denial ?? `operating phase changed from ${queued.operatingPhase} to ${operatingPhase}`;
        }
      }
      const job = state.jobs.find((candidate) => candidate.id === jobId);
      if (job?.status !== 'QUEUED') return { claimed: false };
      const running = state.jobs.filter(
        (candidate) => candidate.resource === job.resource && candidate.status === 'RUNNING',
      ).length;
      if (running >= RESOURCE_LIMITS[job.resource]) return { claimed: false };

      const queue = state.jobs
        .filter((candidate) => candidate.resource === job.resource && candidate.status === 'QUEUED')
        .sort((left, right) => {
          if (job.resource === 'heavy') {
            const priority =
              workerPriority(manifest, right.agent) - workerPriority(manifest, left.agent);
            if (priority !== 0) return priority;
          }
          return left.queuedAt.localeCompare(right.queuedAt);
        });
      if (queue[0]?.id !== job.id) return { claimed: false };

      if (job.resource === 'heavy') {
        const pressure = this.pressureProvider();
        if (pressure.high) return { claimed: false, pressure };
      }

      job.status = 'RUNNING';
      job.startedAt = now;
      job.leaseAt = now;
      return { claimed: true };
    });
  }

  async attachChild(jobId: string, childPid: number): Promise<void> {
    await this.withState((state) => {
      const job = state.jobs.find((candidate) => candidate.id === jobId);
      if (job?.status !== 'RUNNING') throw new Error(`Job ${jobId} is not running`);
      job.childPid = childPid;
      job.childStartTicks = readProcessStartTicks(childPid);
      job.processGroup = platform() === 'win32' ? undefined : childPid;
      job.leaseAt = this.now().toISOString();
    });
  }

  async finish(
    jobId: string,
    status: 'COMPLETED' | 'FAILED' | 'CANCELLED',
    exitCode?: number,
    failure?: string,
    executionAttested?: boolean,
  ): Promise<void> {
    await this.withState((state) => {
      const job = state.jobs.find((candidate) => candidate.id === jobId);
      if (job === undefined || (job.status !== 'RUNNING' && job.status !== 'QUEUED')) return;
      job.status = status;
      job.finishedAt = this.now().toISOString();
      job.exitCode = exitCode;
      job.failure = failure;
      if (executionAttested !== undefined) job.executionAttested = executionAttested;
    });
  }

  async run(request: RunRequest, hooks: ResourceRunHooks = {}): Promise<RunResult> {
    const { childEnvironment, childEnvironmentMode, executionAttestation, ...jobRequest } = request;
    if ((request.executionAttestationRequired === true) !== (executionAttestation !== undefined)) {
      throw new Error(
        'execution attestation requirement and controller token must be supplied together',
      );
    }
    if (executionAttestation !== undefined && executionAttestation.token.trim().length === 0) {
      throw new Error('execution attestation token must not be empty');
    }
    const job = await this.enqueue(jobRequest);
    if (job.status === 'REUSED') {
      return {
        job,
        exitCode: 0,
        commandStarted: false,
        ...(request.executionAttestationRequired === true
          ? { execution: { productStarted: true, source: 'REUSED' as const } }
          : {}),
      };
    }
    if (job.status === 'CANCELLED') {
      return { job, exitCode: 75, commandStarted: false };
    }

    let lastPressureMessage = '';
    for (;;) {
      const result = await this.tryClaim(job.id);
      if (result.claimed) break;
      if (result.pressure !== undefined) {
        const message = result.pressure.reasons.join('; ');
        if (message !== lastPressureMessage) {
          process.stderr.write(`HEAVY job queued for machine pressure: ${message}\n`);
          lastPressureMessage = message;
        }
      }
      const current = (await this.state()).jobs.find((candidate) => candidate.id === job.id);
      if (current?.status === 'CANCELLED') {
        return { job: current, exitCode: 75, commandStarted: false };
      }
      await sleep(this.pollMs);
    }

    let childPid: number | undefined;
    const cancel = (signal: NodeJS.Signals): void => {
      if (childPid !== undefined) {
        try {
          if (platform() !== 'win32') process.kill(-childPid, signal);
          else process.kill(childPid, signal);
        } catch {
          // The child may have exited between signal delivery and cleanup.
        }
      }
    };
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);

    let commandStarted = false;
    try {
      const claimed = (await this.state()).jobs.find((candidate) => candidate.id === job.id) ?? job;
      await hooks.onLeaseAcquired?.(structuredClone(claimed));
      const executable = request.command[0];
      if (executable === undefined) throw new Error('Cannot run an empty command');
      const child = spawn(executable, request.command.slice(1), {
        cwd: request.worktree,
        env:
          childEnvironmentMode === 'replace'
            ? { ...childEnvironment }
            : { ...process.env, ...childEnvironment },
        stdio: executionAttestation === undefined ? 'inherit' : ['inherit', 'pipe', 'inherit'],
        detached: platform() !== 'win32',
      });
      if (child.pid === undefined) throw new Error('Child process did not report a PID');
      commandStarted = true;
      childPid = child.pid;
      let attestationBuffer = '';
      const attestationState: { overflow: boolean } = { overflow: false };
      const attestationPayloads: string[] = [];
      const inspectAttestationLines = (final: boolean): void => {
        const lines = attestationBuffer.split('\n');
        attestationBuffer = final ? '' : (lines.pop() ?? '');
        for (const [index, line] of lines.entries()) {
          if (line.startsWith(EXECUTION_ATTESTATION_PREFIX)) {
            const payload = line.slice(EXECUTION_ATTESTATION_PREFIX.length);
            if (payload.length > 16_384) attestationState.overflow = true;
            else attestationPayloads.push(payload);
            continue;
          }
          const endedWithNewline = index < lines.length - 1 || !final;
          process.stdout.write(`${line}${endedWithNewline ? '\n' : ''}`);
        }
      };
      const attestationStream = child.stdout;
      const attestationClosed =
        attestationStream === null
          ? Promise.resolve()
          : new Promise<void>((resolveClosed) => {
              attestationStream.setEncoding('utf8');
              attestationStream.on('data', (chunk: string) => {
                attestationBuffer += chunk;
                inspectAttestationLines(false);
                if (attestationBuffer.length > 65_536) {
                  if (attestationBuffer.startsWith(EXECUTION_ATTESTATION_PREFIX)) {
                    attestationState.overflow = true;
                  } else {
                    process.stdout.write(attestationBuffer);
                  }
                  attestationBuffer = '';
                }
              });
              attestationStream.once('close', () => {
                inspectAttestationLines(true);
                resolveClosed();
              });
            });
      const resultPromise = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolveExit, rejectExit) => {
        child.once('error', rejectExit);
        child.once('exit', (code, signal) => {
          resolveExit({ code, signal });
        });
      });
      await this.attachChild(job.id, child.pid);
      const result = await resultPromise;
      await attestationClosed;
      const cancelled = result.signal !== null;
      const exitCode = result.code ?? (cancelled ? 130 : 1);
      let execution: RunExecutionEvidence | undefined;
      if (executionAttestation !== undefined) {
        let parsedAttestation: { productStarted: boolean; failure?: string } | undefined;
        for (const payload of attestationPayloads) {
          try {
            const parsed = JSON.parse(payload) as {
              schemaVersion?: unknown;
              token?: unknown;
              productStarted?: unknown;
              failure?: unknown;
            };
            if (
              parsed.schemaVersion === 1 &&
              parsed.token === executionAttestation.token &&
              typeof parsed.productStarted === 'boolean'
            ) {
              parsedAttestation = {
                productStarted: parsed.productStarted,
                ...(typeof parsed.failure === 'string' ? { failure: parsed.failure } : {}),
              };
              break;
            }
          } catch {
            // Ignore unrelated or malformed structured output frames.
          }
        }
        execution = parsedAttestation
          ? { ...parsedAttestation, source: 'ATTESTED' }
          : {
              productStarted: false,
              source: 'ATTESTED',
              failure: attestationState.overflow
                ? 'execution attestation exceeded its size limit'
                : attestationPayloads.length === 0
                  ? 'execution attestation was missing'
                  : 'execution attestation was invalid',
            };
      }
      await this.finish(
        job.id,
        exitCode === 0 ? 'COMPLETED' : cancelled ? 'CANCELLED' : 'FAILED',
        exitCode,
        result.signal === null ? undefined : `terminated by ${result.signal}`,
        execution?.productStarted,
      );
      const settled = (await this.state()).jobs.find((candidate) => candidate.id === job.id) ?? job;
      return {
        job: settled,
        exitCode,
        commandStarted,
        ...(execution === undefined ? {} : { execution }),
      };
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      await this.finish(job.id, 'FAILED', 1, failure);
      const settled = (await this.state()).jobs.find((candidate) => candidate.id === job.id) ?? job;
      return { job: settled, exitCode: 1, commandStarted };
    } finally {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    }
  }
}

export function resolveWorktree(path = process.cwd()): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
