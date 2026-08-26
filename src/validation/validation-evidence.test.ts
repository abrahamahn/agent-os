// src/validation/validation-evidence.test.ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildEvidenceIdentity,
  fingerprintDependencyFiles,
  ValidationEvidenceStore,
} from './validation-evidence';

import type { BuildIdentityInput, EvidenceIdentity } from './validation-evidence';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(resolve(tmpdir(), 'agent-os-evidence-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function identity(overrides: Partial<BuildIdentityInput> = {}): EvidenceIdentity {
  return buildEvidenceIdentity({
    candidateSha: SHA_A,
    checkId: 'web:focused-test',
    command: ['pnpm', '--filter', '@example/web', 'test'],
    dependencyFingerprint: 'dependencies-a',
    ...overrides,
  });
}

async function pass(
  store: ValidationEvidenceStore,
  evidenceIdentity: EvidenceIdentity,
  owner: string,
): Promise<string> {
  const requested = await store.request(evidenceIdentity, owner);
  expect(requested.action).toBe('RUN');
  await store.start(requested.job.id, owner, 1234);
  await store.complete(requested.job.id, { state: 'PASS' });
  return requested.job.id;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('ValidationEvidenceStore', () => {
  it('reuses PASS evidence for the exact candidate SHA and identity', async () => {
    const store = new ValidationEvidenceStore({ runtimeDir: temporaryDirectory() });
    const evidenceIdentity = identity();
    const sourceJobId = await pass(store, evidenceIdentity, 'A2');

    const requested = await store.request(evidenceIdentity, 'A1');

    expect(requested).toMatchObject({
      action: 'REUSE',
      state: 'REUSED',
      sourceJobId,
      job: { state: 'PASS', subscribers: ['A2', 'A1'] },
    });
  });

  it('invalidates evidence when the candidate SHA changes', async () => {
    const store = new ValidationEvidenceStore({ runtimeDir: temporaryDirectory() });
    await pass(store, identity(), 'A2');

    const requested = await store.request(identity({ candidateSha: SHA_B }), 'A1');

    expect(requested).toMatchObject({ action: 'RUN', state: 'QUEUED' });
  });

  it('suppresses an equivalent running job atomically', async () => {
    const store = new ValidationEvidenceStore({ runtimeDir: temporaryDirectory() });
    const evidenceIdentity = identity();
    const first = await store.request(evidenceIdentity, 'A2');
    await store.start(first.job.id, 'A2', 1234);

    const [second, third] = await Promise.all([
      store.request(evidenceIdentity, 'A3'),
      store.request(evidenceIdentity, 'A10'),
    ]);

    expect(second).toMatchObject({ action: 'WAIT', state: 'RUNNING' });
    expect(third).toMatchObject({ action: 'WAIT', state: 'RUNNING' });
    expect(second.job.id).toBe(first.job.id);
    expect(third.job.id).toBe(first.job.id);
    expect((await store.snapshot()).jobs).toHaveLength(1);
  });

  it('does not include worker or manager ownership in the evidence identity', async () => {
    const store = new ValidationEvidenceStore({ runtimeDir: temporaryDirectory() });
    const evidenceIdentity = identity();
    await pass(store, evidenceIdentity, 'A2');

    const managerRequest = await store.request(evidenceIdentity, 'A1');

    expect(managerRequest.action).toBe('REUSE');
  });

  it('retains failed attempts while allowing a new attempt for the same identity', async () => {
    const store = new ValidationEvidenceStore({ runtimeDir: temporaryDirectory() });
    const evidenceIdentity = identity();
    const first = await store.request(evidenceIdentity, 'A2');
    await store.start(first.job.id, 'A2', 1234);
    await store.complete(first.job.id, { state: 'FAIL', summary: 'focused assertion failed' });

    const retry = await store.request(evidenceIdentity, 'A3');
    const jobs = await store.jobsFor(evidenceIdentity);

    expect(retry).toMatchObject({ action: 'RUN', state: 'QUEUED' });
    expect(jobs).toEqual([
      expect.objectContaining({ id: first.job.id, state: 'FAIL' }),
      expect.objectContaining({ id: retry.job.id, state: 'QUEUED' }),
    ]);
  });

  it('keeps environment blocks distinct from validation failures', async () => {
    const store = new ValidationEvidenceStore({ runtimeDir: temporaryDirectory() });
    const evidenceIdentity = identity();
    const requested = await store.request(evidenceIdentity, 'A2');
    await store.start(requested.job.id, 'A2', 1234);

    const blocked = await store.complete(requested.job.id, {
      state: 'ENVIRONMENT_BLOCKED',
      summary: 'browser unavailable',
    });

    expect(blocked.state).toBe('ENVIRONMENT_BLOCKED');
    expect(blocked.state).not.toBe('FAIL');
    await expect(store.request(evidenceIdentity, 'A3')).resolves.toMatchObject({ action: 'RUN' });
  });

  it('invalidates evidence when a relevant dependency fingerprint changes', async () => {
    const store = new ValidationEvidenceStore({ runtimeDir: temporaryDirectory() });
    await pass(store, identity(), 'A2');

    const requested = await store.request(
      identity({ dependencyFingerprint: 'dependencies-b' }),
      'A1',
    );

    expect(requested).toMatchObject({ action: 'RUN', state: 'QUEUED' });
  });

  it('invalidates evidence when the exact command definition changes', async () => {
    const store = new ValidationEvidenceStore({ runtimeDir: temporaryDirectory() });
    await pass(store, identity(), 'A2');

    const requested = await store.request(
      identity({ command: ['pnpm', '--filter', '@example/web', 'test', '--runInBand'] }),
      'A1',
    );

    expect(requested).toMatchObject({ action: 'RUN', state: 'QUEUED' });
  });

  it('invalidates only checks that declare a changed environment fingerprint', async () => {
    const store = new ValidationEvidenceStore({ runtimeDir: temporaryDirectory() });
    await pass(store, identity({ environmentFingerprint: 'linux-node-22' }), 'A2');

    const requested = await store.request(
      identity({ environmentFingerprint: 'linux-node-24' }),
      'A1',
    );

    expect(requested).toMatchObject({ action: 'RUN', state: 'QUEUED' });
  });

  it('fails closed instead of discarding unreadable evidence state', async () => {
    const runtimeDir = temporaryDirectory();
    writeFileSync(resolve(runtimeDir, 'validation-evidence.json'), 'not-json\n');
    const store = new ValidationEvidenceStore({ runtimeDir });

    await expect(store.request(identity(), 'A2')).rejects.toThrow(
      'validation evidence state is unreadable',
    );
  });
});

describe('fingerprintDependencyFiles', () => {
  it('changes only when a declared dependency input changes', () => {
    const root = temporaryDirectory();
    writeFileSync(resolve(root, 'lock.yaml'), 'version: 1\n');
    writeFileSync(resolve(root, 'unrelated.txt'), 'first\n');
    const before = fingerprintDependencyFiles(root, ['lock.yaml']);

    writeFileSync(resolve(root, 'unrelated.txt'), 'second\n');
    expect(fingerprintDependencyFiles(root, ['lock.yaml'])).toBe(before);

    writeFileSync(resolve(root, 'lock.yaml'), 'version: 2\n');
    expect(fingerprintDependencyFiles(root, ['lock.yaml'])).not.toBe(before);
  });
});
