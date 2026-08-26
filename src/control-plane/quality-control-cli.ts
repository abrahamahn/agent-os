// src/control-plane/quality-control-cli.ts
import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { candidateContext, resolveWorktree } from '../agent/resource-scheduler';
import {
  buildEvidenceIdentity,
  fingerprintDependencyFiles,
  fingerprintEnvironment,
} from '../validation/validation-evidence';

import {
  QUALITY_FAILURE_CATEGORIES,
  runQualityCheck,
  type FocusedFixOwner,
  type QualityFailureCategory,
} from './quality-control';

function usage(): never {
  process.stderr.write(`Usage:
  pnpm quality-control --worktree PATH --agent WORKER --check CHECK_ID --category STATIC|TEST_BUILD|DB_RUNTIME|INTEGRATION \\
    [--fix-owner A6|A7|A8] [--dependency PATH]... [--environment NAME]... -- <command>
`);
  process.exit(64);
}

function values(args: readonly string[], name: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const next = args[index + 1];
    if (args[index] === name && next !== undefined) result.push(next);
  }
  return result;
}

function value(args: readonly string[], name: string): string | undefined {
  return values(args, name)[0];
}

function isFocusedFixOwner(input: string | undefined): input is FocusedFixOwner {
  return input === 'A6' || input === 'A7' || input === 'A8';
}

function isFailureCategory(input: string | undefined): input is QualityFailureCategory {
  return (
    input !== undefined && QUALITY_FAILURE_CATEGORIES.includes(input as QualityFailureCategory)
  );
}

async function main(): Promise<void> {
  const separator = process.argv.indexOf('--');
  if (separator < 0 || separator === process.argv.length - 1) usage();
  const options = process.argv.slice(2, separator);
  const command = process.argv.slice(separator + 1);
  const runnerId = value(options, '--agent') ?? process.env['AGENT_OS_AGENT_ID'];
  const requestedWorktree = value(options, '--worktree');
  const checkId = value(options, '--check');
  const category = value(options, '--category');
  const fixOwner = value(options, '--fix-owner');
  if (
    runnerId === undefined ||
    requestedWorktree === undefined ||
    checkId === undefined ||
    !isFailureCategory(category) ||
    category === 'ENVIRONMENT' ||
    category === 'TOOLING' ||
    (fixOwner !== undefined && !isFocusedFixOwner(fixOwner))
  ) {
    usage();
  }

  const worktree = resolveWorktree(requestedWorktree);
  const candidate = candidateContext(worktree);
  if (!candidate.clean || candidate.candidateSha === undefined) {
    throw new Error('quality evidence requires a clean exact-SHA worktree');
  }
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' });
  if (head.status !== 0 || head.stdout.trim() !== candidate.candidateSha) {
    throw new Error('unable to attest the exact quality candidate');
  }

  const dependencyInputs = values(options, '--dependency');
  const identity = buildEvidenceIdentity({
    candidateSha: candidate.candidateSha,
    checkId,
    command,
    dependencyFingerprint: fingerprintDependencyFiles(
      worktree,
      dependencyInputs.length === 0 ? undefined : dependencyInputs,
    ),
    environmentFingerprint: fingerprintEnvironment(values(options, '--environment')),
  });
  const result = await runQualityCheck({
    runnerId,
    checkId,
    command,
    worktree,
    identity,
    failureCategory: category,
    ...(fixOwner === undefined ? {} : { focusedFixOwner: fixOwner }),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.outcome === 'FAIL') process.exitCode = 1;
  if (result.outcome === 'BLOCKED') process.exitCode = 75;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
