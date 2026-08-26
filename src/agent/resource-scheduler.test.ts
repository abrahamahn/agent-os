// src/agent/resource-scheduler.test.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import { authorizeCommand, dispatchPolicy, ResourceScheduler } from './resource-scheduler';

import type { AgentId, JobRequest, ResourceClass, ResourceState } from './resource-scheduler';
import type { CapabilityManifest } from '../control-plane/capability-manifest';

const runtimeDirectories: string[] = [];
const noPressure = {
  high: false,
  reasons: [],
  loadRatio: 0,
  freeMemoryRatio: 1,
  processCount: 1,
};

const cycleA: CapabilityManifest = {
  schemaVersion: 1,
  activePhase: 'cycle-a',
  phases: {
    'cycle-a': {
      workers: Object.fromEntries(
        ['A2', 'A3', 'A5', 'A6', 'A7', 'A8', 'A11', 'A12', 'A13', 'A14', 'A15', 'A16'].map(
          (worker) => [
            worker,
            worker === 'A11'
              ? {
                  capabilities: ['resource:medium', 'resource:heavy', 'validation:broad'],
                  priority: 100,
                }
              : { capabilities: ['resource:medium'] },
          ],
        ),
      ),
    },
  },
};

function scheduler(capabilities: CapabilityManifest = cycleA): ResourceScheduler {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'agent-os-resource-test-'));
  runtimeDirectories.push(runtimeDir);
  return new ResourceScheduler({
    runtimeDir,
    pollMs: 2,
    pressureProvider: () => noPressure,
    capabilities,
  });
}

function request(
  agent: AgentId,
  resource: ResourceClass,
  command: string[],
  overrides: Partial<JobRequest> = {},
): JobRequest {
  return {
    agent,
    resource,
    command,
    worktree: process.cwd(),
    candidateSha: 'candidate-sha',
    ...overrides,
  };
}

afterEach(() => {
  for (const runtimeDir of runtimeDirectories.splice(0)) {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

describe('host-wide capacity and queueing', () => {
  it('allows only one HEAVY job at a time', async () => {
    const subject = scheduler();
    const first = await subject.enqueue(request('A11', 'heavy', ['pnpm', 'ci:merge-gate']));
    const second = await subject.enqueue(request('A11', 'heavy', ['pnpm', 'ci:full']));

    expect((await subject.tryClaim(first.id)).claimed).toBe(true);
    expect((await subject.tryClaim(second.id)).claimed).toBe(false);
    expect((await subject.state()).jobs.find((job) => job.id === second.id)?.status).toBe('QUEUED');
  });

  it('allows two MEDIUM jobs and queues the third until release', async () => {
    const subject = scheduler();
    const first = await subject.enqueue(request('A2', 'medium', ['node', 'engineering-test.js']));
    const second = await subject.enqueue(request('A3', 'medium', ['node', 'engineering-lint.js']));
    const third = await subject.enqueue(request('A5', 'medium', ['node', 'creative-test.js']));

    expect((await subject.tryClaim(first.id)).claimed).toBe(true);
    expect((await subject.tryClaim(second.id)).claimed).toBe(true);
    expect((await subject.tryClaim(third.id)).claimed).toBe(false);
    expect((await subject.state()).jobs.find((job) => job.id === third.id)?.status).toBe('QUEUED');

    await subject.finish(first.id, 'COMPLETED', 0);
    expect((await subject.tryClaim(third.id)).claimed).toBe(true);
  });

  it('keeps HEAVY work queued while the machine is under pressure', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'agent-os-resource-test-'));
    runtimeDirectories.push(runtimeDir);
    const subject = new ResourceScheduler({
      runtimeDir,
      pressureProvider: () => ({ ...noPressure, high: true, reasons: ['low memory'] }),
    });
    const job = await subject.enqueue(request('A11', 'heavy', ['pnpm', 'build']));

    const result = await subject.tryClaim(job.id);
    expect(result).toMatchObject({ claimed: false, pressure: { high: true } });
    expect((await subject.state()).jobs.find((candidate) => candidate.id === job.id)?.status).toBe(
      'QUEUED',
    );
  });
});

describe('lease lifecycle', () => {
  it('removes a stale lease whose owner process no longer exists', async () => {
    const subject = scheduler();
    const job = await subject.enqueue(request('A2', 'medium', ['node', 'focused-test.js']));
    expect((await subject.tryClaim(job.id)).claimed).toBe(true);

    const statePath = join(subject.runtimeDir, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as ResourceState;
    const stored = state.jobs.find((candidate) => candidate.id === job.id);
    if (stored === undefined) throw new Error('Expected stored job');
    stored.ownerPid = 2_000_000_000;
    stored.ownerStartTicks = 'missing';
    writeFileSync(statePath, `${JSON.stringify(state)}\n`);

    expect(await subject.cleanup()).toMatchObject({ staleLeases: 1 });
    expect((await subject.state()).jobs.find((candidate) => candidate.id === job.id)?.status).toBe(
      'CANCELLED',
    );
  });

  it.each([
    { expected: 'COMPLETED', code: 0 },
    { expected: 'FAILED', code: 7 },
  ])('releases the lease after child exit code $code', async ({ expected, code }) => {
    const subject = scheduler();
    const result = await subject.run(
      request('A2', 'medium', [process.execPath, '-e', `process.exit(${String(code)})`]),
    );

    expect(result.exitCode).toBe(code);
    const state = await subject.state();
    expect(state.jobs.find((job) => job.id === result.job.id)?.status).toBe(expected);
    expect(state.jobs.some((job) => job.status === 'RUNNING')).toBe(false);
  });
});

describe('capability enforcement', () => {
  it('delegates shared-dev ownership to the target adapter', () => {
    expect(dispatchPolicy('A2', cycleA)).toContain('target adapter policy');
  });

  it.each([
    ['pnpm', 'dev'],
    ['pnpm', 'dev:portal'],
    ['bash', '-c', 'pnpm dev'],
    ['pnpm', 'start'],
    ['vite', '--host'],
    ['turbo', 'watch'],
    ['nohup', 'node', 'server.js'],
    ['tmux', 'new-session', '-d', 'pnpm dev'],
    ['cargo', 'watch', '-x', 'test'],
    ['python', '-m', 'http.server'],
  ])('prevents agents from starting persistent command %s', (...command) => {
    expect(authorizeCommand('A11', 'heavy', command, cycleA)).toMatch(/may not start/i);
  });

  it.each(['A6', 'A7', 'A8'])('keeps Cycle A focused fixer %s off HEAVY', (worker) => {
    expect(authorizeCommand(worker, 'heavy', ['pnpm', 'ci:merge-gate'], cycleA)).toMatch(
      /lacks resource:heavy/i,
    );
  });

  it('allows A11 to run the broad gate', () => {
    expect(authorizeCommand('A11', 'heavy', ['pnpm', 'ci:merge-gate'], cycleA)).toBeUndefined();
  });

  it.each([
    ['cargo', 'test', '--workspace'],
    ['go', 'test', './...'],
    ['pytest'],
    ['./gradlew', 'check'],
    ['tsc', '--build'],
    ['vitest', 'run'],
    ['eslint', '.'],
  ])('treats a repository-wide command as broad validation', (...command) => {
    expect(authorizeCommand('A2', 'medium', command, cycleA)).toMatch(/HEAVY/iu);
    expect(authorizeCommand('A11', 'heavy', command, cycleA)).toBeUndefined();
  });

  it.each([
    ['tsc', '--project', 'packages/client/tsconfig.json'],
    ['vitest', 'run', 'packages/client/src/client.test.ts'],
    ['eslint', 'packages/client/src/client.ts'],
  ])('allows a focused TypeScript command to use a medium lease', (...command) => {
    expect(authorizeCommand('A2', 'medium', command, cycleA)).toBeUndefined();
  });

  it.each([
    ['pnpm', 'exec', 'tsc', '--build'],
    ['npm', 'exec', '--', 'vitest', 'run'],
    ['bun', 'x', 'eslint', '.'],
  ])('recognizes a repository-wide TypeScript command through a package manager', (...command) => {
    expect(authorizeCommand('A2', 'medium', command, cycleA)).toMatch(/HEAVY/iu);
    expect(authorizeCommand('A11', 'heavy', command, cycleA)).toBeUndefined();
  });

  it('changes phase and HEAVY owner without scheduler source changes', () => {
    const nextPhase: CapabilityManifest = {
      schemaVersion: 1,
      activePhase: 'cycle-b',
      phases: {
        'cycle-b': {
          workers: {
            A11: { capabilities: ['resource:medium'] },
            Q2: {
              capabilities: ['resource:medium', 'resource:heavy', 'validation:broad'],
              priority: 100,
            },
          },
        },
      },
    };

    expect(authorizeCommand('A11', 'heavy', ['pnpm', 'ci:full'], nextPhase)).toMatch(
      /lacks resource:heavy/i,
    );
    expect(authorizeCommand('Q2', 'heavy', ['pnpm', 'ci:full'], nextPhase)).toBeUndefined();
  });
});
