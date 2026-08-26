// src/process/guardian.ts
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { controlPlaneRuntimeChild } from '../control-plane/runtime';

export const PROCESS_TOOLS = [
  'pnpm',
  'npm',
  'yarn',
  'bun',
  'deno',
  'node',
  'python',
  'pytest',
  'cargo',
  'rustc',
  'go',
  'make',
  'cmake',
  'mvn',
  'gradle',
  'java',
  'dotnet',
  'turbo',
  'vite',
  'vitest',
  'eslint',
  'tsc',
  'tsx',
  'playwright',
  'tmux',
] as const;

export type ProcessTool = (typeof PROCESS_TOOLS)[number];

export interface ProcessRecord {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly sid: number;
  readonly startTimeTicks: string;
  readonly comm: string;
  readonly args: readonly string[];
  readonly cwd: string | null;
}

export interface SharedDevRegistration {
  readonly schemaVersion: 1;
  readonly owner: 'EXTERNAL';
  readonly protection: 'PROTECTED';
  readonly pid: number;
  readonly startTimeTicks: string;
  readonly worktree: string;
  readonly ports: readonly number[];
  readonly registeredAt: string;
}

export interface SchedulerTrackedWorkload {
  readonly childPid: number;
  readonly childStartTicks: string;
  readonly processGroup?: number;
  readonly worktree: string;
}

export type IdentifiedProcess = Omit<ProcessRecord, 'args'> & {
  readonly tool: ProcessTool;
  readonly worktree: string;
  readonly protected: boolean;
  readonly orphan: boolean;
  readonly cleanupEligible: boolean;
  readonly parentOwnedPid: number | null;
  readonly ownershipEvidence: 'ancestry' | 'scheduler' | 'signature';
  readonly command: string;
};

export type IgnoredProcess = Omit<ProcessRecord, 'args'> & {
  readonly detectedTool: ProcessTool;
  readonly worktree: string;
  readonly cleanupEligible: false;
  readonly reason: 'operational-tooling' | 'unknown-signature';
  readonly command: string;
};

export interface TmuxPaneRecord {
  readonly session: string;
  readonly pid: number;
  readonly cwd: string;
  readonly dead: boolean;
  readonly command: string;
}

export interface TmuxSessionStatus {
  readonly name: string;
  readonly orchestratorOwned: boolean;
  readonly stale: boolean;
  readonly panes: readonly TmuxPaneRecord[];
}

export interface ProcessInventory {
  readonly roots: readonly string[];
  readonly tmuxSessionPrefix: string;
  readonly processes: readonly IdentifiedProcess[];
  readonly ignoredProcesses: readonly IgnoredProcess[];
  readonly tmuxSessions: readonly TmuxSessionStatus[];
  readonly sharedDev: {
    readonly registration: SharedDevRegistration | null;
    readonly active: boolean;
    readonly stale: boolean;
  };
}

export interface CleanupUnit {
  readonly kind: 'group' | 'process';
  readonly id: number;
  readonly members: readonly Pick<ProcessRecord, 'pid' | 'startTimeTicks'>[];
}

export interface CleanupPlan {
  readonly orphanOnly: boolean;
  readonly roots: readonly string[];
  readonly tmuxSessionPrefix: string;
  readonly processes: readonly IdentifiedProcess[];
  readonly units: readonly CleanupUnit[];
  readonly staleTmuxSessions: readonly string[];
}

export interface CleanupResult {
  readonly signaled: readonly CleanupUnit[];
  readonly skipped: readonly { unit: CleanupUnit; reason: string }[];
  readonly killedTmuxSessions: readonly string[];
}

const OPERATIONAL_TOOLING_MARKERS = [
  '/codex',
  '@openai/codex',
  'playwright-mcp',
  'chrome-devtools-mcp',
  'mcp-server',
  'mcp_server',
  '/mcp/',
  '/mcp-',
  '.vscode-server',
  '.vscode-remote',
  'vscode-server',
  'extensionhost',
  'remote-cli',
  'language-server',
  'languageserver',
  '/wsl/',
  'wslhost',
  'wslservice',
] as const;

const SENSITIVE_FLAGS =
  /^(--?(?:api[-_]?key|auth|cookie|credential|password|secret|token))(?:=|$)/i;

function normalizeRoot(value: string): string {
  return path.resolve(value).replace(/\/+$/, '');
}

export function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(normalizeRoot(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function tokenBase(token: string): string {
  return path.basename(token).toLowerCase();
}

function includesPathFragment(args: readonly string[], fragments: readonly string[]): boolean {
  const command = args.join('\u0000').toLowerCase();
  return fragments.some((fragment) => command.includes(fragment));
}

export function classifyTool(record: ProcessRecord): ProcessTool | null {
  const bases = record.args.map(tokenBase);
  const command = record.args.join('\u0000').toLowerCase();
  const comm = record.comm.toLowerCase();

  if (bases.some((base) => base === 'pnpm' || base === 'pnpm.cjs')) return 'pnpm';
  if (bases.includes('npm') || bases.includes('npm-cli.js')) return 'npm';
  if (bases.includes('yarn') || bases.includes('yarn.js')) return 'yarn';
  if (bases.includes('bun')) return 'bun';
  if (bases.includes('deno')) return 'deno';
  if (bases.some((base) => /^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/u.test(base))) return 'python';
  if (bases.includes('pytest') || bases.includes('py.test')) return 'pytest';
  if (bases.includes('cargo')) return 'cargo';
  if (bases.includes('rustc')) return 'rustc';
  if (bases.includes('go')) return 'go';
  if (bases.includes('make') || bases.includes('gmake')) return 'make';
  if (bases.includes('cmake')) return 'cmake';
  if (bases.includes('mvn') || bases.includes('mvnw')) return 'mvn';
  if (bases.includes('gradle') || bases.includes('gradlew')) return 'gradle';
  if (bases.includes('java')) return 'java';
  if (bases.includes('dotnet')) return 'dotnet';
  if (bases.some((base) => base === 'turbo' || base.startsWith('turbo-'))) return 'turbo';
  if (bases.includes('vite') || command.includes('/vite/bin/vite.js')) return 'vite';
  if (bases.includes('vitest') || command.includes('/vitest.mjs')) return 'vitest';
  if (bases.includes('eslint') || command.includes('/eslint/bin/eslint.js')) return 'eslint';
  if (bases.includes('tsc') || command.includes('/typescript/bin/tsc')) return 'tsc';
  if (bases.includes('playwright') || command.includes('/playwright/cli.js')) return 'playwright';
  if (bases.includes('tsx') || command.includes('/tsx/dist/cli.mjs')) return 'tsx';
  if (comm === 'tmux' || bases.includes('tmux')) return 'tmux';
  if (comm === 'node' || bases[0] === 'node' || bases[0]?.startsWith('node-')) return 'node';
  return null;
}

export function hasInfrastructureMarker(record: ProcessRecord): boolean {
  if (includesPathFragment(record.args, OPERATIONAL_TOOLING_MARKERS)) return true;
  return record.args.some((argument) => {
    const base = tokenBase(argument);
    return base === 'codex' || base === 'mcp' || base.startsWith('mcp-') || base.endsWith('-mcp');
  });
}

function matchingRoot(record: ProcessRecord, roots: readonly string[]): string | null {
  const byCwd =
    record.cwd === null ? undefined : roots.find((root) => isWithin(record.cwd ?? '', root));
  if (byCwd !== undefined) return byCwd;

  for (const root of roots) {
    if (
      record.args
        .slice(0, 4)
        .some((argument) => path.isAbsolute(argument) && isWithin(argument, root))
    ) {
      return root;
    }
  }
  return null;
}

function descendantsOf(pid: number, records: readonly ProcessRecord[]): Set<number> {
  const result = new Set<number>([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (!result.has(record.pid) && result.has(record.ppid)) {
        result.add(record.pid);
        changed = true;
      }
    }
  }
  return result;
}

function ancestorPids(pid: number, byPid: ReadonlyMap<number, ProcessRecord>): Set<number> {
  const result = new Set<number>();
  let cursor = byPid.get(pid);
  while (cursor !== undefined && cursor.ppid > 0 && !result.has(cursor.ppid)) {
    result.add(cursor.ppid);
    cursor = byPid.get(cursor.ppid);
  }
  return result;
}

export function sanitizeCommand(args: readonly string[]): string {
  const sanitized: string[] = [];
  let redactNext = false;
  for (const argument of args.slice(0, 16)) {
    if (redactNext) {
      sanitized.push('[REDACTED]');
      redactNext = false;
      continue;
    }
    if (SENSITIVE_FLAGS.test(argument)) {
      const separator = argument.indexOf('=');
      sanitized.push(separator === -1 ? argument : `${argument.slice(0, separator)}=[REDACTED]`);
      redactNext = separator === -1;
      continue;
    }
    sanitized.push(argument.length > 120 ? `${argument.slice(0, 117)}...` : argument);
  }
  return sanitized.join(' ').slice(0, 300);
}

function packageManagerWorkloadSignature(record: ProcessRecord): boolean {
  const managerIndex = record.args.findIndex((argument) => {
    const base = tokenBase(argument);
    return ['pnpm', 'pnpm.cjs', 'npm', 'npm-cli.js', 'yarn', 'yarn.js', 'bun'].includes(base);
  });
  if (managerIndex === -1) return false;
  const workload = record.args.slice(managerIndex + 1).map((argument) => argument.toLowerCase());
  const knownScript =
    /^(?:dev(?::[\w-]+)?|start|build(?::[\w-]+)?|test(?::[\w-]+)?|lint(?::[\w-]+)?|type-check(?::[\w-]+)?|check(?::[\w-]+)?|ci(?::[\w-]+)?|audit(?::[\w-]+)?|tools:(?:test|type-check)(?::[\w-]+)?|api:[\w-]+|db:[\w-]+|health-check|format:check(?::ci)?)$/u;
  if (workload.some((argument) => knownScript.test(argument))) return true;
  const knownExecutable = /^(?:turbo|vite|vitest|eslint|tsc|tsx|playwright)$/u;
  return (
    workload.includes('exec') &&
    workload.some((argument) => knownExecutable.test(tokenBase(argument)))
  );
}

function hasTargetScriptSignature(
  record: ProcessRecord,
  worktree: string,
  scriptRoots: readonly string[],
): boolean {
  if (record.cwd === null) return false;
  for (const rawArgument of record.args.slice(1, 8)) {
    const argument = rawArgument.startsWith('file://')
      ? rawArgument.slice('file://'.length)
      : rawArgument;
    if (!/\.(?:[cm]?[jt]sx?|py|rb|rs|go|java|kt|kts|cs|fsx)$/iu.test(argument)) continue;
    const resolved = path.isAbsolute(argument) ? argument : path.resolve(record.cwd, argument);
    if (!isWithin(resolved, worktree)) continue;
    const relative = path.relative(worktree, resolved);
    if (
      scriptRoots.some(
        (root) => relative === root || (root !== '.' && relative.startsWith(`${root}/`)),
      )
    ) {
      return true;
    }
  }
  return false;
}

function hasKnownWorkloadSignature(
  record: ProcessRecord,
  tool: ProcessTool,
  worktree: string,
  scriptRoots: readonly string[],
): boolean {
  if (['pnpm', 'npm', 'yarn', 'bun'].includes(tool)) {
    return packageManagerWorkloadSignature(record);
  }
  if (tool === 'node' || tool === 'tsx' || tool === 'deno' || tool === 'python') {
    return hasTargetScriptSignature(record, worktree, scriptRoots);
  }
  const workload = record.args.slice(1).map((argument) => argument.toLowerCase());
  if (tool === 'pytest') return true;
  if (tool === 'cargo') {
    return workload.some((argument) =>
      /^(?:build|check|clippy|doc|run|test|bench|watch)$/u.test(argument),
    );
  }
  if (tool === 'go') {
    return workload.some((argument) => /^(?:build|generate|run|test)$/u.test(argument));
  }
  if (tool === 'make') return workload.some((argument) => !argument.startsWith('-'));
  if (tool === 'cmake') return workload.includes('--build') || workload.includes('--install');
  if (tool === 'mvn' || tool === 'gradle' || tool === 'dotnet') {
    return workload.some((argument) =>
      /^(?:build|check|compile|package|run|test|verify)$/u.test(argument),
    );
  }
  if (tool === 'tmux') return false;
  return !['rustc', 'java'].includes(tool);
}

function hasPersistentDevSignature(record: ProcessRecord, tool: ProcessTool): boolean {
  const workload = record.args.slice(1).map((argument) => argument.toLowerCase());
  if (['pnpm', 'npm', 'yarn', 'bun'].includes(tool)) {
    return workload.some((argument) => /^(?:dev(?::[\w-]+)?|serve|start)$/u.test(argument));
  }
  if (['vite'].includes(tool)) return true;
  if (tool === 'python') {
    return workload.some((argument) =>
      /^(?:flask|http\.server|uvicorn|gunicorn|runserver)$/u.test(tokenBase(argument)),
    );
  }
  if (tool === 'cargo' || tool === 'go' || tool === 'dotnet' || tool === 'deno') {
    return workload.includes('run');
  }
  if (tool === 'make') {
    return workload.some((argument) => /^(?:dev|serve|start)$/u.test(argument));
  }
  return false;
}

function activeSchedulerEvidence(
  tracking: readonly SchedulerTrackedWorkload[],
  records: readonly ProcessRecord[],
  roots: readonly string[],
): Map<number, string> {
  const byPid = new Map(records.map((record) => [record.pid, record]));
  const evidence = new Map<number, string>();
  for (const tracked of tracking) {
    const anchor = byPid.get(tracked.childPid);
    if (
      anchor === undefined ||
      anchor.startTimeTicks !== tracked.childStartTicks ||
      !roots.some((root) => isWithin(tracked.worktree, root))
    ) {
      continue;
    }
    evidence.set(anchor.pid, normalizeRoot(tracked.worktree));
    if (tracked.processGroup === undefined) continue;
    for (const record of records) {
      if (record.pgid === tracked.processGroup) {
        evidence.set(record.pid, normalizeRoot(tracked.worktree));
      }
    }
  }
  return evidence;
}

export function buildInventory(input: {
  readonly records: readonly ProcessRecord[];
  readonly roots: readonly string[];
  readonly registration?: SharedDevRegistration | null;
  readonly schedulerTracking?: readonly SchedulerTrackedWorkload[];
  readonly tmuxPanes?: readonly TmuxPaneRecord[];
  readonly currentPid?: number;
  readonly tmuxSessionPrefix?: string;
  readonly scriptRoots?: readonly string[];
}): ProcessInventory {
  const tmuxSessionPrefix = input.tmuxSessionPrefix ?? 'agent-os-';
  const scriptRoots = input.scriptRoots ?? ['src', 'scripts', 'tests', 'config'];
  const roots = [...new Set(input.roots.map(normalizeRoot))].sort(
    (left, right) => right.length - left.length,
  );
  const byPid = new Map(input.records.map((record) => [record.pid, record]));
  const schedulerEvidence = activeSchedulerEvidence(
    input.schedulerTracking ?? [],
    input.records,
    roots,
  );
  const direct = new Map<
    number,
    {
      tool: ProcessTool;
      worktree: string;
      ownershipEvidence: IdentifiedProcess['ownershipEvidence'];
    }
  >();

  for (const record of input.records) {
    const tool = classifyTool(record);
    const trackedWorktree = schedulerEvidence.get(record.pid);
    const worktree = matchingRoot(record, roots) ?? trackedWorktree ?? null;
    if (tool === null || worktree === null || hasInfrastructureMarker(record)) continue;
    if (trackedWorktree !== undefined) {
      direct.set(record.pid, {
        tool,
        worktree,
        ownershipEvidence: 'scheduler',
      });
      continue;
    }
    if (hasKnownWorkloadSignature(record, tool, worktree, scriptRoots)) {
      direct.set(record.pid, {
        tool,
        worktree,
        ownershipEvidence: 'signature',
      });
    }
  }

  // A worker can lose cwd access during teardown. Inherit ownership only from
  // an already-proven target parent, and only for the allow-listed tools.
  let inherited = true;
  while (inherited) {
    inherited = false;
    for (const record of input.records) {
      if (direct.has(record.pid) || hasInfrastructureMarker(record)) continue;
      const parent = direct.get(record.ppid);
      const tool = classifyTool(record);
      if (parent !== undefined && tool !== null) {
        direct.set(record.pid, {
          tool,
          worktree: parent.worktree,
          ownershipEvidence: 'ancestry',
        });
        inherited = true;
      }
    }
  }

  const registrationRecord =
    input.registration === null || input.registration === undefined
      ? undefined
      : byPid.get(input.registration.pid);
  const registrationActive =
    registrationRecord !== undefined &&
    registrationRecord.startTimeTicks === input.registration?.startTimeTicks &&
    direct.has(registrationRecord.pid);
  const protectedPids = registrationActive
    ? descendantsOf(registrationRecord.pid, input.records)
    : new Set<number>();
  const currentGuard =
    input.currentPid === undefined
      ? new Set<number>()
      : new Set([input.currentPid, ...ancestorPids(input.currentPid, byPid)]);

  const processes: IdentifiedProcess[] = [];
  const ignoredProcesses: IgnoredProcess[] = [];
  for (const record of input.records) {
    const identity = direct.get(record.pid);
    if (identity === undefined) {
      const detectedTool = classifyTool(record);
      const worktree = matchingRoot(record, roots);
      if (detectedTool === null || worktree === null) continue;
      ignoredProcesses.push({
        pid: record.pid,
        ppid: record.ppid,
        pgid: record.pgid,
        sid: record.sid,
        startTimeTicks: record.startTimeTicks,
        comm: record.comm,
        cwd: record.cwd,
        detectedTool,
        worktree,
        cleanupEligible: false,
        reason: hasInfrastructureMarker(record) ? 'operational-tooling' : 'unknown-signature',
        command: sanitizeCommand(record.args),
      });
      continue;
    }
    const parentOwnedPid = direct.has(record.ppid) ? record.ppid : null;
    const orphan = record.ppid === 1 && identity.tool !== 'tmux';
    const protectedProcess = protectedPids.has(record.pid);
    processes.push({
      pid: record.pid,
      ppid: record.ppid,
      pgid: record.pgid,
      sid: record.sid,
      startTimeTicks: record.startTimeTicks,
      comm: record.comm,
      cwd: record.cwd,
      ...identity,
      protected: protectedProcess,
      orphan,
      cleanupEligible: !protectedProcess && !currentGuard.has(record.pid),
      parentOwnedPid,
      command: sanitizeCommand(record.args),
    });
  }

  const tmuxGroups = new Map<string, TmuxPaneRecord[]>();
  for (const pane of input.tmuxPanes ?? []) {
    const panes = tmuxGroups.get(pane.session) ?? [];
    panes.push(pane);
    tmuxGroups.set(pane.session, panes);
  }
  const tmuxSessions = [...tmuxGroups.entries()]
    .map(([name, panes]): TmuxSessionStatus => {
      const orchestratorOwned =
        name.startsWith(tmuxSessionPrefix) &&
        panes.some((pane) => roots.some((root) => isWithin(pane.cwd, root)));
      return {
        name,
        orchestratorOwned,
        stale: orchestratorOwned && panes.every((pane) => pane.dead || !byPid.has(pane.pid)),
        panes,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    roots,
    tmuxSessionPrefix,
    processes: processes.sort((left, right) => left.pid - right.pid),
    ignoredProcesses: ignoredProcesses.sort((left, right) => left.pid - right.pid),
    tmuxSessions,
    sharedDev: {
      registration: input.registration ?? null,
      active: registrationActive,
      stale: input.registration !== null && input.registration !== undefined && !registrationActive,
    },
  };
}

function treeDepth(
  process: IdentifiedProcess,
  byPid: ReadonlyMap<number, IdentifiedProcess>,
): number {
  let depth = 0;
  let cursor: IdentifiedProcess | undefined = process;
  const visited = new Set<number>();
  while (cursor.parentOwnedPid !== null && !visited.has(cursor.parentOwnedPid)) {
    visited.add(cursor.parentOwnedPid);
    depth += 1;
    cursor = byPid.get(cursor.parentOwnedPid);
    if (cursor === undefined) break;
  }
  return depth;
}

export function planCleanup(
  inventory: ProcessInventory,
  allRecords: readonly ProcessRecord[],
  orphanOnly: boolean,
): CleanupPlan {
  const eligible = inventory.processes.filter((process) => process.cleanupEligible);
  const selected = new Set<number>();
  if (orphanOnly) {
    const orphanRoots = eligible.filter((process) => process.orphan).map((process) => process.pid);
    for (const root of orphanRoots) {
      for (const pid of descendantsOf(root, allRecords)) selected.add(pid);
    }
  } else {
    for (const process of eligible) selected.add(process.pid);
  }

  const processes = eligible.filter((process) => selected.has(process.pid));
  const selectedByPid = new Map(processes.map((process) => [process.pid, process]));
  processes.sort((left, right) => {
    const depthDifference = treeDepth(right, selectedByPid) - treeDepth(left, selectedByPid);
    return depthDifference === 0 ? right.pid - left.pid : depthDifference;
  });

  const allByGroup = new Map<number, ProcessRecord[]>();
  for (const record of allRecords) {
    const members = allByGroup.get(record.pgid) ?? [];
    members.push(record);
    allByGroup.set(record.pgid, members);
  }
  const selectedGroups = new Map<number, IdentifiedProcess[]>();
  for (const process of processes) {
    const members = selectedGroups.get(process.pgid) ?? [];
    members.push(process);
    selectedGroups.set(process.pgid, members);
  }

  const groupedPids = new Set<number>();
  const units: CleanupUnit[] = [];
  for (const [pgid, members] of selectedGroups) {
    const allMembers = allByGroup.get(pgid) ?? [];
    const safeWholeGroup =
      pgid > 1 &&
      members.length > 1 &&
      allMembers.length === members.length &&
      allMembers.every((record) => selectedByPid.has(record.pid));
    if (!safeWholeGroup) continue;
    members.forEach((member) => groupedPids.add(member.pid));
    units.push({
      kind: 'group',
      id: pgid,
      members: members
        .map(({ pid, startTimeTicks }) => ({ pid, startTimeTicks }))
        .sort((left, right) => left.pid - right.pid),
    });
  }
  for (const process of processes) {
    if (groupedPids.has(process.pid)) continue;
    units.push({
      kind: 'process',
      id: process.pid,
      members: [{ pid: process.pid, startTimeTicks: process.startTimeTicks }],
    });
  }

  return {
    orphanOnly,
    roots: inventory.roots,
    tmuxSessionPrefix: inventory.tmuxSessionPrefix,
    processes,
    units,
    staleTmuxSessions: inventory.tmuxSessions
      .filter((session) => session.stale)
      .map((session) => session.name),
  };
}

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
