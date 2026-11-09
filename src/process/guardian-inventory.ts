// src/process/guardian-inventory.ts
import path from 'node:path';

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

export function normalizeRoot(value: string): string {
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

export function hasPersistentDevSignature(record: ProcessRecord, tool: ProcessTool): boolean {
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
