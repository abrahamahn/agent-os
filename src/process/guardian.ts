// src/process/guardian.ts
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { controlPlaneRuntimeChild } from '../control-plane/runtime';

import {
  classifyTool,
  hasInfrastructureMarker,
  hasPersistentDevSignature,
  isWithin,
  normalizeRoot,
  type CleanupPlan,
  type CleanupResult,
  type CleanupUnit,
  type ProcessRecord,
  type SchedulerTrackedWorkload,
  type SharedDevRegistration,
  type TmuxPaneRecord,
} from './guardian-inventory';

export async function readProcess(pid: number, procRoot = '/proc'): Promise<ProcessRecord | null> {
  const processDirectory = path.join(procRoot, String(pid));
  try {
    const stat = await fs.readFile(path.join(processDirectory, 'stat'), 'utf8');
    const closeParen = stat.lastIndexOf(')');
    if (closeParen === -1) return null;
    const fields = stat
      .slice(closeParen + 2)
      .trim()
      .split(/\s+/);
    const cmdline = await fs.readFile(path.join(processDirectory, 'cmdline'));
    const args = cmdline
      .toString('utf8')
      .split('\u0000')
      .filter((argument) => argument.length > 0);
    let cwd: string | null = null;
    try {
      cwd = await fs.readlink(path.join(processDirectory, 'cwd'));
    } catch {
      // A process can exit, or deny cwd access, between procfs reads.
    }
    return {
      pid,
      ppid: Number(fields[1]),
      pgid: Number(fields[2]),
      sid: Number(fields[3]),
      startTimeTicks: fields[19] ?? '',
      comm: stat.slice(stat.indexOf('(') + 1, closeParen),
      args,
      cwd,
    };
  } catch {
    return null;
  }
}

export async function readProcessSnapshot(procRoot = '/proc'): Promise<ProcessRecord[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(procRoot);
  } catch {
    return [];
  }
  const records = await Promise.all(
    entries
      .filter((entry) => /^\d+$/.test(entry))
      .map((entry) => readProcess(Number(entry), procRoot)),
  );
  return records.filter((record): record is ProcessRecord => record !== null);
}

export async function readSchedulerTracking(
  runtimeDirectory = '/tmp/agent-os-runtime',
): Promise<SchedulerTrackedWorkload[]> {
  try {
    const parsed: unknown = JSON.parse(
      await fs.readFile(path.join(runtimeDirectory, 'state.json'), 'utf8'),
    );
    if (typeof parsed !== 'object' || parsed === null || !('jobs' in parsed)) return [];
    const jobs = (parsed as { jobs?: unknown }).jobs;
    if (!Array.isArray(jobs)) return [];
    const tracking: SchedulerTrackedWorkload[] = [];
    for (const value of jobs) {
      if (typeof value !== 'object' || value === null) continue;
      const job = value as {
        status?: unknown;
        orphaned?: unknown;
        childPid?: unknown;
        childStartTicks?: unknown;
        processGroup?: unknown;
        worktree?: unknown;
      };
      if (job.status !== 'RUNNING' && job.orphaned !== true) continue;
      if (
        !Number.isInteger(job.childPid) ||
        typeof job.childStartTicks !== 'string' ||
        typeof job.worktree !== 'string'
      ) {
        continue;
      }
      tracking.push({
        childPid: job.childPid as number,
        childStartTicks: job.childStartTicks,
        ...(Number.isInteger(job.processGroup) ? { processGroup: job.processGroup as number } : {}),
        worktree: job.worktree,
      });
    }
    return tracking;
  } catch {
    return [];
  }
}

export function discoverWorktrees(repositoryRoot: string): string[] {
  const roots = new Set<string>([normalizeRoot(repositoryRoot)]);
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
  const result = spawnSync('git', ['-C', repositoryRoot, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
  });
  if (result.status === 0) {
    for (const line of result.stdout.split('\n')) {
      if (line.startsWith('worktree ')) roots.add(normalizeRoot(line.slice('worktree '.length)));
    }
  }
  return [...roots];
}

export function readTmuxPanes(session?: string): TmuxPaneRecord[] {
  const targetArguments = session === undefined ? ['-a'] : ['-t', session];
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
  const result = spawnSync(
    'tmux',
    [
      'list-panes',
      ...targetArguments,
      '-F',
      '#{session_name}\t#{pane_pid}\t#{pane_current_path}\t#{pane_dead}\t#{pane_current_command}',
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) return [];
  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [session = '', pid = '0', cwd = '', dead = '0', command = ''] = line.split('\t');
      return { session, pid: Number(pid), cwd, dead: dead === '1', command };
    });
}

export function stateDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment['AGENT_OS_PROCESS_GUARDIAN_STATE_DIR'];
  if (override !== undefined && override !== '') return path.resolve(override);
  return controlPlaneRuntimeChild('process-guardian', environment);
}

async function ensureStateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  const uid = process.getuid?.();
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (uid !== undefined && stat.uid !== uid) ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error(`Unsafe process guardian state directory: ${directory}`);
  }
}

function registrationFile(directory = stateDirectory()): string {
  return path.join(directory, 'shared-dev.json');
}

function isRegistration(value: unknown): value is SharedDevRegistration {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<SharedDevRegistration>;
  return (
    entry.schemaVersion === 1 &&
    entry.owner === 'EXTERNAL' &&
    entry.protection === 'PROTECTED' &&
    typeof entry.pid === 'number' &&
    typeof entry.startTimeTicks === 'string' &&
    typeof entry.worktree === 'string' &&
    Array.isArray(entry.ports) &&
    entry.ports.every((port) => Number.isInteger(port) && port > 0 && port <= 65_535) &&
    typeof entry.registeredAt === 'string'
  );
}

export async function readSharedDev(
  directory = stateDirectory(),
): Promise<SharedDevRegistration | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(registrationFile(directory), 'utf8'));
    return isRegistration(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function registerSharedDev(input: {
  readonly pid: number;
  readonly worktree: string;
  readonly ports: readonly number[];
  readonly record: ProcessRecord;
  readonly roots: readonly string[];
  readonly directory?: string;
  readonly now?: Date;
}): Promise<SharedDevRegistration> {
  const worktree = normalizeRoot(input.worktree);
  const tool = classifyTool(input.record);
  if (
    input.record.pid !== input.pid ||
    tool === null ||
    !hasPersistentDevSignature(input.record, tool) ||
    hasInfrastructureMarker(input.record) ||
    !input.roots.some((root) => isWithin(worktree, root)) ||
    input.record.cwd === null ||
    !isWithin(input.record.cwd, worktree)
  ) {
    throw new Error('PID is not a live target process in the requested worktree');
  }
  const ports = [...new Set(input.ports)];
  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new Error('Ports must be integers from 1 through 65535');
  }

  const directory = input.directory ?? stateDirectory();
  await ensureStateDirectory(directory);
  const existing = await readSharedDev(directory);
  if (existing !== null) {
    const existingRecord = await readProcess(existing.pid);
    if (existingRecord?.startTimeTicks === existing.startTimeTicks && existing.pid !== input.pid) {
      throw new Error(`Shared dev PID ${String(existing.pid)} is already registered and protected`);
    }
  }

  const registration: SharedDevRegistration = {
    schemaVersion: 1,
    owner: 'EXTERNAL',
    protection: 'PROTECTED',
    pid: input.pid,
    startTimeTicks: input.record.startTimeTicks,
    worktree,
    ports,
    registeredAt: (input.now ?? new Date()).toISOString(),
  };
  const target = registrationFile(directory);
  const temporary = `${target}.${String(process.pid)}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(registration, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(temporary, target);
  return registration;
}

export async function unregisterSharedDev(directory = stateDirectory()): Promise<boolean> {
  try {
    await fs.unlink(registrationFile(directory));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function sameMembers(
  planned: readonly Pick<ProcessRecord, 'pid' | 'startTimeTicks'>[],
  current: readonly ProcessRecord[],
): boolean {
  if (planned.length !== current.length) return false;
  const currentByPid = new Map(current.map((record) => [record.pid, record.startTimeTicks]));
  return planned.every((member) => currentByPid.get(member.pid) === member.startTimeTicks);
}

export async function executeCleanup(
  plan: CleanupPlan,
  adapters: {
    readonly snapshot?: () => readonly ProcessRecord[] | Promise<readonly ProcessRecord[]>;
    readonly signal?: (target: number, signal: NodeJS.Signals) => void;
    readonly killTmuxSession?: (name: string) => boolean | Promise<boolean>;
    readonly waitMs?: number;
  } = {},
): Promise<CleanupResult> {
  const snapshot = adapters.snapshot ?? readProcessSnapshot;
  const signal = adapters.signal ?? ((target, name) => process.kill(target, name));
  const killTmuxSession =
    adapters.killTmuxSession ??
    (async (name: string) => {
      const panes = readTmuxPanes(name);
      const records = await readProcessSnapshot();
      const livePids = new Set(records.map((record) => record.pid));
      const stillStale =
        name.startsWith(plan.tmuxSessionPrefix) &&
        panes.length > 0 &&
        panes.some((pane) => plan.roots.some((root) => isWithin(pane.cwd, root))) &&
        panes.every((pane) => pane.dead || !livePids.has(pane.pid));
      if (!stillStale) return false;
      // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
      return spawnSync('tmux', ['kill-session', '-t', name]).status === 0;
    });
  const signaled: CleanupUnit[] = [];
  const skipped: { unit: CleanupUnit; reason: string }[] = [];

  for (const unit of plan.units) {
    const live = await snapshot();
    const current =
      unit.kind === 'group'
        ? live.filter((record) => record.pgid === unit.id)
        : live.filter((record) => record.pid === unit.id);
    if (!sameMembers(unit.members, current)) {
      skipped.push({
        unit,
        reason: 'process identity or group membership changed',
      });
      continue;
    }
    try {
      signal(unit.kind === 'group' ? -unit.id : unit.id, 'SIGTERM');
      signaled.push(unit);
    } catch (error) {
      skipped.push({
        unit,
        reason: error instanceof Error ? error.message : 'signal failed',
      });
    }
  }

  if (signaled.length > 0 && (adapters.waitMs ?? 1_000) > 0) {
    await new Promise((resolve) => setTimeout(resolve, adapters.waitMs ?? 1_000));
  }

  for (const unit of signaled) {
    const live = await snapshot();
    const remaining = unit.members.filter((member) =>
      live.some(
        (record) => record.pid === member.pid && record.startTimeTicks === member.startTimeTicks,
      ),
    );
    for (const member of remaining) {
      try {
        signal(member.pid, 'SIGKILL');
      } catch {
        // It may have exited between the final snapshot and signal.
      }
    }
  }

  const killedTmuxSessions: string[] = [];
  for (const name of plan.staleTmuxSessions) {
    if (await killTmuxSession(name)) killedTmuxSessions.push(name);
  }
  return { signaled, skipped, killedTmuxSessions };
}
