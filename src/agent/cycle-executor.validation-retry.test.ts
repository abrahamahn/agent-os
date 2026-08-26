// src/agent/cycle-executor.validation-retry.test.ts
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
  return (await execFileAsync('git', [...args], { cwd, encoding: 'utf8' })).stdout.trim();
}

async function fakeCodex(root: string): Promise<string> {
  const executable = path.join(root, 'fake-validation-retry-codex');
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
  if (prompt.includes('INTEGRATE validation-retry')) {
    const store = prompt.match(/Durable object store: (.+)/)?.[1]?.trim();
    const ref = prompt.match(/Durable candidate ref: (.+)/)?.[1]?.trim();
    if (!store || !ref) process.exit(96);
    cp.execFileSync('git', ['fetch', '--quiet', store, ref], { stdio: 'inherit' });
    cp.execFileSync('git', ['cherry-pick', '--quiet', 'FETCH_HEAD'], { stdio: 'inherit' });
    fs.writeFileSync(output, JSON.stringify({ status: 'PASS', blockers: [] }));
    return;
  }
  if (args[args.indexOf('--sandbox') + 1] === 'read-only') {
    fs.writeFileSync(output, JSON.stringify({ status: 'PASS', findings: [], evidenceInspected: ['exact materialization'] }));
    return;
  }
  fs.writeFileSync('candidate.md', 'validation retry candidate\\n');
  cp.execFileSync('git', ['add', 'candidate.md'], { stdio: 'inherit' });
  cp.execFileSync('git', ['commit', '--quiet', '-m', 'validation retry candidate'], { stdio: 'inherit' });
  fs.writeFileSync(output, JSON.stringify({ status: 'PASS', tests: [], blockers: [] }));
});
`,
    { mode: 0o755 },
  );
  await fs.chmod(executable, 0o755);
  return executable;
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-validation-retry-test-'));
  temporaryDirectories.push(root);
  const builder = path.join(root, 'builder');
  const integration = path.join(root, 'integration');
  const runtimeDir = path.join(root, 'controller');

  await fs.mkdir(builder);
  await git(builder, ['init', '--quiet']);
  await git(builder, ['config', 'user.name', 'Agent OS Fixture']);
  await git(builder, ['config', 'user.email', 'fixture@invalid.example']);
  await fs.writeFile(path.join(builder, 'base.md'), 'base\n');
  await git(builder, ['add', 'base.md']);
  await git(builder, ['commit', '--quiet', '-m', 'base']);
  const baseSha = await git(builder, ['rev-parse', 'HEAD']);

  await git(root, ['clone', '--quiet', builder, integration]);
  await git(integration, ['config', 'user.name', 'Integrator Fixture']);
  await git(integration, ['config', 'user.email', 'integrator@invalid.example']);
  await git(integration, ['switch', '-c', 'integration/current']);
  await git(builder, ['switch', '-c', 'agent/validation-retry']);

  const orchestrator = new AgentOrchestrator({
    runtimeDir,
    allowUnsafeTestRuntime: true,
  });
  await orchestrator.initialize('CYCLE_TEST', baseSha);
  const task: TaskContract = {
    id: 'validation-retry',
    cycle: 'CYCLE_TEST',
    title: 'Retry validation environment blocks without code correction',
    priority: 1,
    ownerAgent: 'builder-1',
    reviewerAgent: 'reviewer-1',
    worktree: builder,
    branch: 'agent/validation-retry',
    baseSha,
    dependencies: [],
    ownedPaths: ['candidate.md'],
    acceptanceCriteria: ['exact candidate remains staged until validation passes'],
    integration: {
      agent: 'integrator-1',
      worktree: integration,
      branch: 'integration/current',
    },
    validation: {
      agent: 'validator-1',
      checks: [
        {
          checkId: 'db-proof',
          resource: 'medium',
          command: ['node', '--version'],
        },
      ],
    },
  };
  await orchestrator.registerTask(task);
  return { root, builder, integration, runtimeDir, baseSha, orchestrator };
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('validation environment retry', () => {
  it('keeps the same staged SHA and retries validation instead of routing builder correction', async () => {
    const current = await fixture();
    const executable = await fakeCodex(current.root);

    const first = await runCycleExecutor({
      orchestrator: current.orchestrator,
      executable,
      runtimeDir: current.runtimeDir,
      timeoutMs: 10_000,
      maxCommands: 4,
      validationCheckRunner: async () => ({
        state: 'ENVIRONMENT_BLOCKED',
        evidenceId: 'unavailable:db-proof',
        summary: 'postgres temporarily unavailable',
      }),
    });

    expect(first.map((result) => [result.kind, result.status])).toEqual([
      ['BUILD', 'IMPORTED'],
      ['REVIEW', 'IMPORTED'],
      ['INTEGRATE', 'IMPORTED'],
      ['VALIDATE', 'RETRYABLE'],
    ]);

    const staged = await current.orchestrator.snapshot();
    const task = staged.tasks.find((candidate) => candidate.id === 'validation-retry');
    const entry = staged.integrationQueue.find(
      (candidate) => candidate.taskId === 'validation-retry',
    );
    expect(task).toMatchObject({ status: 'VALIDATING', generation: 0 });
    expect(entry).toMatchObject({ status: 'VALIDATING' });
    expect(task?.acceptedSha).toBeUndefined();
    expect(staged.integratedSha).toBe(current.baseSha);
    expect(staged.commands.filter((command) => command.kind === 'CORRECTION')).toHaveLength(0);
    expect(
      staged.commands.filter(
        (command) => command.kind === 'VALIDATE' && command.status === 'PENDING',
      ),
    ).toHaveLength(1);
    expect(staged.artifacts.map((stored) => stored.artifact.kind)).toEqual([
      'BUILDER_RESULT',
      'REVIEW_RESULT',
      'INTEGRATION_RESULT',
    ]);
    expect(staged.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'VALIDATION_RETRY_RELEASED',
          taskId: 'validation-retry',
          detail: expect.stringContaining('postgres temporarily unavailable'),
        }),
      ]),
    );
    expect(
      staged.events.some(
        (event) => event.type === 'COMMAND_RETRY_RELEASED' && event.detail.startsWith('VALIDATE '),
      ),
    ).toBe(false);

    const second = await runCycleExecutor({
      orchestrator: current.orchestrator,
      executable,
      runtimeDir: current.runtimeDir,
      timeoutMs: 10_000,
      maxCommands: 1,
      validationCheckRunner: async (input) => {
        const store = new ValidationEvidenceStore({
          runtimeDir: path.join(current.runtimeDir, 'validation-evidence'),
        });
        const identity = buildEvidenceIdentity({
          candidateSha: input.candidateSha,
          checkId: input.requirement.checkId,
          command: input.requirement.command,
          dependencyFingerprint: 'retry-fixture',
        });
        const requested = await store.request(identity, input.command.agent);
        if (requested.action === 'RUN') {
          await store.start(requested.job.id, input.command.agent, process.pid);
          await store.complete(requested.job.id, { state: 'PASS' });
        }
        return { state: 'PASS' as const, evidenceId: requested.job.id };
      },
    });

    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      kind: 'VALIDATE',
      status: 'IMPORTED',
      verification: 'ACCEPTED',
    });

    const accepted = await current.orchestrator.snapshot();
    const acceptedTask = accepted.tasks.find((candidate) => candidate.id === 'validation-retry');
    const integrationHead = await git(current.integration, ['rev-parse', 'HEAD']);
    expect(acceptedTask).toMatchObject({
      status: 'ACCEPTED',
      generation: 0,
      acceptedSha: integrationHead,
    });
    expect(accepted.integratedSha).toBe(integrationHead);
    expect(accepted.commands.filter((command) => command.kind === 'CORRECTION')).toHaveLength(0);
  });
});
