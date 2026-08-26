#!/usr/bin/env tsx
// src/agent/agent-os-cli.ts
import fs from 'node:fs/promises';
import process from 'node:process';

import { runCycleExecutor } from './cycle-executor';
import { AgentOrchestrator, parseTaskContract } from './orchestrator-o0';

function usage(): never {
  process.stderr.write(`Usage:
  pnpm agent-os init --cycle <cycle> [--integrated-sha <sha>]
  pnpm agent-os register-agent --agent <id> --role <role> [--pid <pid>] [--session <id>] [--environment <file>]
  pnpm agent-os register-task --file <task.json>
  pnpm agent-os ingest [--file <result.json>]
  pnpm agent-os reconcile
  pnpm agent-os next-command --agent <id>
  pnpm agent-os execute-cycle [--max-commands <count>] [--timeout-seconds <seconds>]
  pnpm agent-os status [--json]
  pnpm agent-os review-queue
  pnpm agent-os integration-queue
  pnpm agent-os blockers
  pnpm agent-os run [--interval-ms <milliseconds>] [--heartbeat-ms <milliseconds>]
`);
  process.exit(64);
}

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function integerOption(
  args: readonly string[],
  name: string,
  fallback?: number,
): number | undefined {
  const raw = optionValue(args, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

async function readJsonFile(args: readonly string[], required: boolean): Promise<unknown> {
  const file = optionValue(args, '--file');
  if (file === undefined) {
    if (required) usage();
    return undefined;
  }
  return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const orchestrator = new AgentOrchestrator();

  if (command === 'init') {
    const cycle = optionValue(args, '--cycle');
    if (cycle === undefined) usage();
    const state = await orchestrator.initialize(cycle, optionValue(args, '--integrated-sha'));
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return;
  }

  if (command === 'register-agent') {
    const agent = optionValue(args, '--agent');
    const role = optionValue(args, '--role');
    if (agent === undefined || role === undefined) usage();
    const pid = integerOption(args, '--pid');
    const sessionId = optionValue(args, '--session');
    const environmentFile = optionValue(args, '--environment');
    const environment =
      environmentFile === undefined
        ? undefined
        : (JSON.parse(await fs.readFile(environmentFile, 'utf8')) as unknown);
    const registered = await orchestrator.registerAgent({
      id: agent,
      role,
      ...(pid === undefined ? {} : { pid }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(environment === undefined ? {} : { environment }),
    });
    process.stdout.write(`${JSON.stringify(registered, null, 2)}\n`);
    return;
  }

  if (command === 'register-task') {
    const task = await orchestrator.registerTask(parseTaskContract(await readJsonFile(args, true)));
    const reconciliation = await orchestrator.reconcile();
    process.stdout.write(`${JSON.stringify({ task, reconciliation }, null, 2)}\n`);
    return;
  }

  if (command === 'ingest') {
    const artifact = await readJsonFile(args, false);
    const result =
      artifact === undefined
        ? await orchestrator.ingestInbox()
        : await orchestrator.submitArtifact(artifact);
    const reconciliation = await orchestrator.reconcile();
    process.stdout.write(`${JSON.stringify({ result, reconciliation }, null, 2)}\n`);
    return;
  }

  if (command === 'reconcile') {
    process.stdout.write(`${JSON.stringify(await orchestrator.reconcile(), null, 2)}\n`);
    return;
  }

  if (command === 'next-command') {
    const agent = optionValue(args, '--agent');
    if (agent === undefined) usage();
    const next = await orchestrator.claimNextCommand(agent);
    process.stdout.write(
      next === undefined ? 'NO_COMMAND\n' : `${JSON.stringify(next, null, 2)}\n`,
    );
    return;
  }

  if (command === 'execute-cycle') {
    const maxCommands = integerOption(args, '--max-commands');
    const timeoutSeconds = integerOption(args, '--timeout-seconds', 3600) ?? 3600;
    if (maxCommands !== undefined && maxCommands < 1) {
      throw new Error('--max-commands must be at least 1');
    }
    if (timeoutSeconds < 1) throw new Error('--timeout-seconds must be at least 1');
    const results = await runCycleExecutor({
      orchestrator,
      ...(maxCommands === undefined ? {} : { maxCommands }),
      timeoutMs: timeoutSeconds * 1_000,
      onEvent: (message) => process.stdout.write(`${message}\n`),
    });
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return;
  }

  if (
    command === 'status' ||
    command === 'review-queue' ||
    command === 'integration-queue' ||
    command === 'blockers'
  ) {
    const state = await orchestrator.snapshot();
    if (command === 'status' && !args.includes('--json')) {
      process.stdout.write(`${await orchestrator.founderBrief()}\n`);
      return;
    }
    const output =
      command === 'review-queue'
        ? state.tasks.filter((task) => ['READY_FOR_REVIEW', 'REVIEWING'].includes(task.status))
        : command === 'integration-queue'
          ? state.integrationQueue
          : command === 'blockers'
            ? state.tasks.filter((task) => ['BLOCKED', 'CHANGES_REQUIRED'].includes(task.status))
            : state;
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  if (command === 'run') {
    const intervalMs = integerOption(args, '--interval-ms', 2_000) ?? 2_000;
    const heartbeatMs = integerOption(args, '--heartbeat-ms', 300_000) ?? 300_000;
    if (intervalMs < 100 || heartbeatMs < 100) {
      throw new Error('run intervals must be at least 100 milliseconds');
    }
    const controller = new AbortController();
    const stop = (): void => {
      controller.abort();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await orchestrator.supervise({
        intervalMs,
        heartbeatMs,
        signal: controller.signal,
        onBrief: (brief) => process.stdout.write(`${brief}\n\n`),
      });
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
    return;
  }

  usage();
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`agent-os: ${message}\n`);
  process.exitCode = 1;
});
