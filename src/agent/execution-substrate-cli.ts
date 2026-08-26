#!/usr/bin/env tsx
// src/agent/execution-substrate-cli.ts
import fs from 'node:fs/promises';
import process from 'node:process';

import { adoptLegacyState } from './controller-runtime';
import { HostValidationRunner } from './host-validation';
import {
  attachWorkerMetadata,
  buildCodexLaunchPlan,
  parseWorkerEnvironment,
  provisionWorkerWorkspace,
  registerFrozenCandidate,
} from './worker-workspace';

import type { WorkerWorkspace } from './worker-workspace';

function usage(): never {
  process.stderr.write(`Usage:
  pnpm agent-substrate provision --task ID --source REPO --base SHA --branch BRANCH [--root DIR] [--prompt TEXT]
  pnpm agent-substrate register-frozen --task ID --generation N --source REPO --base SHA --branch BRANCH --worktree DIR [--registry DIR]
  pnpm agent-substrate attach --task ID --generation N [--registry DIR] [--root DIR]
  pnpm agent-substrate launch-plan --environment FILE --prompt TEXT
  pnpm agent-substrate host-request --file REQUEST.json
  pnpm agent-substrate host-register --file REGISTRATION.json
  pnpm agent-substrate host-status
  pnpm agent-substrate host-run [--once] [--interval-ms 2000]
  pnpm agent-substrate adopt-legacy --legacy DIR [--host-root DIR]
`);
  process.exit(64);
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function requiredOption(args: readonly string[], name: string): string {
  return option(args, name) ?? usage();
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('interval must be positive');
  return parsed;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function environmentWorkspace(file: string): Promise<WorkerWorkspace> {
  const parsed = parseWorkerEnvironment(JSON.parse(await fs.readFile(file, 'utf8')) as unknown);
  return {
    taskId: parsed.environmentId,
    workspace: parsed.workspace,
    gitControlDirectory: parsed.gitControlDirectory,
    branch: parsed.branch,
    baseSha: parsed.baseSha,
    environmentFile: file,
    capabilities: parsed,
  };
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'register-frozen') {
    const registryDirectory = option(args, '--registry');
    print(
      await registerFrozenCandidate({
        taskId: requiredOption(args, '--task'),
        generation: Number(requiredOption(args, '--generation')),
        sourceRepository: requiredOption(args, '--source'),
        baseSha: requiredOption(args, '--base'),
        branch: requiredOption(args, '--branch'),
        worktree: requiredOption(args, '--worktree'),
        ...(registryDirectory === undefined ? {} : { registryDirectory }),
      }),
    );
    return;
  }
  if (command === 'adopt-legacy') {
    const hostRoot = option(args, '--host-root');
    print(
      await adoptLegacyState({
        legacyRoot: requiredOption(args, '--legacy'),
        ...(hostRoot === undefined ? {} : { hostRoot }),
      }),
    );
    return;
  }
  if (command === 'provision') {
    const workspaceRoot = option(args, '--root');
    const shared = {
      taskId: requiredOption(args, '--task'),
      sourceRepository: requiredOption(args, '--source'),
      baseSha: requiredOption(args, '--base'),
      branch: requiredOption(args, '--branch'),
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    };
    const workspace = await provisionWorkerWorkspace(shared);
    const prompt = option(args, '--prompt');
    print({
      workspace,
      ...(prompt === undefined ? {} : { launchPlan: buildCodexLaunchPlan(workspace, prompt) }),
    });
    return;
  }
  if (command === 'attach') {
    const workspaceRoot = option(args, '--root');
    const registryDirectory = option(args, '--registry');
    print(
      await attachWorkerMetadata({
        taskId: requiredOption(args, '--task'),
        generation: Number(requiredOption(args, '--generation')),
        ...(registryDirectory === undefined ? {} : { registryDirectory }),
        ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      }),
    );
    return;
  }
  if (command === 'launch-plan') {
    const workspace = await environmentWorkspace(requiredOption(args, '--environment'));
    print(buildCodexLaunchPlan(workspace, requiredOption(args, '--prompt')));
    return;
  }
  const runner = new HostValidationRunner();
  if (command === 'host-register') {
    const registration = JSON.parse(
      await fs.readFile(requiredOption(args, '--file'), 'utf8'),
    ) as Parameters<HostValidationRunner['registerEnvironment']>[0];
    print(await runner.registerEnvironment(registration));
    return;
  }
  if (command === 'host-request') {
    const request = JSON.parse(
      await fs.readFile(requiredOption(args, '--file'), 'utf8'),
    ) as unknown;
    print(await runner.request(request));
    return;
  }
  if (command === 'host-status') {
    print(await runner.state());
    return;
  }
  if (command === 'host-run') {
    const once = args.includes('--once');
    const intervalMs = positiveInteger(option(args, '--interval-ms'), 2_000);
    if (once) {
      const result = await runner.runNext();
      if (result !== undefined) print(result);
      return;
    }
    process.once('SIGINT', () => {
      process.exitCode = 0;
    });
    process.once('SIGTERM', () => {
      process.exitCode = 0;
    });
    while (process.exitCode === undefined) {
      const result = await runner.runNext();
      if (result !== undefined) print(result);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs));
    }
    return;
  }
  usage();
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
