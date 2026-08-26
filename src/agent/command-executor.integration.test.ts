// src/agent/command-executor.integration.test.ts
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
const ORIGINAL_NOOP = process.env['AGENT_OS_FAKE_INTEGRATION_NOOP'];

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync('git', [...args], { cwd, encoding: 'utf8' })).stdout.trim();
}

async function fakeCodex(root: string): Promise<string> {
  const executable = path.join(root, 'fake-integration-codex');
  await fs.writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-last-message') + 1];
const sandbox = args[args.indexOf('--sandbox') + 1];
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  if (prompt.includes('RESULT AUTHORITY:') || prompt.includes('artifactToken')) process.exit(96);
  if (prompt.startsWith('TASK ')) {
    fs.writeFileSync('candidate.md', 'integrated candidate\\n');
    cp.execFileSync('git', ['add', 'candidate.md'], { stdio: 'inherit' });
    cp.execFileSync('git', ['commit', '--quiet', '-m', 'candidate'], { stdio: 'inherit' });
    fs.writeFileSync(output, JSON.stringify({ status: 'PASS', tests: [], blockers: [] }));
    return;
  }
  if (prompt.startsWith('REVIEW ')) {
    fs.writeFileSync(output, JSON.stringify({ status: 'PASS', findings: [], evidenceInspected: ['exact materialization'] }));
    return;
  }
  if (prompt.startsWith('INTEGRATE ')) {
    if (process.env.AGENT_OS_FAKE_INTEGRATION_NOOP !== '1') {
      const store = prompt.match(/Durable object store: (.+)/)?.[1]?.trim();
      const ref = prompt.match(/Durable candidate ref: (.+)/)?.[1]?.trim();
      const source = prompt.match(/Accepted source SHA: ([0-9a-f]+)/)?.[1];
      if (!store || !ref || !source) process.exit(94);
      cp.execFileSync('git', ['fetch', '--quiet', store, ref], { stdio: 'inherit' });
      cp.execFileSync('git', ['cherry-pick', '--quiet', source], { stdio: 'inherit' });
    }
    fs.writeFileSync(output, JSON.stringify({ status: 'PASS', blockers: [] }));
    return;
  }
  process.exit(95);
});
`,
    { mode: 0o755 },
  );
  await fs.chmod(executable, 0o755);
  return executable;
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-integration-executor-test-'));
  temporaryDirectories.push(root);
  const worktree = path.join(root, 'builder');
  const integrationWorktree = path.join(root, 'integrator');
  const runtimeDir = path.join(root, 'controller');
  const integrationBranch = 'integration/current';

  await fs.mkdir(worktree);
  await git(worktree, ['init', '--quiet']);
  await git(worktree, ['config', 'user.name', 'Agent OS Fixture']);
  await git(worktree, ['config', 'user.email', 'fixture@invalid.example']);
  await fs.writeFile(path.join(worktree, 'base.md'), 'base\n');
  await git(worktree, ['add', 'base.md']);
  await git(worktree, ['commit', '--quiet', '-m', 'base']);
  const baseSha = await git(worktree, ['rev-parse', 'HEAD']);

  await git(root, ['clone', '--quiet', worktree, integrationWorktree]);
  await git(integrationWorktree, ['config', 'user.name', 'Integrator Fixture']);
  await git(integrationWorktree, ['config', 'user.email', 'integrator@invalid.example']);
  await git(integrationWorktree, ['switch', '-c', integrationBranch]);
  await git(worktree, ['switch', '-c', 'agent/integration']);

  const orchestrator = new AgentOrchestrator({
    runtimeDir,
    allowUnsafeTestRuntime: true,
  });
  await orchestrator.initialize('CYCLE_TEST', baseSha);
  const task: TaskContract = {
    id: 'zero-copy-integration',
    cycle: 'CYCLE_TEST',
    title: 'Prove zero-copy integration',
    priority: 1,
    ownerAgent: 'builder-1',
    reviewerAgent: 'reviewer-1',
    worktree,
    branch: 'agent/integration',
    baseSha,
    dependencies: [],
    ownedPaths: ['candidate.md'],
    acceptanceCriteria: ['candidate is integrated exactly after independent review'],
    integration: {
      agent: 'integrator-1',
      worktree: integrationWorktree,
      branch: integrationBranch,
    },
  };
  await orchestrator.registerTask(task);
  return {
    root,
    worktree,
    integrationWorktree,
    runtimeDir,
    baseSha,
    orchestrator,
  };
}

afterEach(async () => {
  if (ORIGINAL_NOOP === undefined) delete process.env['AGENT_OS_FAKE_INTEGRATION_NOOP'];
  else process.env['AGENT_OS_FAKE_INTEGRATION_NOOP'] = ORIGINAL_NOOP;
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('zero-copy integration executor', () => {
  it('runs builder, independent reviewer, and exact integration to ACCEPTED without founder relay', async () => {
    const current = await fixture();
    const executable = await fakeCodex(current.root);

    const results = await runCommandExecutor({
      orchestrator: current.orchestrator,
      executable,
      runtimeDir: current.runtimeDir,
      timeoutMs: 10_000,
      maxCommands: 3,
    });

    expect(results.map((result) => result.kind)).toEqual(['BUILD', 'REVIEW', 'INTEGRATE']);
    expect(results.every((result) => result.verification === 'ACCEPTED')).toBe(true);

    const state = await current.orchestrator.snapshot();
    const task = state.tasks.find((candidate) => candidate.id === 'zero-copy-integration');
    const integratedSha = await git(current.integrationWorktree, ['rev-parse', 'HEAD']);
    expect(task).toMatchObject({
      status: 'ACCEPTED',
      acceptedSha: integratedSha,
    });
    expect(state.integratedSha).toBe(integratedSha);
    expect(
      state.integrationQueue.find((entry) => entry.taskId === 'zero-copy-integration'),
    ).toMatchObject({ status: 'ACCEPTED', resultSha: integratedSha });
    expect(await fs.readFile(path.join(current.integrationWorktree, 'candidate.md'), 'utf8')).toBe(
      'integrated candidate\n',
    );
  });

  it('blocks an integrator PASS that does not contain the reviewed candidate delta', async () => {
    process.env['AGENT_OS_FAKE_INTEGRATION_NOOP'] = '1';
    const current = await fixture();
    const executable = await fakeCodex(current.root);

    const results = await runCommandExecutor({
      orchestrator: current.orchestrator,
      executable,
      runtimeDir: current.runtimeDir,
      timeoutMs: 10_000,
      maxCommands: 3,
    });

    expect(results.map((result) => result.kind)).toEqual(['BUILD', 'REVIEW', 'INTEGRATE']);
    const state = await current.orchestrator.snapshot();
    const task = state.tasks.find((candidate) => candidate.id === 'zero-copy-integration');
    expect(task?.status).toBe('BLOCKED');
    expect(task?.blocker).toContain('INTEGRATION_FIDELITY_VIOLATION');
    expect(task?.acceptedSha).toBeUndefined();
    expect(state.integratedSha).toBe(current.baseSha);
    expect(
      state.integrationQueue.find((entry) => entry.taskId === 'zero-copy-integration'),
    ).toMatchObject({ status: 'REMOVED' });
  });
});
