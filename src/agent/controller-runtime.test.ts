// src/agent/controller-runtime.test.ts
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { adoptLegacyState, ensureControllerRuntimeDirectory } from './controller-runtime';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync('git', ['-C', cwd, ...args])).stdout.trim();
}

async function legacyFixture(): Promise<{
  root: string;
  store: string;
  checkout: string;
  sha: string;
  tree: string;
}> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-os-legacy-verified-'));
  temporaryDirectories.push(root);
  const repo = path.join(root, 'repo');
  const store = path.join(root, 'store.git');
  const checkout = path.join(root, 'review');
  await fs.mkdir(repo);
  await git(repo, ['init', '--quiet']);
  await git(repo, ['config', 'user.name', 'fixture']);
  await git(repo, ['config', 'user.email', 'fixture@example.invalid']);
  await fs.writeFile(path.join(repo, 'candidate.txt'), 'verified\n');
  await git(repo, ['add', 'candidate.txt']);
  await git(repo, ['commit', '--quiet', '-m', 'candidate']);
  const sha = await git(repo, ['rev-parse', 'HEAD']);
  const tree = await git(repo, ['rev-parse', 'HEAD^{tree}']);
  await execFileAsync('git', ['clone', '--quiet', '--bare', repo, store]);
  await execFileAsync('git', ['clone', '--quiet', repo, checkout]);
  return { root, store, checkout, sha, tree };
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('legacy controller-state adoption', () => {
  it('quarantines ambiguous legacy state without trusting it', async () => {
    const legacy = await fs.mkdtemp(path.join(tmpdir(), 'agent-os-legacy-'));
    const host = await fs.mkdtemp(path.join(tmpdir(), 'agent-os-adoption-'));
    temporaryDirectories.push(legacy, host);
    await fs.writeFile(path.join(legacy, 'orchestration-state.json'), '{"tasks":[{}]}\n');
    const report = await adoptLegacyState({
      legacyRoot: legacy,
      hostRoot: host,
      allowUnsafeTestRuntime: true,
    });
    expect(report.authority).toBe('NON_AUTHORITATIVE');
    expect(report.adopted).toHaveLength(0);
    expect(report.unresolved).toContain('task identity or generation is missing');
    await expect(fs.access(report.quarantineManifest)).resolves.toBeUndefined();
  });

  it('imports candidate objects durably but never trusts a fabricated legacy PASS', async () => {
    const current = await legacyFixture();
    const host = await fs.mkdtemp(path.join(tmpdir(), 'agent-os-adoption-verified-'));
    temporaryDirectories.push(host);
    const legacyState = {
      tasks: [
        {
          id: 'task-verified',
          generation: 2,
          status: 'READY_FOR_INTEGRATION',
          capturedCandidate: {
            candidateSha: current.sha,
            treeSha: current.tree,
            storeGitDirectory: current.store,
            ref: `refs/candidates/task-verified/${current.sha}`,
          },
        },
      ],
      artifacts: [
        {
          id: 'fabricated-review',
          verification: 'ACCEPTED',
          artifact: {
            kind: 'REVIEW_RESULT',
            taskId: 'task-verified',
            generation: 2,
            reviewedSha: current.sha,
            candidateTreeSha: current.tree,
            status: 'PASS',
            reviewMaterializationId: 'fabricated-materialization',
            reviewCheckout: current.checkout,
          },
        },
      ],
    };
    await fs.writeFile(
      path.join(current.root, 'orchestration-state.json'),
      `${JSON.stringify(legacyState)}\n`,
    );

    const report = await adoptLegacyState({
      legacyRoot: current.root,
      hostRoot: host,
      allowUnsafeTestRuntime: true,
      now: new Date('2026-08-16T00:00:00.000Z'),
    });
    expect(report.adopted).toMatchObject([
      {
        taskId: 'task-verified',
        generation: 2,
        taskBinding: 'LEGACY_DISCOVERY_ONLY',
        candidateSha: current.sha,
        candidateTreeSha: current.tree,
        durableStoreGitDirectory: path.join(host, 'object-store.git'),
        reviewStatus: 'REVIEW_REQUIRED',
      },
    ]);
    expect(report.unresolved).toContain(
      'task-verified@2: legacy task/review authority is untrusted; REVIEW_REQUIRED',
    );
    expect(JSON.stringify(report.adopted)).not.toContain(current.root);
    expect(JSON.stringify(report)).not.toContain('READY_FOR_INTEGRATION');
    expect(JSON.stringify(report)).not.toContain('fabricated-review');

    const adopted = report.adopted[0];
    if (adopted === undefined) throw new Error('candidate was not imported');
    const captureRecord = JSON.parse(await fs.readFile(adopted.captureRecord, 'utf8')) as {
      durableStoreGitDirectory: string;
      reviewStatus: string;
    };
    const manifest = JSON.parse(await fs.readFile(report.quarantineManifest, 'utf8')) as {
      adopted: Array<{
        durableStoreGitDirectory: string;
        reviewStatus: string;
      }>;
    };
    expect(captureRecord).toMatchObject({
      durableStoreGitDirectory: path.join(host, 'object-store.git'),
      reviewStatus: 'REVIEW_REQUIRED',
    });
    expect(manifest.adopted).toMatchObject([
      {
        durableStoreGitDirectory: path.join(host, 'object-store.git'),
        reviewStatus: 'REVIEW_REQUIRED',
      },
    ]);
    expect(JSON.stringify(captureRecord)).not.toContain(current.root);
    expect(JSON.stringify(manifest.adopted)).not.toContain(current.root);
    await fs.rm(current.root, { recursive: true, force: true });
    temporaryDirectories.splice(temporaryDirectories.indexOf(current.root), 1);
    await ensureControllerRuntimeDirectory(host, {
      allowUnsafeTestRuntime: true,
    });
    expect(
      await git(host, [
        '--git-dir',
        adopted.durableStoreGitDirectory,
        'rev-parse',
        adopted.durableCandidateRef,
      ]),
    ).toBe(current.sha);
    expect(
      await git(host, [
        '--git-dir',
        adopted.durableStoreGitDirectory,
        'rev-parse',
        `${adopted.durableCandidateRef}^{tree}`,
      ]),
    ).toBe(current.tree);

    const reviewer = path.join(host, 'reviewer-checkout');
    await execFileAsync('git', [
      'clone',
      '--quiet',
      '--no-checkout',
      adopted.durableStoreGitDirectory,
      reviewer,
    ]);
    await git(reviewer, [
      'fetch',
      '--quiet',
      adopted.durableStoreGitDirectory,
      `${adopted.durableCandidateRef}:${adopted.durableCandidateRef}`,
    ]);
    await git(reviewer, ['checkout', '--quiet', '--detach', current.sha]);
    expect(await git(reviewer, ['rev-parse', 'HEAD^{tree}'])).toBe(current.tree);
    expect(await git(reviewer, ['status', '--porcelain'])).toBe('');
  });

  it('keeps unverifiable candidate identity unresolved and imports nothing', async () => {
    const current = await legacyFixture();
    const host = await fs.mkdtemp(path.join(tmpdir(), 'agent-os-adoption-invalid-'));
    temporaryDirectories.push(host);
    await fs.writeFile(
      path.join(current.root, 'orchestration-state.json'),
      `${JSON.stringify({
        tasks: [
          {
            id: 'ambiguous-task',
            generation: 1,
            capturedCandidate: {
              candidateSha: current.sha,
              treeSha: '0'.repeat(40),
              storeGitDirectory: current.store,
            },
          },
        ],
      })}\n`,
    );
    const report = await adoptLegacyState({
      legacyRoot: current.root,
      hostRoot: host,
      allowUnsafeTestRuntime: true,
    });
    expect(report.adopted).toEqual([]);
    expect(report.unresolved).toEqual([
      'ambiguous-task@1: legacy candidate SHA/tree cannot be verified',
    ]);
  });
});
