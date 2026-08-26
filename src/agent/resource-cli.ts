#!/usr/bin/env tsx
// src/agent/resource-cli.ts
import process from 'node:process';

import {
  candidateContext,
  dispatchPolicy,
  RESOURCE_LIMITS,
  ResourceScheduler,
  resolveWorktree,
} from './resource-scheduler';

import type { AgentId, ResourceClass, ResourceJob } from './resource-scheduler';

interface RunOptions {
  agent: AgentId | undefined;
  resource: ResourceClass | undefined;
  sha: string | undefined;
  worktree: string | undefined;
  command: string[];
}

function usage(): never {
  process.stderr.write(`Usage:
  pnpm agent-resource resource-status [--verbose]
  pnpm agent-resource resource-cleanup
  pnpm agent-resource run --worktree PATH --agent WORKER --resource heavy [--sha SHA] -- <command>
  pnpm agent-resource role-policy --agent WORKER
  pnpm agent-resource dispatch-prompt --agent WORKER -- <prompt>
`);
  process.exit(64);
}

function parseAgent(value: string | undefined): AgentId | undefined {
  if (value !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) return value;
  return undefined;
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function parseRun(args: string[]): RunOptions {
  const separator = args.indexOf('--');
  if (separator === -1) usage();
  const options = args.slice(0, separator);
  const resourceValue = optionValue(options, '--resource');
  return {
    agent: parseAgent(optionValue(options, '--agent') ?? process.env['AGENT_OS_AGENT_ID']),
    resource: resourceValue === 'medium' || resourceValue === 'heavy' ? resourceValue : undefined,
    sha: optionValue(options, '--sha'),
    worktree: optionValue(options, '--worktree'),
    command: args.slice(separator + 1),
  };
}

function active(job: ResourceJob): boolean {
  return job.status === 'RUNNING' || job.status === 'QUEUED';
}

async function printResourceStatus(scheduler: ResourceScheduler, verbose: boolean): Promise<void> {
  const state = await scheduler.state();
  const heavy = state.jobs.find((job) => job.resource === 'heavy' && job.status === 'RUNNING');
  const mediumCount = state.jobs.filter(
    (job) => job.resource === 'medium' && job.status === 'RUNNING',
  ).length;
  const queued = state.jobs.filter((job) => job.status === 'QUEUED');
  const orphans = state.jobs.filter((job) => job.orphaned === true).length;

  process.stdout.write(`Resource health:
- Heavy slot: ${heavy === undefined ? 'free' : heavy.agent}
- Medium slots: ${String(mediumCount)}/${String(RESOURCE_LIMITS.medium)}
- Queued jobs: ${String(queued.length)}
- Orphan target processes: ${String(orphans)}
`);

  if (verbose) {
    const visible = state.jobs.filter(active);
    for (const job of visible) {
      process.stdout.write(
        `${job.status} ${job.id} ${job.agent} ${job.resource} owner=${String(job.ownerPid)}` +
          ` child=${String(job.childPid ?? '-')} pgid=${String(job.processGroup ?? '-')}` +
          ` sha=${job.candidateSha ?? '-'} cwd=${job.worktree} command=${job.command.join(' ')}\n`,
      );
    }
  }
}

async function main(): Promise<void> {
  const [subcommand, ...args] = process.argv.slice(2);
  const scheduler = new ResourceScheduler();
  const verbose = args.includes('--verbose');

  if (subcommand === 'resource-status' || subcommand === 'founder-brief') {
    await printResourceStatus(scheduler, verbose);
    return;
  }
  if (subcommand === 'resource-cleanup') {
    const result = await scheduler.cleanup();
    process.stdout.write(
      `Removed ${String(result.staleLeases)} stale lease(s); signalled ${String(result.orphanProcesses)} tracked orphan process group(s).\n`,
    );
    return;
  }
  if (subcommand === 'role-policy') {
    const agent = parseAgent(optionValue(args, '--agent'));
    if (agent === undefined) usage();
    process.stdout.write(`${dispatchPolicy(agent)}\n`);
    return;
  }
  if (subcommand === 'dispatch-prompt') {
    const separator = args.indexOf('--');
    const agent = parseAgent(optionValue(args.slice(0, separator), '--agent'));
    if (separator === -1 || agent === undefined) usage();
    process.stdout.write(`${args.slice(separator + 1).join(' ')}\n\n${dispatchPolicy(agent)}\n`);
    return;
  }
  if (subcommand === 'run') {
    const options = parseRun(args);
    if (
      options.agent === undefined ||
      options.resource === undefined ||
      options.worktree === undefined ||
      options.command.length === 0
    ) {
      usage();
    }
    const worktree = resolveWorktree(options.worktree);
    const candidate = candidateContext(worktree, options.sha);
    const result = await scheduler.run({
      agent: options.agent,
      resource: options.resource,
      command: options.command,
      worktree,
      candidateSha: candidate.candidateSha,
    });
    process.exitCode = result.exitCode;
    return;
  }
  usage();
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`agent-resource: ${message}\n`);
  process.exitCode = 1;
});
