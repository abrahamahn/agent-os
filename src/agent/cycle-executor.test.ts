// src/agent/cycle-executor.test.ts
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { buildEvidenceIdentity, ValidationEvidenceStore } from '../validation/validation-evidence';

import { runCycleExecutor } from './cycle-executor';
import { AgentOrchestrator } from './orchestrator-o0';

import type { TaskContract } from './orchestrator';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', [...args], {
    cwd,
    encoding: 'utf8',
  });
  return result.stdout.trim();
}

async function fakeCodex(root: string): Promise<string> {
  const executable = path.join(root, 'fake-cycle-codex');
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
  if (prompt.includes('RESULT AUTHORITY:') || prompt.includes('artifactToken')) process.exit(97);
  if (prompt.includes('INTEGRATE zero-copy-full')) {
    const store = prompt.match(/Durable object store: (.+)/)?.[1]?.trim();
    const ref = prompt.match(/Durable candidate ref: (.+)/)?.[1]?.trim();
    if (!store || !ref) process.exit(96);
    cp.execFileSync('git', ['fetch', '--quiet', store, ref], { stdio: 'inherit' });
    cp.execFileSync('git', ['cherry-pick', '--quiet', 'FETCH_HEAD'], { stdio: 'inherit' });
    fs.writeFileSync(output, JSON.stringify({ status: 'PASS', blockers: [] }));
    return;
  }
  if (args[args.indexOf('--sandbox') + 1] === 'read-only') {
    fs.writeFileSync(output, JSON.stringify({
      status: 'PASS',
      findings: [],
      evidenceInspected: ['exact candidate materialization']
    }));
    return;
  }
  fs.writeFileSync('candidate.md', 'full zero-copy candidate\\n');
  cp.execFileSync('git', ['add', 'candidate.md'], { stdio: 'inherit' });
  cp.execFileSync('git', ['commit', '--quiet', '-m', 'full zero-copy candidate'], { stdio: 'inherit' });
  fs.writeFileSync(output, JSON.stringify({ status: 'PASS', tests: [], blockers: [] }));
});
`,
    { mode: 0o755 },
  );
  await fs.chmod(executable, 0o755);
  return executable;
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-cycle-executor-test-'));
  temporaryDirectories.push(root);
  const worktree = path.join(root, 'builder');
  const integrationWorktree = path.join(root, 'integration');
  const runtimeDir = path.join(root, 'controller');
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
  await git(integrationWorktree, ['switch', '-c', 'integration/current']);
  await git(worktree, ['switch', '-c', 'agent/full-zero-copy']);

  const orchestrator = new AgentOrchestrator({
    runtimeDir,
    allowUnsafeTestRuntime: true,
  });
  await orchestrator.initialize('CYCLE_TEST', baseSha);
  const task: TaskContract = {
    id: 'zero-copy-full',
    cycle: 'CYCLE_TEST',
    title: 'Prove the full zero-copy accepted change path',
    priority: 1,
    ownerAgent: 'builder-1',
    reviewerAgent: 'reviewer-1',
    worktree,
    branch: 'agent/full-zero-copy',
    baseSha,
    dependencies: [],
    ownedPaths: ['candidate.md'],
    acceptanceCriteria: ['candidate committed', 'independent review', 'integrated', 'validated'],
    integration: {
      agent: 'integrator-1',
      worktree: integrationWorktree,
      branch: 'integration/current',
    },
    validation: {
      agent: 'validator-1',
      checks: [
        {
          checkId: 'focused',
          resource: 'medium',
          command: ['node', '--version'],
        },
      ],
    },
  };
  await orchestrator.registerTask(task);
  return {
    root,
    runtimeDir,
    worktree,
    integrationWorktree,
    baseSha,
    orchestrator,
  };
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('full zero-copy cycle executor', () => {
  it('routes BUILD → REVIEW → INTEGRATE → VALIDATE → ACCEPTED without founder relay', async () => {
    const current = await fixture();
    const executable = await fakeCodex(current.root);

    const results = await runCycleExecutor({
      orchestrator: current.orchestrator,
      executable,
      runtimeDir: current.runtimeDir,
      timeoutMs: 10_000,
      maxCommands: 4,
      validationCheckRunner: async (input) => {
        const store = new ValidationEvidenceStore({
          runtimeDir: path.join(current.runtimeDir, 'validation-evidence'),
        });
        const identity = buildEvidenceIdentity({
          candidateSha: input.candidateSha,
          checkId: input.requirement.checkId,
          command: input.requirement.command,
          dependencyFingerprint: 'fixture-dependency-fingerprint',
          ...(input.requirement.environmentFingerprint === undefined
            ? {}
            : {
                environmentFingerprint: input.requirement.environmentFingerprint,
              }),
        });
        const requested = await store.request(identity, input.command.agent);
        if (requested.action === 'RUN') {
          await store.start(requested.job.id, input.command.agent, process.pid);
          await store.complete(requested.job.id, { state: 'PASS' });
        }
        const evidenceId = requested.job.id;
        return { state: 'PASS' as const, evidenceId };
      },
    });

    expect(results.map((result) => result.kind)).toEqual([
      'BUILD',
      'REVIEW',
      'INTEGRATE',
      'VALIDATE',
    ]);
    expect(results.every((result) => result.status === 'IMPORTED')).toBe(true);
    expect(results.every((result) => result.verification === 'ACCEPTED')).toBe(true);

    const state = await current.orchestrator.snapshot();
    const task = state.tasks.find((candidate) => candidate.id === 'zero-copy-full');
    const integrationHead = await git(current.integrationWorktree, ['rev-parse', 'HEAD']);
    expect(task).toMatchObject({
      status: 'ACCEPTED',
      acceptedSha: integrationHead,
    });
    expect(state.integratedSha).toBe(integrationHead);
    expect(state.integrationQueue).toEqual([
      expect.objectContaining({
        taskId: 'zero-copy-full',
        resultSha: integrationHead,
        status: 'ACCEPTED',
      }),
    ]);
    expect(state.artifacts.map((stored) => stored.artifact.kind)).toEqual([
      'BUILDER_RESULT',
      'REVIEW_RESULT',
      'INTEGRATION_RESULT',
      'VALIDATION_RESULT',
    ]);
    expect(await fs.readFile(path.join(current.integrationWorktree, 'candidate.md'), 'utf8')).toBe(
      'full zero-copy candidate\n',
    );
  });
});
