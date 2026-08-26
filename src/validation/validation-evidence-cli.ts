#!/usr/bin/env tsx
// src/validation/validation-evidence-cli.ts
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

import {
  buildEvidenceIdentity,
  fingerprintDependencyFiles,
  fingerprintEnvironment,
  ValidationEvidenceStore,
} from './validation-evidence';

import type { CompletedValidationState, EvidenceIdentity } from './validation-evidence';

const DEFAULT_DEPENDENCIES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'turbo.json',
];

function usage(message?: string): never {
  if (message !== undefined) process.stderr.write(`${message}\n\n`);
  process.stderr.write(`Usage:
  node --import tsx src/validation/validation-evidence-cli.ts request \\
    --owner A2 --check web:test [--sha SHA] [--dependency FILE ...] \\
    [--environment NAME ...] -- <exact command and arguments>
  node --import tsx src/validation/validation-evidence-cli.ts start \\
    --job JOB --owner A2 [--runner-pid PID]
  node --import tsx src/validation/validation-evidence-cli.ts complete \\
    --job JOB --state PASS|FAIL|ENVIRONMENT_BLOCKED|CANCELLED [--summary TEXT]
  node --import tsx src/validation/validation-evidence-cli.ts status [--job JOB]
  node --import tsx src/validation/validation-evidence-cli.ts wait \\
    --job JOB [--timeout-ms 60000]

request is an atomic pre-resource reservation. RUN may acquire an A12 slot; WAIT and REUSE must not.
`);
  process.exit(64);
}

function values(args: readonly string[], name: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) usage(`Missing value for ${name}`);
    result.push(value);
  }
  return result;
}

function value(args: readonly string[], name: string): string | undefined {
  const matches = values(args, name);
  if (matches.length > 1) usage(`${name} may be specified only once`);
  return matches[0];
}

function requiredValue(args: readonly string[], name: string): string {
  return value(args, name) ?? usage(`Missing ${name}`);
}

function integerValue(args: readonly string[], name: string, fallback?: number): number {
  const raw = value(args, name);
  if (raw === undefined && fallback !== undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) usage(`${name} must be a non-negative integer`);
  return parsed;
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

function exactCandidate(root: string, explicitSha?: string): string {
  const head = git(root, ['rev-parse', 'HEAD']).toLowerCase();
  const requested = explicitSha?.toLowerCase() ?? head;
  if (requested !== head) {
    throw new Error(`requested SHA ${requested} is not the checked-out candidate ${head}`);
  }
  if (git(root, ['status', '--porcelain']).length > 0) {
    throw new Error('validation evidence requires a clean worktree for an exact candidate SHA');
  }
  return requested;
}

function requestIdentity(args: readonly string[]): {
  identity: EvidenceIdentity;
  owner: string;
} {
  const separator = args.indexOf('--');
  if (separator === -1) usage('request requires -- before the exact validation command');
  const options = args.slice(0, separator);
  const command = args.slice(separator + 1);
  if (command.length === 0) usage('validation command must not be empty');

  const root = resolve(value(options, '--root') ?? process.cwd());
  const explicitDependencyFingerprint = value(options, '--dependency-fingerprint');
  const dependencyInputs = values(options, '--dependency');
  if (explicitDependencyFingerprint !== undefined && dependencyInputs.length > 0) {
    usage('use --dependency-fingerprint or --dependency, not both');
  }
  const explicitEnvironmentFingerprint = value(options, '--environment-fingerprint');
  const environmentInputs = values(options, '--environment');
  if (explicitEnvironmentFingerprint !== undefined && environmentInputs.length > 0) {
    usage('use --environment-fingerprint or --environment, not both');
  }

  return {
    owner: requiredValue(options, '--owner'),
    identity: buildEvidenceIdentity({
      candidateSha: exactCandidate(root, value(options, '--sha')),
      checkId: requiredValue(options, '--check'),
      command,
      dependencyFingerprint:
        explicitDependencyFingerprint ??
        fingerprintDependencyFiles(
          root,
          dependencyInputs.length > 0 ? dependencyInputs : DEFAULT_DEPENDENCIES,
        ),
      environmentFingerprint:
        explicitEnvironmentFingerprint ?? fingerprintEnvironment(environmentInputs),
    }),
  };
}

function completedState(valueToParse: string): CompletedValidationState {
  if (
    valueToParse === 'PASS' ||
    valueToParse === 'FAIL' ||
    valueToParse === 'ENVIRONMENT_BLOCKED' ||
    valueToParse === 'CANCELLED'
  ) {
    return valueToParse;
  }
  return usage('complete state must be PASS, FAIL, ENVIRONMENT_BLOCKED, or CANCELLED');
}

function print(valueToPrint: unknown): void {
  process.stdout.write(`${JSON.stringify(valueToPrint, null, 2)}\n`);
}

async function main(): Promise<void> {
  const [subcommand, ...args] = process.argv.slice(2);
  const store = new ValidationEvidenceStore();

  if (subcommand === 'request') {
    const request = requestIdentity(args);
    print(await store.request(request.identity, request.owner));
    return;
  }
  if (subcommand === 'start') {
    const owner = requiredValue(args, '--owner');
    const runnerPid = integerValue(args, '--runner-pid', process.pid);
    print(await store.start(requiredValue(args, '--job'), owner, runnerPid));
    return;
  }
  if (subcommand === 'complete') {
    const state = completedState(requiredValue(args, '--state'));
    const summary = value(args, '--summary');
    print(
      await store.complete(
        requiredValue(args, '--job'),
        summary === undefined ? { state } : { state, summary },
      ),
    );
    return;
  }
  if (subcommand === 'status') {
    const jobId = value(args, '--job');
    print(jobId === undefined ? await store.snapshot() : await store.job(jobId));
    return;
  }
  if (subcommand === 'wait') {
    print(
      await store.wait(requiredValue(args, '--job'), integerValue(args, '--timeout-ms', 60_000)),
    );
    return;
  }
  usage();
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
