// src/process/cli.ts
import path from 'node:path';

import {
  buildInventory,
  discoverWorktrees,
  executeCleanup,
  planCleanup,
  readProcess,
  readProcessSnapshot,
  readSchedulerTracking,
  readSharedDev,
  readTmuxPanes,
  registerSharedDev,
  stateDirectory,
  unregisterSharedDev,
  type ProcessInventory,
  type SharedDevRegistration,
} from './guardian';

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function options(name: string): string[] {
  return process.argv.flatMap((value, index) =>
    value === name && process.argv[index + 1] !== undefined
      ? [process.argv[index + 1] as string]
      : [],
  );
}

function targetRepository(): string {
  const repository = option('--repository');
  if (repository === null) throw new Error('--repository PATH is required');
  return path.resolve(repository);
}

function tmuxSessionPrefix(): string {
  return option('--tmux-prefix') ?? process.env['AGENT_OS_TMUX_SESSION_PREFIX'] ?? 'agent-os-';
}

function parsePositiveInteger(value: string | null, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function parsePorts(value: string | null): number[] {
  if (value === null || value.trim() === '') return [];
  return value.split(',').map((port) => parsePositiveInteger(port.trim(), 'port'));
}

function writeLine(value: string): void {
  process.stdout.write(`${value}\n`);
}

async function inventory(): Promise<{
  inventory: ProcessInventory;
  records: Awaited<ReturnType<typeof readProcessSnapshot>>;
}> {
  const repositoryRoot = targetRepository();
  const registration = await readSharedDev();
  const roots = discoverWorktrees(repositoryRoot);
  if (registration !== null) roots.push(registration.worktree);
  const records = await readProcessSnapshot();
  const schedulerTracking = await readSchedulerTracking();
  const scriptRoots = options('--script-root');
  return {
    records,
    inventory: buildInventory({
      records,
      roots,
      registration,
      schedulerTracking,
      tmuxPanes: readTmuxPanes(),
      tmuxSessionPrefix: tmuxSessionPrefix(),
      ...(scriptRoots.length === 0 ? {} : { scriptRoots }),
      currentPid: process.pid,
    }),
  };
}

function registrationStatus(registration: SharedDevRegistration | null, active: boolean): string {
  if (registration === null) return 'UNREGISTERED';
  return active ? 'EXTERNAL / PROTECTED / ACTIVE' : 'EXTERNAL / PROTECTED / STALE';
}

function printStatus(status: ProcessInventory): void {
  writeLine('Target process inventory');
  writeLine(
    `Shared dev: ${registrationStatus(status.sharedDev.registration, status.sharedDev.active)}`,
  );
  if (status.sharedDev.registration !== null) {
    const registration = status.sharedDev.registration;
    writeLine(
      `  PID ${String(registration.pid)}; worktree ${registration.worktree}; ports ${registration.ports.join(',') || 'none recorded'}`,
    );
  }
  writeLine(`Registered roots: ${String(status.roots.length)}`);
  writeLine('PID\tPPID\tPGID\tSID\tTOOL\tSTATE\tWORKTREE\tCOMMAND');
  for (const entry of status.processes) {
    const state = entry.protected
      ? 'PROTECTED'
      : entry.orphan
        ? 'ORPHAN'
        : entry.cleanupEligible
          ? 'OWNED'
          : 'GUARDED';
    writeLine(
      `${String(entry.pid)}\t${String(entry.ppid)}\t${String(entry.pgid)}\t${String(entry.sid)}\t${entry.tool}\t${state}\t${entry.worktree}\t${entry.command}`,
    );
  }
  for (const entry of status.ignoredProcesses) {
    writeLine(
      `${String(entry.pid)}\t${String(entry.ppid)}\t${String(entry.pgid)}\t${String(entry.sid)}\t${entry.detectedTool}\tIGNORED\t${entry.worktree}\t${entry.reason}: ${entry.command}`,
    );
  }
  for (const session of status.tmuxSessions.filter((entry) => entry.orchestratorOwned)) {
    writeLine(
      `tmux ${session.name}: ${session.stale ? 'STALE' : 'ACTIVE'} (${String(session.panes.length)} panes)`,
    );
  }
}

async function processCleanup(): Promise<void> {
  const current = await inventory();
  const orphanOnly = hasFlag('--orphans');
  const plan = planCleanup(current.inventory, current.records, orphanOnly);
  const json = hasFlag('--json');
  if (json && !hasFlag('--apply')) {
    writeLine(JSON.stringify(plan, null, 2));
  } else if (!json) {
    writeLine(
      `${hasFlag('--apply') ? 'Applying' : 'Dry run:'} ${String(plan.processes.length)} ${orphanOnly ? 'orphaned ' : ''}target process(es), ${String(plan.units.length)} signal unit(s), ${String(plan.staleTmuxSessions.length)} stale tmux session(s).`,
    );
    for (const processEntry of plan.processes) {
      writeLine(
        `  PID ${String(processEntry.pid)} ${processEntry.tool} PGID ${String(processEntry.pgid)}${processEntry.orphan ? ' ORPHAN' : ''}: ${processEntry.command}`,
      );
    }
  }
  if (!hasFlag('--apply')) {
    if (!json) writeLine('No signals sent. Re-run with --apply to clean up.');
    return;
  }
  const result = await executeCleanup(plan);
  if (json) {
    writeLine(JSON.stringify({ plan, result }, null, 2));
  } else {
    writeLine(
      `Signaled ${String(result.signaled.length)} unit(s); skipped ${String(result.skipped.length)}; removed ${String(result.killedTmuxSessions.length)} stale tmux session(s).`,
    );
    for (const skipped of result.skipped) {
      writeLine(`  Skipped ${skipped.unit.kind} ${String(skipped.unit.id)}: ${skipped.reason}`);
    }
  }
}

async function devRegister(): Promise<void> {
  const pid = parsePositiveInteger(option('--pid'), '--pid');
  const requestedWorktree = option('--worktree');
  if (requestedWorktree === null) throw new Error('--worktree PATH is required');
  const worktree = path.resolve(requestedWorktree);
  const roots = discoverWorktrees(targetRepository());
  const record = await readProcess(pid);
  if (record === null) throw new Error(`PID ${String(pid)} is not running`);
  const registration = await registerSharedDev({
    pid,
    worktree,
    ports: parsePorts(option('--ports')),
    record,
    roots,
  });
  writeLine(
    `Registered PID ${String(registration.pid)} as EXTERNAL / PROTECTED (${registration.worktree}; ports ${registration.ports.join(',') || 'none recorded'}).`,
  );
}

async function devStatus(): Promise<void> {
  const current = (await inventory()).inventory;
  if (hasFlag('--json')) {
    writeLine(JSON.stringify(current.sharedDev, null, 2));
    return;
  }
  writeLine(registrationStatus(current.sharedDev.registration, current.sharedDev.active));
  if (current.sharedDev.registration !== null) {
    writeLine(JSON.stringify(current.sharedDev.registration, null, 2));
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'process-status') {
    const current = (await inventory()).inventory;
    if (hasFlag('--json')) writeLine(JSON.stringify(current, null, 2));
    else printStatus(current);
    return;
  }
  if (command === 'process-cleanup') {
    await processCleanup();
    return;
  }
  if (command === 'dev-register') {
    await devRegister();
    return;
  }
  if (command === 'dev-status') {
    await devStatus();
    return;
  }
  if (command === 'dev-unregister') {
    writeLine(
      (await unregisterSharedDev(stateDirectory()))
        ? 'Shared dev unregistered.'
        : 'No shared dev registered.',
    );
    return;
  }
  throw new Error(`Unknown process guardian command: ${command ?? '(missing)'}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
