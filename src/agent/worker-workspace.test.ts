// src/agent/worker-workspace.test.ts
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  attachWorkerMetadata,
  buildCodexLaunchPlan,
  candidateFingerprints,
  captureGitCandidate,
  loadFrozenCandidateRegistration,
  provisionWorkerWorkspace,
  registerFrozenCandidate,
  workerGit,
} from './worker-workspace';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function fixture(): Promise<{
  repository: string;
  root: string;
  baseSha: string;
}> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-os-worker-workspace-test-'));
  temporaryDirectories.push(root);
  const repository = path.join(root, 'source');
  await fs.mkdir(repository);
  await execFileAsync('git', ['init', '--quiet'], { cwd: repository });
  await execFileAsync('git', ['config', 'user.name', 'Workspace Fixture'], {
    cwd: repository,
  });
  await execFileAsync('git', ['config', 'user.email', 'fixture@invalid.example'], {
    cwd: repository,
  });
  await fs.writeFile(path.join(repository, 'base.txt'), 'base\n');
  await execFileAsync('git', ['add', 'base.txt'], { cwd: repository });
  await execFileAsync('git', ['commit', '--quiet', '-m', 'base'], {
    cwd: repository,
  });
  const result = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  });
  return { repository, root, baseSha: result.stdout.trim() };
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('Codex worker workspace substrate', () => {
  it('creates a real branch with writable metadata outside the protected .git path', async () => {
    const current = await fixture();
    const workspace = await provisionWorkerWorkspace({
      taskId: 'pilot-1',
      sourceRepository: current.repository,
      workspaceRoot: path.join(current.root, 'workers'),
      baseSha: current.baseSha,
      branch: 'agent/pilot-1',
      now: new Date('2026-08-15T00:00:00.000Z'),
    });

    expect(await fs.lstat(path.join(workspace.workspace, '.git')).catch(() => null)).toBeNull();
    expect((await fs.lstat(workspace.gitControlDirectory)).isDirectory()).toBe(true);
    await fs.writeFile(path.join(workspace.workspace, 'candidate.txt'), 'candidate\n');
    await workerGit(workspace, ['add', 'candidate.txt']);
    await workerGit(workspace, [
      '-c',
      'user.name=Codex Worker',
      '-c',
      'user.email=worker@invalid.example',
      'commit',
      '-m',
      'test: worker commit',
    ]);

    expect(await workerGit(workspace, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('agent/pilot-1');
    expect(await workerGit(workspace, ['status', '--porcelain'])).toBe('');
    expect(await workerGit(workspace, ['rev-parse', 'HEAD'])).not.toBe(current.baseSha);
    expect(workspace.capabilities).toMatchObject({
      gitCommit: 'DIRECT_WITH_EXPORTED_GIT_DIR',
      hostLoopback: 'UNAVAILABLE',
      sharedRuntime: 'VIA_HOST_VALIDATION_RUNNER',
    });
  });

  it('attaches isolated metadata without overwriting existing dirty worker changes', async () => {
    const current = await fixture();
    const existing = path.join(current.root, 'existing-worker');
    await execFileAsync('git', ['clone', '--quiet', current.repository, existing]);
    await fs.writeFile(path.join(existing, 'base.txt'), 'dirty preserved\n');
    await fs.writeFile(path.join(existing, 'new.txt'), 'untracked preserved\n');

    const registryDirectory = path.join(current.root, 'controller-registry');
    await registerFrozenCandidate({
      taskId: 'adopt-a2',
      generation: 0,
      sourceRepository: current.repository,
      worktree: existing,
      baseSha: current.baseSha,
      branch: 'agent/adopt-a2',
      registryDirectory,
    });
    const workspace = await attachWorkerMetadata({
      taskId: 'adopt-a2',
      generation: 0,
      registryDirectory,
      workspaceRoot: path.join(current.root, 'workers'),
    });

    expect(await fs.readFile(path.join(existing, 'base.txt'), 'utf8')).toBe('dirty preserved\n');
    expect(await fs.readFile(path.join(existing, 'new.txt'), 'utf8')).toBe('untracked preserved\n');
    expect(await workerGit(workspace, ['status', '--porcelain'])).toEqual(
      expect.stringContaining('base.txt'),
    );
    expect(await workerGit(workspace, ['status', '--porcelain'])).toEqual(
      expect.stringContaining('new.txt'),
    );
  });

  it('detects frozen drift before creating or mutating worker metadata', async () => {
    const current = await fixture();
    const existing = path.join(current.root, 'frozen-worker');
    await execFileAsync('git', ['clone', '--quiet', current.repository, existing]);
    await fs.writeFile(path.join(existing, 'candidate.txt'), 'registered\n');
    const registryDirectory = path.join(current.root, 'controller-registry');
    await registerFrozenCandidate({
      taskId: 'frozen-a7',
      generation: 0,
      sourceRepository: current.repository,
      worktree: existing,
      baseSha: current.baseSha,
      branch: 'agent/frozen-a7',
      registryDirectory,
    });
    await fs.writeFile(path.join(existing, 'candidate.txt'), 'drifted\n');

    await expect(
      attachWorkerMetadata({
        taskId: 'frozen-a7',
        generation: 0,
        registryDirectory,
        workspaceRoot: path.join(current.root, 'workers'),
      }),
    ).rejects.toThrow(/FROZEN_CANDIDATE_DRIFT/iu);
    await expect(fs.lstat(path.join(current.root, 'workers', 'frozen-a7'))).rejects.toThrow();
  });

  it('loads frozen authority by task ID and rejects caller-created registry drift', async () => {
    const current = await fixture();
    const existing = path.join(current.root, 'authority-worker');
    const registryDirectory = path.join(current.root, 'controller-registry');
    await execFileAsync('git', ['clone', '--quiet', current.repository, existing]);
    await registerFrozenCandidate({
      taskId: 'authority-a3',
      generation: 0,
      sourceRepository: current.repository,
      worktree: existing,
      baseSha: current.baseSha,
      branch: 'agent/authority-a3',
      registryDirectory,
    });
    await expect(
      registerFrozenCandidate({
        taskId: 'authority-a3',
        generation: 1,
        sourceRepository: current.repository,
        worktree: existing,
        baseSha: current.baseSha,
        branch: 'agent/forged',
        registryDirectory,
      }),
    ).resolves.toMatchObject({ taskId: 'authority-a3', generation: 1 });
    await expect(
      loadFrozenCandidateRegistration({
        taskId: 'authority-a3',
        generation: 0,
        registryDirectory,
      }),
    ).resolves.toMatchObject({ branch: 'agent/authority-a3', generation: 0 });
  });

  it('persists frozen task generation and rejects stale attachment after restart', async () => {
    const current = await fixture();
    const existing = path.join(current.root, 'generation-worker');
    const registryDirectory = path.join(current.root, 'controller-registry');
    await execFileAsync('git', ['clone', '--quiet', current.repository, existing]);
    await registerFrozenCandidate({
      taskId: 'generation-task',
      generation: 3,
      sourceRepository: current.repository,
      worktree: existing,
      baseSha: current.baseSha,
      branch: 'agent/generation-task',
      registryDirectory,
    });
    await expect(
      attachWorkerMetadata({
        taskId: 'generation-task',
        generation: 2,
        registryDirectory,
        workspaceRoot: path.join(current.root, 'workers'),
      }),
    ).rejects.toThrow(/FROZEN_CANDIDATE_DRIFT/iu);
    const restarted = await loadFrozenCandidateRegistration({
      taskId: 'generation-task',
      generation: 3,
      registryDirectory,
    });
    expect(restarted.generation).toBe(3);
  });

  it('uses the same canonical content fingerprint for staged and untracked bytes', async () => {
    const current = await fixture();
    const staged = path.join(current.root, 'staged');
    const untracked = path.join(current.root, 'untracked');
    await execFileAsync('git', ['clone', '--quiet', current.repository, staged]);
    await execFileAsync('git', ['clone', '--quiet', current.repository, untracked]);
    await fs.writeFile(path.join(staged, 'candidate.txt'), 'identical\n');
    await fs.writeFile(path.join(untracked, 'candidate.txt'), 'identical\n');
    await execFileAsync('git', ['add', 'candidate.txt'], { cwd: staged });

    const stagedFingerprint = await candidateFingerprints({
      worktree: staged,
      baseSha: current.baseSha,
    });
    const untrackedFingerprint = await candidateFingerprints({
      worktree: untracked,
      baseSha: current.baseSha,
    });
    expect(stagedFingerprint.contentFingerprint).toBe(untrackedFingerprint.contentFingerprint);
    expect(stagedFingerprint.stateFingerprint).not.toBe(untrackedFingerprint.stateFingerprint);
  });

  it('keeps exact commit and tree reachable after worker metadata and workspace removal', async () => {
    const current = await fixture();
    const workers = path.join(current.root, 'workers');
    const workspace = await provisionWorkerWorkspace({
      taskId: 'durable-pilot',
      sourceRepository: current.repository,
      workspaceRoot: workers,
      baseSha: current.baseSha,
      branch: 'agent/durable-pilot',
    });
    await fs.writeFile(path.join(workspace.workspace, 'candidate.txt'), 'durable\n');
    await workerGit(workspace, ['add', 'candidate.txt']);
    await workerGit(workspace, [
      '-c',
      'user.name=Codex Worker',
      '-c',
      'user.email=worker@invalid.example',
      'commit',
      '-m',
      'durable candidate',
    ]);
    const candidateSha = await workerGit(workspace, ['rev-parse', 'HEAD']);
    const storeGitDirectory = path.join(current.root, 'controller', 'objects.git');
    const captured = await captureGitCandidate({
      taskId: 'durable-pilot',
      worktree: workspace.workspace,
      gitControlDirectory: workspace.gitControlDirectory,
      candidateSha,
      storeGitDirectory,
    });
    await fs.rm(workers, { recursive: true, force: true });

    const resolved = await execFileAsync(
      'git',
      ['--git-dir', storeGitDirectory, 'rev-parse', captured.ref],
      { encoding: 'utf8' },
    );
    expect(resolved.stdout.trim()).toBe(candidateSha);
    const reviewer = path.join(current.root, 'reviewer');
    await execFileAsync('git', ['clone', '--quiet', storeGitDirectory, reviewer]);
    await execFileAsync('git', ['checkout', '--quiet', candidateSha], {
      cwd: reviewer,
    });
    expect(await fs.readFile(path.join(reviewer, 'candidate.txt'), 'utf8')).toBe('durable\n');
  });

  it('generates a workspace-write Codex launch with explicit Git and environment capabilities', async () => {
    const current = await fixture();
    const workspace = await provisionWorkerWorkspace({
      taskId: 'pilot-launch',
      sourceRepository: current.repository,
      workspaceRoot: path.join(current.root, 'workers'),
      baseSha: current.baseSha,
      branch: 'agent/pilot-launch',
    });

    const plan = buildCodexLaunchPlan(workspace, 'Implement the registered task.');
    expect(plan.arguments).toContain('--add-dir');
    expect(plan.arguments).toContain('--skip-git-repo-check');
    expect(plan.environment).toEqual({
      GIT_DIR: workspace.gitControlDirectory,
      GIT_WORK_TREE: workspace.workspace,
      AGENT_OS_EXECUTION_ENVIRONMENT_FILE: workspace.environmentFile,
    });
  });
});
