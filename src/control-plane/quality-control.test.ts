// src/control-plane/quality-control.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ResourceScheduler } from '../agent/resource-scheduler';
import { stateDirectory } from '../process/guardian';
import { ValidationEvidenceStore } from '../validation/validation-evidence';

import { runQualityCheck, type ProcessSafetySnapshot } from './quality-control';
import { controlPlaneRuntime, controlPlaneRuntimeChild } from './runtime';

import type { CapabilityManifest } from './capability-manifest';
import type { EvidenceIdentity } from '../validation/validation-evidence';

const temporaryDirectories: string[] = [];
const candidateSha = 'a'.repeat(40);
const identity: EvidenceIdentity = {
  candidateSha,
  checkId: 'repo:focused-control-plane',
  commandFingerprint: 'command-fingerprint',
  dependencyFingerprint: 'dependency-fingerprint',
  environmentFingerprint: 'portable',
};
const processSafety: ProcessSafetySnapshot = {
  sharedDev: 'ACTIVE_PROTECTED',
  targetProcesses: 1,
  cleanupEligible: 0,
  orphans: 0,
  staleTmuxSessions: 0,
};
const capabilities: CapabilityManifest = {
  schemaVersion: 1,
  activePhase: 'cycle-a',
  phases: {
    'cycle-a': {
      workers: {
        A11: {
          capabilities: ['resource:medium', 'resource:heavy', 'validation:broad'],
          priority: 100,
        },
      },
    },
  },
};

function dependencies() {
  const root = mkdtempSync(join(tmpdir(), 'agent-os-quality-control-test-'));
  temporaryDirectories.push(root);
  const inspectProcesses = vi.fn(async () => processSafety);
  return {
    evidence: new ValidationEvidenceStore({ runtimeDir: join(root, 'evidence') }),
    resources: new ResourceScheduler({
      runtimeDir: join(root, 'resources'),
      pollMs: 2,
      pressureProvider: () => ({
        high: false,
        reasons: [],
        loadRatio: 0,
        freeMemoryRatio: 1,
        processCount: 1,
      }),
      capabilities,
    }),
    inspectProcesses,
  };
}

function request(command: readonly string[]) {
  return {
    runnerId: 'A11',
    checkId: identity.checkId,
    command,
    worktree: process.cwd(),
    identity,
    failureCategory: 'STATIC' as const,
    focusedFixOwner: 'A6' as const,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('quality control-plane adapter', () => {
  it('places scheduler, evidence, and guardian state under one runtime root', () => {
    const root = join(tmpdir(), 'agent-os-shared-runtime-test');
    vi.stubEnv('AGENT_OS_RUNTIME_DIR', root);

    expect(controlPlaneRuntime()).toBe(root);
    expect(new ResourceScheduler({ capabilities }).runtimeDir).toBe(root);
    expect(new ValidationEvidenceStore().runtimeDir).toBe(
      controlPlaneRuntimeChild('validation-evidence'),
    );
    expect(stateDirectory()).toBe(controlPlaneRuntimeChild('process-guardian'));
  });

  it('runs once under a resource lease, records PASS, then reuses exact evidence', async () => {
    const adapters = dependencies();
    const first = await runQualityCheck(
      request([process.execPath, '-e', 'process.exit(0)']),
      adapters,
    );
    const second = await runQualityCheck(
      request([process.execPath, '-e', 'process.exit(0)']),
      adapters,
    );

    expect(first).toMatchObject({ outcome: 'PASS', evidenceJob: { state: 'PASS' } });
    expect(second).toMatchObject({ outcome: 'REUSE' });
    expect((await adapters.resources.state()).jobs).toHaveLength(1);
    expect((await adapters.resources.state()).jobs[0]?.status).toBe('COMPLETED');
    expect(adapters.inspectProcesses).toHaveBeenCalledTimes(2);
  });

  it('returns WAIT for an equivalent active job without requesting a resource', async () => {
    const adapters = dependencies();
    await adapters.evidence.request(identity, 'other-runner');

    const result = await runQualityCheck(
      request([process.execPath, '-e', 'process.exit(0)']),
      adapters,
    );

    expect(result).toMatchObject({ outcome: 'WAIT', evidenceJob: { state: 'QUEUED' } });
    expect((await adapters.resources.state()).jobs).toHaveLength(0);
    expect(adapters.inspectProcesses).not.toHaveBeenCalled();
  });

  it('records a structured category and releases the lease after failure', async () => {
    const adapters = dependencies();
    const result = await runQualityCheck(
      request([process.execPath, '-e', 'process.exit(7)']),
      adapters,
    );

    expect(result).toMatchObject({
      outcome: 'FAIL',
      evidenceJob: { state: 'FAIL' },
      failure: {
        category: 'STATIC',
        stage: 'EXECUTION',
        exitCode: 7,
        orchestrator: 'A16',
        focusedFixOwner: 'A6',
      },
    });
    expect((await adapters.resources.state()).jobs[0]?.status).toBe('FAILED');
    expect((await adapters.resources.state()).jobs.some((job) => job.status === 'RUNNING')).toBe(
      false,
    );
  });

  it('fails closed before resource acquisition when process visibility is unavailable', async () => {
    const adapters = dependencies();
    adapters.inspectProcesses.mockRejectedValueOnce(new Error('procfs unavailable'));

    const result = await runQualityCheck(
      request([process.execPath, '-e', 'process.exit(0)']),
      adapters,
    );

    expect(result).toMatchObject({
      outcome: 'BLOCKED',
      evidenceJob: { state: 'CANCELLED' },
      failure: { category: 'ENVIRONMENT', stage: 'PROCESS_SAFETY' },
    });
    expect((await adapters.resources.state()).jobs).toHaveLength(0);
  });
});
