// src/agent/resource-policy.ts
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { cpus, freemem, loadavg, platform, totalmem } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';

import {
  hasCapability,
  loadCapabilityManifest,
  workerCapabilities,
} from '../control-plane/capability-manifest';

import type {
  AgentId,
  MachinePressure,
  ResourceClass,
  SharedDevProcess,
  SharedDevStatus,
} from './resource-scheduler';

const CONTROL_PLANE_COMMAND_PATTERN =
  /(?:src\/(?:agent|control-plane|process|validation)|agent-(?:os|substrate|resource)|process-guardian|quality-control|validation-evidence|resource-(?:run|status|cleanup)|process-(?:status|cleanup)|git\s+commit)/iu;

export function normalizeCommand(command: readonly string[]): string {
  return JSON.stringify(command);
}

function commandText(command: readonly string[]): string {
  return command.join(' ').toLowerCase();
}

export function isForbiddenAgentCommand(command: readonly string[]): boolean {
  if (command.length === 0) return true;
  const executable = basename(command[0] ?? '').toLowerCase();
  const text = commandText(command);
  const pnpmPersistent =
    /(?:^|\s)(?:pnpm(?:\.cjs)?|npm|yarn|bun)\s+(?:(?:-w|--workspace-root|--filter(?:=\S+|\s+\S+))\s+)*(?:run\s+)?(?:dev(?::[\w-]+)?|serve|start)(?:\s|$)/i.test(
      text,
    );
  const persistent =
    executable === 'vite' ||
    executable === 'uvicorn' ||
    executable === 'gunicorn' ||
    /(?:^|\s)vite(?:\s|$)/i.test(text) ||
    executable === 'nohup' ||
    /(?:^|\s)nohup(?:\s|$)/i.test(text) ||
    /(?:^|\s)tmux[^\n]*(?:\s-ds?(?:\s|$)|new-session\s+-d)/i.test(text) ||
    /(?:^|\s)docker(?:\s+compose)?[^\n]*(?:\s--detach|\s-d)(?:\s|$)/i.test(text) ||
    /(?:^|\s)(?:--watch|--watchall|--persistent)(?:=|\s|$)/i.test(text) ||
    /turbo[^\n]*(?:watch|--watch|--persistent)/i.test(text) ||
    /(?:^|\s)(?:cargo\s+watch|watchexec|air)(?:\s|$)/i.test(text) ||
    /(?:^|\s)(?:cargo|go|dotnet)\s+run(?:\s|$)/i.test(text) ||
    /(?:^|\s)(?:python(?:\d+(?:\.\d+)*)?\s+-m\s+(?:http\.server|uvicorn)|flask\s+run)(?:\s|$)/i.test(
      text,
    ) ||
    /main\/tools\/scripts\/dev\/main\.ts/i.test(text) ||
    command.some((part) => part === '&' || /(?:^|[^&])&$/.test(part));
  return pnpmPersistent || persistent;
}

export function isBroadCommand(command: readonly string[]): boolean {
  const executable = basename(command[0] ?? '').toLowerCase();
  const args = command.slice(1);
  const text = args.join(' ').toLowerCase();
  const hasFilter = args.some((arg) => arg === '--filter' || arg.startsWith('--filter='));

  if (/(?:^|\s)ci:[\w:-]+(?:\s|$)/.test(text)) {
    return true;
  }
  if (executable === 'pnpm' && !hasFilter) {
    const withoutOptions = args.filter(
      (arg) =>
        arg !== 'run' && arg !== '-w' && arg !== '--workspace-root' && !arg.startsWith('--dir'),
    );
    const script = withoutOptions[0] ?? '';
    if (
      [
        'lint',
        'lint:fast',
        'lint:merge-gate',
        'type-check',
        'test',
        'test:coverage',
        'test:full',
        'build',
        'check:changed',
      ].includes(script)
    ) {
      return true;
    }
  }
  if (['npm', 'yarn', 'bun'].includes(executable) && !hasFilter) {
    const script = args.find((arg) => arg !== 'run' && !arg.startsWith('-')) ?? '';
    if (/^(?:lint|type-?check|test|build|check)(?::[\w-]+)?$/u.test(script)) return true;
  }
  if (['pnpm', 'npm', 'yarn', 'bun'].includes(executable)) {
    const execIndex = args.findIndex((arg) => arg === 'exec' || arg === 'x');
    if (execIndex >= 0) {
      const nestedCommand = args.slice(execIndex + 1).filter((arg) => arg !== '--');
      if (nestedCommand.length > 0 && isBroadCommand(nestedCommand)) return true;
    }
  }
  if ((executable === 'turbo' || /(?:^|\s)turbo(?:\s|$)/.test(text)) && !hasFilter) {
    return /(?:^|\s)(?:run\s+)?(?:lint|type-check|test|build)(?:\s|$)/.test(text);
  }
  if (executable === 'cargo') {
    return (
      /^(?:build|check|clippy|doc|test|bench)$/u.test(args[0] ?? '') &&
      !args.some((arg) => ['-p', '--package', '--bin', '--example', '--test'].includes(arg))
    );
  }
  if (executable === 'go' && args[0] === 'test') return args.includes('./...');
  if (executable === 'pytest' || executable === 'py.test') {
    return !args.some((arg) => !arg.startsWith('-'));
  }
  if (['mvn', 'mvnw', 'gradle', 'gradlew', 'dotnet'].includes(executable)) {
    return args.some((arg) => /^(?:build|check|package|test|verify)$/u.test(arg));
  }
  if (['make', 'gmake'].includes(executable)) {
    return args.some((arg) => /^(?:all|build|check|test|verify)$/u.test(arg));
  }
  if (executable === 'tsc') {
    const hasProject = args.some(
      (arg, index) =>
        arg === '--project' ||
        arg === '-p' ||
        arg.startsWith('--project=') ||
        ((args[index - 1] === '--build' || args[index - 1] === '-b') && !arg.startsWith('-')),
    );
    const hasSourceFile = args.some((arg) => /\.[cm]?[jt]sx?$/iu.test(arg));
    return !hasProject && !hasSourceFile;
  }
  if (executable === 'vitest') {
    const targets = args.filter(
      (arg) => !arg.startsWith('-') && !['run', 'watch', 'related'].includes(arg),
    );
    return targets.length === 0;
  }
  if (executable === 'eslint') {
    const targets = args.filter((arg) => !arg.startsWith('-'));
    return targets.length === 0 || targets.includes('.');
  }
  return false;
}

export function requiredResource(command: readonly string[]): ResourceClass | undefined {
  const text = commandText(command);
  if (
    isBroadCommand(command) ||
    isDeployCommand(command) ||
    isReleaseCommand(command) ||
    /(?:playwright|test(?::|-)e2e|real-db|postgres-smoke|docker\s+(?:compose\s+)?build)/i.test(text)
  ) {
    return 'heavy';
  }
  return undefined;
}

export function isDeployCommand(command: readonly string[]): boolean {
  const text = commandText(command);
  return (
    /(?:^|\s)(?:pnpm|npm|yarn)(?:\s+run)?\s+deploy(?::[\w-]+)?(?:\s|$)/u.test(text) ||
    /(?:^|\s)wrangler\s+deploy(?:\s|$)/u.test(text) ||
    /main\/tools\/scripts\/deploy\//u.test(text)
  );
}

export function isReleaseCommand(command: readonly string[]): boolean {
  const text = commandText(command);
  return (
    /(?:^|\s)git\s+push(?:\s|$)/u.test(text) ||
    /(?:^|\s)gh\s+release(?:\s|$)/u.test(text) ||
    /(?:^|\s)(?:npm|pnpm)\s+publish(?:\s|$)/u.test(text)
  );
}

export function rolePolicy(
  agent: AgentId,
  manifest = loadCapabilityManifest(),
): string | undefined {
  const policy = workerCapabilities(manifest, agent);
  if (policy === undefined) return undefined;
  const roles = policy.lifecycleRoles?.join(', ') || 'worker';
  return `${roles}. Capabilities: ${policy.capabilities.join(', ') || 'light only'}.`;
}

export function dispatchPolicy(agent: AgentId, manifest = loadCapabilityManifest()): string {
  const policy = rolePolicy(agent, manifest);
  if (policy === undefined) throw new Error(`Unknown agent: ${agent}`);
  return [
    `RESOURCE POLICY (${manifest.activePhase}; ${agent}): ${policy}`,
    'Persistent development processes are target-owned and must follow the target adapter policy.',
    'Never start, restart, stop, or kill shared servers/watchers without explicit target authorization.',
    'Run MEDIUM/HEAVY commands only through: pnpm agent-resource run --worktree <path> --agent ' +
      `${agent} --resource <medium|heavy> -- <command>.`,
    'Continue LIGHT coding/review work while a validation job is queued.',
  ].join('\n');
}

export function authorizeCommand(
  agent: AgentId,
  resource: ResourceClass,
  command: readonly string[],
  manifest = loadCapabilityManifest(),
): string | undefined {
  const policy = workerCapabilities(manifest, agent);
  if (policy === undefined) return `Unknown worker in ${manifest.activePhase}: ${agent}`;
  if (isForbiddenAgentCommand(command)) {
    return 'Agents may not start persistent dev servers, watchers, or background sessions.';
  }
  const required = requiredResource(command);
  if (required === 'heavy' && resource !== 'heavy') {
    return 'This command is HEAVY and must request the heavy resource class.';
  }
  if (!hasCapability(manifest, agent, `resource:${resource}`)) {
    return `${agent} lacks resource:${resource} in phase ${manifest.activePhase}.`;
  }
  if (isBroadCommand(command) && !hasCapability(manifest, agent, 'validation:broad')) {
    return `${agent} lacks validation:broad in phase ${manifest.activePhase}.`;
  }
  if (isDeployCommand(command) && !policy.lifecycleRoles?.includes('release')) {
    return `${agent} lacks the release role in phase ${manifest.activePhase}.`;
  }
  if (isReleaseCommand(command) && !policy.lifecycleRoles?.includes('release')) {
    return `${agent} lacks the release role in phase ${manifest.activePhase}.`;
  }
  if (
    policy.lifecycleRoles?.includes('control-plane-recovery') === true &&
    !CONTROL_PLANE_COMMAND_PATTERN.test(commandText(command))
  ) {
    return `${agent}'s assignment is limited to control-plane commands in phase ${manifest.activePhase}.`;
  }
  return undefined;
}

export function getMachinePressure(): MachinePressure {
  const cpuCount = Math.max(1, cpus().length);
  const loadRatio = (loadavg()[0] ?? 0) / cpuCount;
  const freeMemoryRatio = totalmem() === 0 ? 0 : freemem() / totalmem();
  let processCount = 0;
  try {
    processCount = readdirSync('/proc').filter((entry) => /^\d+$/.test(entry)).length;
  } catch {
    // Non-Linux platforms do not expose /proc. CPU and memory still protect the slot.
  }

  const maxLoadRatio = Number(process.env['AGENT_OS_MAX_LOAD_RATIO'] ?? '0.9');
  const minFreeMemoryRatio = Number(process.env['AGENT_OS_AGENT_MIN_FREE_MEMORY_RATIO'] ?? '0.15');
  const maxProcesses = Number(process.env['AGENT_OS_MAX_PROCESSES'] ?? '700');
  const reasons: string[] = [];
  if (loadRatio >= maxLoadRatio)
    reasons.push(`CPU load ${loadRatio.toFixed(2)} >= ${String(maxLoadRatio)}`);
  if (freeMemoryRatio <= minFreeMemoryRatio) {
    reasons.push(`free memory ${freeMemoryRatio.toFixed(2)} <= ${String(minFreeMemoryRatio)}`);
  }
  if (processCount >= maxProcesses)
    reasons.push(`processes ${String(processCount)} >= ${String(maxProcesses)}`);
  return {
    high: reasons.length > 0,
    reasons,
    loadRatio,
    freeMemoryRatio,
    processCount,
  };
}

export function inspectSharedDev(
  processes: readonly SharedDevProcess[],
  worktree: string,
  observation: 'host' | 'sandbox' = 'host',
): SharedDevStatus {
  const target = resolve(worktree);
  const matches = processes.filter(
    (candidate) =>
      /(?:(?:pnpm(?:\.cjs)?|npm|yarn|bun)\s+(?:run\s+)?(?:dev|serve|start)(?::[\w-]+)?(?:\s|$)|(?:^|\s)(?:vite|next|astro|webpack|uvicorn|gunicorn|flask|cargo\s+run|go\s+run)(?:\s|$))/iu.test(
        candidate.command,
      ) &&
      (resolve(candidate.cwd) === target || resolve(candidate.cwd).startsWith(`${target}/`)),
  );
  return {
    state: matches.length > 0 ? 'healthy' : observation === 'sandbox' ? 'unobservable' : 'stopped',
    matches,
  };
}

export function scanSharedDev(worktree = process.cwd()): SharedDevStatus {
  if (platform() !== 'linux') return { state: 'stopped', matches: [] };
  const candidates: SharedDevProcess[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync('/proc').filter((entry) => /^\d+$/.test(entry));
  } catch {
    return { state: 'stopped', matches: [] };
  }

  for (const entry of entries) {
    try {
      const command = readFileSync(`/proc/${entry}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
      if (
        !/(?:pnpm|npm|yarn|bun|vite|next|astro|webpack|uvicorn|gunicorn|flask|cargo|go)/i.test(
          command,
        )
      )
        continue;
      candidates.push({
        pid: Number(entry),
        cwd: readlinkSync(`/proc/${entry}/cwd`),
        command,
      });
    } catch {
      // Processes may exit or deny inspection between directory reads.
    }
  }
  return inspectSharedDev(
    candidates,
    worktree,
    process.env['CODEX_SANDBOX_NETWORK_DISABLED'] === undefined ? 'host' : 'sandbox',
  );
}

export function dependencyEnvironmentKey(
  worktree: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  dependencyFiles: readonly string[] = [
    'package.json',
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
    'Cargo.toml',
    'Cargo.lock',
    'go.mod',
    'go.sum',
    'pyproject.toml',
    'uv.lock',
    'poetry.lock',
    'requirements.txt',
    'Gemfile',
    'Gemfile.lock',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
  ],
): string {
  const hash = createHash('sha256');
  hash.update(
    JSON.stringify({
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    }),
  );
  for (const name of dependencyFiles) {
    try {
      hash.update(name);
      hash.update(readFileSync(join(worktree, name)));
    } catch {
      hash.update(`${name}:missing`);
    }
  }
  for (const name of ['CI', 'NODE_ENV']) {
    hash.update(name);
    hash.update(environment[name] ?? '');
  }
  return hash.digest('hex');
}

export function candidateContext(
  worktree: string,
  explicitSha?: string,
): {
  candidateSha: string | undefined;
  reuseEligible: boolean;
  clean: boolean;
} {
  if (explicitSha !== undefined && !/^[0-9a-f]{40,64}$/u.test(explicitSha)) {
    throw new Error('candidate SHA must be a full lowercase hexadecimal Git object ID');
  }
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: worktree,
    encoding: 'utf8',
  });
  const status = spawnSync('git', ['status', '--porcelain'], {
    cwd: worktree,
    encoding: 'utf8',
  });
  const discoveredSha = head.status === 0 ? head.stdout.trim().toLowerCase() : undefined;
  if (explicitSha !== undefined) {
    if (discoveredSha === undefined) {
      throw new Error('candidate SHA cannot be verified because Git HEAD is unavailable');
    }
    if (explicitSha !== discoveredSha) {
      throw new Error(
        `CANDIDATE_SHA_MISMATCH: reported ${explicitSha}, actual worktree HEAD ${discoveredSha}`,
      );
    }
  }
  const candidateSha = explicitSha ?? discoveredSha;
  if (candidateSha !== undefined && !/^[0-9a-f]{40,64}$/u.test(candidateSha)) {
    throw new Error('Git HEAD did not resolve to a full hexadecimal object ID');
  }
  const clean =
    candidateSha !== undefined && status.status === 0 && status.stdout.trim().length === 0;
  return { candidateSha, reuseEligible: clean, clean };
}

export function resolveWorktree(path = process.cwd()): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
