// src/agent/command-executor.scope.test.ts
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { runCommandExecutor } from './command-executor';
import { AgentOrchestrator } from './orchestrator-o0';

import type { TaskContract } from './orchestrator';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync('git', [...args], { cwd, encoding: 'utf8' })).stdout.trim();
}

async function fakeOutOfScopeCodex(root: string): Promise<string> {
  const executable = path.join(root, 'fake-out-of-scope-codex');
  await fs.writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-last-message') + 1];
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync('owned.md', 'owned change\\n');
  fs.writeFileSync('outside.md', 'outside change\\n');
  cp.execFileSync('git', ['add', 'owned.md', 'outside.md'], { stdio: 'inherit' });
  cp.execFileSync('git', ['commit', '--quiet', '-m', 'attempt scope escape'], { stdio: 'inherit' });
  fs.writeFileSync(output, JSON.stringify({ status: 'PASS', tests: [], blockers: [] }));
});
`,
    { mode: 0o755 },
  );
  await fs.chmod(executable, 0o755);
  return executable;
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-owned-scope-test-'));
  temporaryDirectories.push(root);
  const worktree = path.join(root, 'repo');
  const runtimeDir = path.join(root, 'controller');
  await fs.mkdir(worktree);
  await git(worktree, ['init', '--quiet']);
  await git(worktree, ['config', 'user.name', 'Agent OS Fixture']);
  await git(worktree, ['config', 'user.email', 'fixture@invalid.example']);
  await fs.writeFile(path.join(worktree, 'base.md'), 'base\n');
  await git(worktree, ['add', 'base.md']);
  await git(worktree, ['commit', '--quiet', '-m', 'base']);
  const baseSha = await git(worktree, ['rev-parse', 'HEAD']);
  await git(worktree, ['switch', '-c', 'agent/scope']);

  const orchestrator = new AgentOrchestrator({
    runtimeDir,
    allowUnsafeTestRuntime: true,
  });
  await orchestrator.initialize('CYCLE_TEST', baseSha);
  const task: TaskContract = {
    id: 'scope-boundary',
    cycle: 'CYCLE_TEST',
    title: 'Reject out-of-scope builder changes',
    priority: 1,
    ownerAgent: 'builder-1',
    reviewerAgent: 'reviewer-1',
    worktree,
    branch: 'agent/scope',
    baseSha,
    dependencies: [],
    ownedPaths: ['owned.md'],
    acceptanceCriteria: ['only owned.md may change'],
  };
  await orchestrator.registerTask(task);
  return { root, runtimeDir, orchestrator };
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('task owned-path authority', () => {
  it('downgrades an out-of-scope builder PASS before independent review', async () => {
    const current = await fixture();
    const executable = await fakeOutOfScopeCodex(current.root);

    const results = await runCommandExecutor({
      orchestrator: current.orchestrator,
      executable,
      runtimeDir: current.runtimeDir,
      timeoutMs: 10_000,
      maxCommands: 1,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'BUILD',
      verification: 'ACCEPTED',
    });

    const state = await current.orchestrator.snapshot();
    const task = state.tasks.find((candidate) => candidate.id === 'scope-boundary');
    const builderArtifact = state.artifacts.find(
      (stored) => stored.artifact.kind === 'BUILDER_RESULT',
    );

    expect(task).toMatchObject({
      status: 'CHANGES_REQUIRED',
      generation: 1,
    });
    expect(task?.candidateSha).toBeUndefined();
    expect(builderArtifact?.artifact).toMatchObject({
      kind: 'BUILDER_RESULT',
      status: 'FAILED',
      blockers: expect.arrayContaining([
        expect.stringContaining('OWNED_SCOPE_VIOLATION: outside.md'),
      ]),
    });
    expect(state.commands.filter((command) => command.kind === 'REVIEW')).toHaveLength(0);
    expect(state.commands.filter((command) => command.kind === 'CORRECTION')).toHaveLength(1);
  });
});
