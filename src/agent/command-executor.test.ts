// src/agent/command-executor.test.ts
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCommandExecutor } from './command-executor';
import { AgentOrchestrator } from './orchestrator-o0';

import type { TaskContract } from './orchestrator';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const ORIGINAL_FIX_LOOP = process.env['AGENT_OS_FAKE_CODEX_FIX_LOOP'];

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', [...args], {
    cwd,
    encoding: 'utf8',
  });
  return result.stdout.trim();
}

async function fakeCodex(root: string): Promise<string> {
  const executable = path.join(root, 'fake-codex');
  await fs.writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex === -1) process.exit(91);
const output = args[outputIndex + 1];
const sandbox = args[args.indexOf('--sandbox') + 1];
const fixLoop = process.env.AGENT_OS_FAKE_CODEX_FIX_LOOP === '1';
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  if (prompt.includes('RESULT AUTHORITY:') || prompt.includes('artifactToken')) process.exit(94);
  if (!prompt.includes('CONTROLLER TASK CONTEXT')) process.exit(95);
  if (!prompt.includes('Acceptance criteria:')) process.exit(96);
  if (!prompt.includes('independent reviewer PASS')) process.exit(97);
  if (!prompt.includes('Owned scope:') || !prompt.includes('- candidate.md')) process.exit(98);
  if (sandbox === 'workspace-write') {
    const correction = fixLoop && prompt.includes('CORRECT');
    const body = correction ? 'zero-copy corrected\\n' : 'zero-copy candidate\\n';
    fs.writeFileSync('candidate.md', body);
    cp.execFileSync('git', ['add', 'candidate.md'], { stdio: 'inherit' });
    cp.execFileSync('git', ['commit', '--quiet', '-m', correction ? 'zero-copy correction' : 'zero-copy candidate'], { stdio: 'inherit' });
    fs.writeFileSync(output, JSON.stringify({ status: 'PASS', tests: [], blockers: [] }));
  } else if (sandbox === 'read-only') {
    const body = fs.readFileSync('candidate.md', 'utf8');
    if (fixLoop && !body.includes('corrected')) {
      fs.writeFileSync(output, JSON.stringify({
        status: 'CHANGES_REQUIRED',
        findings: [{
          severity: 'P1',
          summary: 'candidate needs the requested correction',
          requiredCorrection: 'replace candidate content with corrected content',
          file: 'candidate.md'
        }],
        evidenceInspected: ['candidate diff']
      }));
    } else {
      fs.writeFileSync(output, JSON.stringify({ status: 'PASS', findings: [], evidenceInspected: ['candidate diff'] }));
    }
  } else {
    process.exit(93);
  }
  process.stdout.write(JSON.stringify({ type: 'fake-codex-complete', sandbox }) + '\\n');
});
`,
    { mode: 0o755 },
  );
  await fs.chmod(executable, 0o755);
  return executable;
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-command-executor-test-'));
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
  await git(worktree, ['switch', '-c', 'agent/zero-copy']);

  const orchestrator = new AgentOrchestrator({
    runtimeDir,
    allowUnsafeTestRuntime: true,
  });
  await orchestrator.initialize('CYCLE_TEST', baseSha);
  const task: TaskContract = {
    id: 'zero-copy',
    cycle: 'CYCLE_TEST',
    title: 'Prove builder to reviewer without founder relay',
    priority: 1,
    ownerAgent: 'builder-1',
    reviewerAgent: 'reviewer-1',
    worktree,
    branch: 'agent/zero-copy',
    baseSha,
    dependencies: [],
    ownedPaths: ['candidate.md'],
    acceptanceCriteria: ['candidate committed', 'independent reviewer PASS'],
  };
  await orchestrator.registerTask(task);
  return { root, worktree, runtimeDir, baseSha, orchestrator };
}

afterEach(async () => {
  if (ORIGINAL_FIX_LOOP === undefined) delete process.env['AGENT_OS_FAKE_CODEX_FIX_LOOP'];
  else process.env['AGENT_OS_FAKE_CODEX_FIX_LOOP'] = ORIGINAL_FIX_LOOP;
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('zero-copy command executor', () => {
  it('runs builder then reviewer and imports both terminal results without clipboard relay', async () => {
    const current = await fixture();
    const executable = await fakeCodex(current.root);

    const results = await runCommandExecutor({
      orchestrator: current.orchestrator,
      executable,
      runtimeDir: current.runtimeDir,
      timeoutMs: 10_000,
      maxCommands: 2,
    });

    expect(results).toHaveLength(2);
    expect(results.map((result) => result.kind)).toEqual(['BUILD', 'REVIEW']);
    expect(results.every((result) => result.status === 'IMPORTED')).toBe(true);
    expect(results.every((result) => result.verification === 'ACCEPTED')).toBe(true);

    const state = await current.orchestrator.snapshot();
    const task = state.tasks.find((candidate) => candidate.id === 'zero-copy');
    expect(task).toMatchObject({ status: 'READY_FOR_INTEGRATION' });
    expect(task?.candidateSha).toBe(await git(current.worktree, ['rev-parse', 'HEAD']));
    expect(state.artifacts.map((stored) => stored.artifact.kind)).toEqual([
      'BUILDER_RESULT',
      'REVIEW_RESULT',
    ]);
    expect(
      state.commands.filter(
        (command) => command.kind === 'BUILD' && command.status === 'COMPLETED',
      ),
    ).toHaveLength(1);
    expect(
      state.commands.filter(
        (command) => command.kind === 'REVIEW' && command.status === 'COMPLETED',
      ),
    ).toHaveLength(1);
  });

  it('routes reviewer changes back to the builder and re-reviews a new descendant automatically', async () => {
    process.env['AGENT_OS_FAKE_CODEX_FIX_LOOP'] = '1';
    const current = await fixture();
    const executable = await fakeCodex(current.root);

    const results = await runCommandExecutor({
      orchestrator: current.orchestrator,
      executable,
      runtimeDir: current.runtimeDir,
      timeoutMs: 10_000,
      maxCommands: 4,
    });

    expect(results.map((result) => result.kind)).toEqual([
      'BUILD',
      'REVIEW',
      'CORRECTION',
      'REVIEW',
    ]);
    expect(results.every((result) => result.verification === 'ACCEPTED')).toBe(true);

    const state = await current.orchestrator.snapshot();
    const task = state.tasks.find((candidate) => candidate.id === 'zero-copy');
    expect(task).toMatchObject({
      status: 'READY_FOR_INTEGRATION',
      generation: 1,
    });
    expect(task?.negativeReviewShas).toHaveLength(1);
    expect(await fs.readFile(path.join(current.worktree, 'candidate.md'), 'utf8')).toBe(
      'zero-copy corrected\n',
    );
    expect(
      state.commands.filter(
        (command) => command.kind === 'CORRECTION' && command.status === 'COMPLETED',
      ),
    ).toHaveLength(1);
    expect(
      state.commands.filter(
        (command) => command.kind === 'REVIEW' && command.status === 'COMPLETED',
      ),
    ).toHaveLength(2);
  });

  it('releases a claimed command when the worker executable never starts', async () => {
    const current = await fixture();
    const missingExecutable = path.join(current.root, 'missing-codex');

    await expect(
      runCommandExecutor({
        orchestrator: current.orchestrator,
        executable: missingExecutable,
        runtimeDir: current.runtimeDir,
        timeoutMs: 10_000,
        maxCommands: 1,
      }),
    ).rejects.toThrow(/could not be spawned|failed to start/u);

    const state = await current.orchestrator.snapshot();
    const build = state.commands.find((command) => command.kind === 'BUILD');
    const task = state.tasks.find((candidate) => candidate.id === 'zero-copy');
    const builder = state.agents.find((candidate) => candidate.id === 'builder-1');

    expect(build).toMatchObject({ status: 'PENDING' });
    expect(task).toMatchObject({ status: 'DISPATCHED' });
    expect(builder).toMatchObject({
      lifecycle: 'DISPATCHED',
      currentTask: 'zero-copy',
    });
    expect(builder?.pid).toBeUndefined();
    expect(state.events.some((event) => event.type === 'COMMAND_RETRY_RELEASED')).toBe(true);
  });

  it('releases a spawned but uninstructed command without claiming the process never started', async () => {
    const current = await fixture();
    const executable = await fakeCodex(current.root);
    vi.spyOn(current.orchestrator, 'registerAgent').mockRejectedValueOnce(
      new Error('synthetic controller process registration failure'),
    );

    await expect(
      runCommandExecutor({
        orchestrator: current.orchestrator,
        executable,
        runtimeDir: current.runtimeDir,
        timeoutMs: 10_000,
        maxCommands: 1,
      }),
    ).rejects.toThrow(/process identity could not be registered/u);

    const state = await current.orchestrator.snapshot();
    const build = state.commands.find((command) => command.kind === 'BUILD');
    const task = state.tasks.find((candidate) => candidate.id === 'zero-copy');
    const builder = state.agents.find((candidate) => candidate.id === 'builder-1');
    const retryEvent = state.events
      .slice()
      .reverse()
      .find((event) => event.type === 'COMMAND_RETRY_RELEASED');

    expect(build).toMatchObject({ status: 'PENDING' });
    expect(task).toMatchObject({ status: 'DISPATCHED' });
    expect(builder).toMatchObject({
      lifecycle: 'DISPATCHED',
      currentTask: 'zero-copy',
    });
    expect(builder?.pid).toBeUndefined();
    await expect(fs.access(path.join(current.worktree, 'candidate.md'))).rejects.toThrow();
    expect(retryEvent?.detail).toContain('task execution effects did not begin');
    expect(retryEvent?.detail).not.toContain('never started');
  });
});
