// src/agent/resource-scheduler.agent-os.test.ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  candidateContext,
  EXECUTION_ATTESTATION_PREFIX,
  ResourceScheduler,
} from './resource-scheduler';

import type { JobRequest, RunRequest } from './resource-scheduler';

const noPressure = {
  high: false,
  reasons: [],
  loadRatio: 0,
  freeMemoryRatio: 1,
  processCount: 1,
};

let root = '';
let worktree = '';
let runtimeDir = '';
let candidateSha = '';

function git(args: readonly string[]): string {
  return execFileSync('git', args, { cwd: worktree, encoding: 'utf8' }).trim();
}

function scheduler(): ResourceScheduler {
  return new ResourceScheduler({
    runtimeDir,
    pollMs: 2,
    pressureProvider: () => noPressure,
  });
}

function request(command: string[], overrides: Partial<JobRequest> = {}): JobRequest {
  return {
    agent: 'A11',
    resource: 'medium',
    command,
    worktree,
    candidateSha,
    environmentKey: 'agent-os-test-environment',
    reuseEligible: true,
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-os-resource-test-'));
  worktree = join(root, 'worktree');
  runtimeDir = join(root, 'runtime');
  mkdirSync(worktree);
  git(['init', '--quiet']);
  git(['config', 'user.name', 'Agent OS Test']);
  git(['config', 'user.email', 'agent-os-test@invalid.example']);
  writeFileSync(join(worktree, 'candidate.txt'), 'candidate\n');
  git(['add', 'candidate.txt']);
  git(['commit', '--quiet', '-m', 'candidate']);
  candidateSha = git(['rev-parse', 'HEAD']);
});

afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('Agent OS resource evidence', () => {
  it('rejects a false exact-SHA identity', async () => {
    expect(() => candidateContext(worktree, 'a'.repeat(40))).toThrow(/CANDIDATE_SHA_MISMATCH/iu);
    await expect(
      scheduler().enqueue(
        request([process.execPath, '-e', 'process.exit(0)'], {
          candidateSha: 'a'.repeat(40),
        }),
      ),
    ).rejects.toThrow(/CANDIDATE_SHA_MISMATCH/iu);
  });

  it('fails closed when scheduler state is corrupt', async () => {
    const subject = scheduler();
    mkdirSync(runtimeDir);
    writeFileSync(join(runtimeDir, 'state.json'), 'not-json\n');
    await expect(subject.state()).rejects.toThrow(/state is unreadable/iu);
  });

  it('replaces the child environment without leaking ambient values', async () => {
    const subject = scheduler();
    const output = join(runtimeDir, 'environment.json');
    process.env['AGENT_OS_UNADMITTED_TEST_VALUE'] = 'must-not-leak';
    try {
      const script =
        "require('node:fs').writeFileSync(process.env.OUTPUT,JSON.stringify({admitted:process.env.ADMITTED,unadmitted:process.env.AGENT_OS_UNADMITTED_TEST_VALUE}))";
      const runRequest: RunRequest = {
        ...request([process.execPath, '-e', script], { reuseEligible: false }),
        childEnvironment: {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          OUTPUT: output,
          ADMITTED: 'yes',
        },
        childEnvironmentMode: 'replace',
      };
      const result = await subject.run(runRequest);
      expect(result).toMatchObject({ exitCode: 0, commandStarted: true });
      expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({
        admitted: 'yes',
      });
    } finally {
      delete process.env['AGENT_OS_UNADMITTED_TEST_VALUE'];
    }
  });

  it('reuses only a successful command with valid execution attestation', async () => {
    const subject = scheduler();
    const token = 'controller-token';
    const attested: RunRequest = {
      ...request([
        '/usr/bin/printf',
        `${EXECUTION_ATTESTATION_PREFIX}${JSON.stringify({
          schemaVersion: 1,
          token,
          productStarted: true,
        })}\n`,
      ]),
      executionAttestationRequired: true,
      executionAttestation: { token },
    };

    const first = await subject.run(attested);
    expect(first).toMatchObject({
      exitCode: 0,
      commandStarted: true,
      execution: { productStarted: true, source: 'ATTESTED' },
      job: { status: 'COMPLETED', executionAttested: true },
    });

    const reused = await subject.run(attested);
    expect(reused).toMatchObject({
      exitCode: 0,
      commandStarted: false,
      execution: { productStarted: true, source: 'REUSED' },
      job: { status: 'REUSED', reusedFrom: first.job.id },
    });
  });

  it('does not reuse a successful process that omitted execution attestation', async () => {
    const subject = scheduler();
    const unattested: RunRequest = {
      ...request([process.execPath, '-e', 'process.exit(0)']),
      executionAttestationRequired: true,
      executionAttestation: { token: 'expected-token' },
    };

    const first = await subject.run(unattested);
    const second = await subject.run(unattested);
    expect(first.execution?.productStarted).toBe(false);
    expect(second.execution?.productStarted).toBe(false);
    expect(second.job.status).toBe('COMPLETED');
    expect(second.job.id).not.toBe(first.job.id);
  });

  it('suppresses duplicate broad validation already in flight', async () => {
    const subject = scheduler();
    const broad = request(['pnpm', 'ci:merge-gate'], { resource: 'heavy' });
    const first = await subject.enqueue(broad);
    const duplicate = await subject.enqueue(broad);
    expect(first.status).toBe('QUEUED');
    expect(duplicate).toMatchObject({
      status: 'CANCELLED',
      duplicateOf: first.id,
    });
    expect((await subject.state()).duplicateJobsPrevented).toBe(1);
  });
});
