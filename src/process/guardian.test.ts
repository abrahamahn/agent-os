// src/process/guardian.test.ts
import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildInventory,
  executeCleanup,
  planCleanup,
  readSharedDev,
  registerSharedDev,
  unregisterSharedDev,
  type ProcessRecord,
  type SharedDevRegistration,
} from './guardian';

const ROOT = '/workspace/target';
const temporaryDirectories: string[] = [];

function processRecord(
  pid: number,
  overrides: Partial<ProcessRecord> & Pick<ProcessRecord, 'args'>,
): ProcessRecord {
  return {
    pid,
    ppid: 10,
    pgid: pid,
    sid: 10,
    startTimeTicks: String(pid * 100),
    comm: 'node',
    cwd: ROOT,
    ...overrides,
  };
}

function protectedRegistration(pid: number): SharedDevRegistration {
  return {
    schemaVersion: 1,
    owner: 'EXTERNAL',
    protection: 'PROTECTED',
    pid,
    startTimeTicks: String(pid * 100),
    worktree: ROOT,
    ports: [5173, 8080],
    registeredAt: '2026-08-14T00:00:00.000Z',
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('target process inventory', () => {
  it('identifies an allow-listed process rooted in a registered target worktree', () => {
    const turbo = processRecord(101, {
      args: ['node', `${ROOT}/node_modules/.bin/turbo`, 'run', 'test'],
    });
    const inventory = buildInventory({ records: [turbo], roots: [ROOT] });

    expect(inventory.processes).toMatchObject([
      { pid: 101, tool: 'turbo', worktree: ROOT, cleanupEligible: true },
    ]);
    expect(inventory.processes[0]).not.toHaveProperty('args');
  });

  it.each([
    ['cargo', ['cargo', 'test', '--workspace']],
    ['go', ['go', 'test', './...']],
    ['pytest', ['pytest', 'tests']],
    ['gradle', ['./gradlew', 'check']],
  ])('identifies a target %s workload without a JavaScript wrapper', (tool, args) => {
    const record = processRecord(150, { args, comm: tool });
    const inventory = buildInventory({ records: [record], roots: [ROOT] });

    expect(inventory.processes).toMatchObject([
      { pid: 150, tool, worktree: ROOT, cleanupEligible: true },
    ]);
  });

  it('ignores unrelated Node outside target and shows VS Code as operational tooling', () => {
    const unrelated = processRecord(201, {
      args: ['node', '/srv/another-app/server.js'],
      cwd: '/srv/another-app',
    });
    const vscode = processRecord(202, {
      args: ['node', '/users/example/.vscode-server/bin/extensionHost.js'],
    });

    const inventory = buildInventory({ records: [unrelated, vscode], roots: [ROOT] });

    expect(inventory.processes).toEqual([]);
    expect(inventory.ignoredProcesses).toMatchObject([
      { pid: 202, cleanupEligible: false, reason: 'operational-tooling' },
    ]);
  });

  it.each([
    ['Codex', ['node', '/users/example/.nvm/versions/node/v24/bin/codex'], 'operational-tooling'],
    [
      'Playwright MCP',
      ['node', '/users/example/.npm/_npx/tool/node_modules/.bin/playwright-mcp'],
      'operational-tooling',
    ],
    [
      'Chrome DevTools MCP',
      ['node', '/users/example/.npm/_npx/tool/node_modules/chrome-devtools-mcp/watchdog.js'],
      'operational-tooling',
    ],
    [
      'generic MCP server',
      ['node', '/users/example/tools/example-mcp-server/index.js'],
      'operational-tooling',
    ],
    ['ordinary unrelated Node script', ['node', 'unrelated.js'], 'unknown-signature'],
  ])('fails closed for %s even when cwd is the repository', (_label, args, reason) => {
    const record = processRecord(250, { args });
    const inventory = buildInventory({ records: [record], roots: [ROOT] });

    expect(inventory.processes).toEqual([]);
    expect(inventory.ignoredProcesses).toMatchObject([
      { pid: 250, detectedTool: 'node', cleanupEligible: false, reason },
    ]);
    expect(planCleanup(inventory, [record], false).processes).toEqual([]);
  });

  it('keeps scheduler-tracked target tsc, vitest, and eslint eligible', () => {
    const records = [
      processRecord(261, { args: ['node', '/opt/tools/tsc'] }),
      processRecord(262, { args: ['node', '/opt/tools/vitest'] }),
      processRecord(263, { args: ['node', '/opt/tools/eslint'] }),
    ];
    const schedulerTracking = records.map((record) => ({
      childPid: record.pid,
      childStartTicks: record.startTimeTicks,
      processGroup: record.pgid,
      worktree: ROOT,
    }));
    const inventory = buildInventory({ records, roots: [ROOT], schedulerTracking });

    expect(inventory.processes).toMatchObject([
      { pid: 261, tool: 'tsc', ownershipEvidence: 'scheduler', cleanupEligible: true },
      { pid: 262, tool: 'vitest', ownershipEvidence: 'scheduler', cleanupEligible: true },
      { pid: 263, tool: 'eslint', ownershipEvidence: 'scheduler', cleanupEligible: true },
    ]);
  });

  it('keeps operational tooling ignored even if scheduler state names its PID and group', () => {
    const codex = processRecord(270, {
      args: ['node', '/users/example/.nvm/versions/node/v24/bin/codex'],
      pgid: 270,
    });
    const inventory = buildInventory({
      records: [codex],
      roots: [ROOT],
      schedulerTracking: [
        {
          childPid: codex.pid,
          childStartTicks: codex.startTimeTicks,
          processGroup: codex.pgid,
          worktree: ROOT,
        },
      ],
    });

    expect(inventory.processes).toEqual([]);
    expect(inventory.ignoredProcesses).toMatchObject([
      { pid: 270, cleanupEligible: false, reason: 'operational-tooling' },
    ]);
  });

  it('protects the registered external shared dev and its descendants', () => {
    const pnpm = processRecord(301, { args: ['pnpm', 'dev'], ppid: 20, pgid: 301 });
    const child = processRecord(302, {
      args: ['node', 'runtime-wrapper.js'],
      ppid: 301,
      pgid: 301,
    });
    const inventory = buildInventory({
      records: [pnpm, child],
      roots: [ROOT],
      registration: protectedRegistration(301),
    });

    expect(inventory.sharedDev.active).toBe(true);
    expect(
      inventory.processes.map(({ pid, protected: guarded, cleanupEligible }) => ({
        pid,
        guarded,
        cleanupEligible,
      })),
    ).toEqual([
      { pid: 301, guarded: true, cleanupEligible: false },
      { pid: 302, guarded: true, cleanupEligible: false },
    ]);
    expect(planCleanup(inventory, [pnpm, child], false).processes).toEqual([]);
  });

  it('marks a stale tracked dev identity without protecting a reused PID', () => {
    const replacement = processRecord(350, { args: ['pnpm', 'test'], ppid: 20 });
    const registration = { ...protectedRegistration(350), startTimeTicks: 'old-process' };
    const inventory = buildInventory({ records: [replacement], roots: [ROOT], registration });

    expect(inventory.sharedDev).toMatchObject({ active: false, stale: true });
    expect(inventory.processes[0]).toMatchObject({ protected: false, cleanupEligible: true });
    expect(planCleanup(inventory, [replacement], false).processes).toHaveLength(1);
  });

  it('keeps a genuine reparented target pnpm descendant eligible as an orphan', () => {
    const worker = processRecord(401, {
      args: ['node', `${ROOT}/node_modules/typescript/bin/tsc`, '--build'],
      ppid: 1,
    });
    const inventory = buildInventory({ records: [worker], roots: [ROOT] });

    expect(inventory.processes[0]).toMatchObject({ pid: 401, tool: 'tsc', orphan: true });
    expect(planCleanup(inventory, [worker], true).processes.map(({ pid }) => pid)).toEqual([401]);
  });

  it('marks only dead target-prefixed tmux sessions in registered worktrees as stale', () => {
    const inventory = buildInventory({
      records: [],
      roots: [ROOT],
      tmuxPanes: [
        {
          session: 'agent-os-a13-check',
          pid: 450,
          cwd: ROOT,
          dead: true,
          command: 'node',
        },
        {
          session: 'personal',
          pid: 451,
          cwd: ROOT,
          dead: true,
          command: 'node',
        },
      ],
    });

    expect(inventory.tmuxSessions).toMatchObject([
      { name: 'agent-os-a13-check', orchestratorOwned: true, stale: true },
      { name: 'personal', orchestratorOwned: false, stale: false },
    ]);
    expect(planCleanup(inventory, [], true).staleTmuxSessions).toEqual(['agent-os-a13-check']);
  });

  it('only uses process-group signaling when every group member is eligible', () => {
    const pnpm = processRecord(501, { args: ['pnpm', 'test'], ppid: 20, pgid: 500 });
    const vitest = processRecord(502, {
      args: ['node', `${ROOT}/node_modules/vitest/vitest.mjs`],
      ppid: 501,
      pgid: 500,
    });
    const inventory = buildInventory({ records: [pnpm, vitest], roots: [ROOT] });
    const plan = planCleanup(inventory, [pnpm, vitest], false);

    expect(plan.processes.map(({ pid }) => pid)).toEqual([502, 501]);
    expect(plan.units).toEqual([
      {
        kind: 'group',
        id: 500,
        members: [
          { pid: 501, startTimeTicks: '50100' },
          { pid: 502, startTimeTicks: '50200' },
        ],
      },
    ]);

    const unknownNode = processRecord(503, {
      args: ['node', 'unrelated.js'],
      pgid: 500,
    });
    const mixedInventory = buildInventory({
      records: [pnpm, vitest, unknownNode],
      roots: [ROOT],
    });
    expect(mixedInventory.ignoredProcesses).toMatchObject([
      { pid: 503, cleanupEligible: false, reason: 'unknown-signature' },
    ]);
    expect(planCleanup(mixedInventory, [pnpm, vitest, unknownNode], false).units).toMatchObject([
      { kind: 'process', id: 502 },
      { kind: 'process', id: 501 },
    ]);
  });
});

describe('safe cleanup execution', () => {
  it('cleans a stale tracked process tree and revalidates identities before signaling', async () => {
    const pnpm = processRecord(601, { args: ['pnpm', 'lint'], ppid: 20, pgid: 600 });
    const eslint = processRecord(602, {
      args: ['node', `${ROOT}/node_modules/eslint/bin/eslint.js`],
      ppid: 601,
      pgid: 600,
    });
    const inventory = buildInventory({ records: [pnpm, eslint], roots: [ROOT] });
    const plan = planCleanup(inventory, [pnpm, eslint], false);
    const signals: Array<[number, NodeJS.Signals]> = [];
    let snapshotCount = 0;

    const result = await executeCleanup(plan, {
      snapshot: () => {
        snapshotCount += 1;
        return snapshotCount === 1 ? [pnpm, eslint] : [];
      },
      signal: (target, signal) => signals.push([target, signal]),
      waitMs: 0,
      killTmuxSession: () => false,
    });

    expect(result.skipped).toEqual([]);
    expect(signals).toEqual([[-600, 'SIGTERM']]);
  });

  it('skips cleanup when a PID was reused or group membership changed', async () => {
    const vitest = processRecord(701, { args: ['vitest'], ppid: 1 });
    const inventory = buildInventory({ records: [vitest], roots: [ROOT] });
    const plan = planCleanup(inventory, [vitest], true);
    const signal = vi.fn();

    const result = await executeCleanup(plan, {
      snapshot: () => [{ ...vitest, startTimeTicks: 'replacement' }],
      signal,
      waitMs: 0,
      killTmuxSession: () => false,
    });

    expect(signal).not.toHaveBeenCalled();
    expect(result.skipped[0]?.reason).toContain('identity');
  });
});

describe('external shared-dev registry', () => {
  it('writes and removes an EXTERNAL / PROTECTED registration outside the worktree', async () => {
    const directory = await fs.mkdtemp('/tmp/agent-os-process-guardian-test-');
    await fs.chmod(directory, 0o700);
    temporaryDirectories.push(directory);
    const pnpm = processRecord(801, { args: ['pnpm', 'dev'], ppid: 20 });

    const registration = await registerSharedDev({
      pid: 801,
      worktree: ROOT,
      ports: [5173, 8080, 5173],
      record: pnpm,
      roots: [ROOT],
      directory,
      now: new Date('2026-08-14T00:00:00.000Z'),
    });

    expect(registration).toMatchObject({ owner: 'EXTERNAL', protection: 'PROTECTED' });
    expect(registration.ports).toEqual([5173, 8080]);
    expect(await readSharedDev(directory)).toEqual(registration);
    expect(path.dirname(path.join(directory, 'shared-dev.json'))).not.toBe(ROOT);
    expect(await unregisterSharedDev(directory)).toBe(true);
    expect(await readSharedDev(directory)).toBeNull();
  });
});
