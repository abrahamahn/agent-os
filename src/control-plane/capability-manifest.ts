// src/control-plane/capability-manifest.ts
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXECUTION_CAPABILITIES = [
  'resource:medium',
  'resource:heavy',
  'validation:broad',
] as const;

export const LIFECYCLE_ROLES = [
  'builder',
  'reviewer',
  'manager',
  'integrator',
  'correctness-fixer',
  'release',
  'incident',
  'control-plane-recovery',
  'orchestrator',
] as const;

export const TASK_RISKS = ['LOW', 'MEDIUM', 'HIGH'] as const;

export type ExecutionCapability = (typeof EXECUTION_CAPABILITIES)[number];
export type LifecycleRole = (typeof LIFECYCLE_ROLES)[number];
export type TaskRisk = (typeof TASK_RISKS)[number];

export interface WorkerCapabilities {
  readonly capabilities: readonly ExecutionCapability[];
  readonly priority?: number;
  readonly lifecycleRoles?: readonly LifecycleRole[];
  readonly reviewRisks?: readonly TaskRisk[];
  readonly ownership?: readonly string[];
  readonly hotspots?: readonly string[];
}

export interface CapabilityPhase {
  readonly workers: Readonly<Record<string, WorkerCapabilities>>;
}

export interface CapabilityManifest {
  readonly schemaVersion: 1;
  readonly activePhase: string;
  readonly phases: Readonly<Record<string, CapabilityPhase>>;
}

const DEFAULT_MANIFEST_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../config/capabilities.json',
);

function isCapability(value: unknown): value is ExecutionCapability {
  return typeof value === 'string' && EXECUTION_CAPABILITIES.includes(value as ExecutionCapability);
}

function isLifecycleRole(value: unknown): value is LifecycleRole {
  return typeof value === 'string' && LIFECYCLE_ROLES.includes(value as LifecycleRole);
}

function isTaskRisk(value: unknown): value is TaskRisk {
  return typeof value === 'string' && TASK_RISKS.includes(value as TaskRisk);
}

function validUniqueArray(
  value: unknown,
  predicate: (candidate: unknown) => boolean,
): value is readonly unknown[] {
  return (
    Array.isArray(value) &&
    value.every(predicate) &&
    new Set(value.map((candidate) => String(candidate))).size === value.length
  );
}

function validPaths(value: unknown): value is readonly string[] {
  return validUniqueArray(value, (candidate) => {
    if (typeof candidate !== 'string' || candidate.trim() !== candidate) return false;
    if (candidate === '.') return true;
    return (
      candidate.length > 0 &&
      !candidate.includes('\\') &&
      !candidate.includes('\0') &&
      !candidate.startsWith('/') &&
      !/^[a-z]:/iu.test(candidate) &&
      candidate.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseCapabilityManifest(value: unknown): CapabilityManifest {
  if (!isRecord(value)) throw new Error('capability manifest must be an object');
  const candidate = value;
  if (candidate['schemaVersion'] !== 1) throw new Error('unsupported capability manifest schema');
  const activePhase = candidate['activePhase'];
  if (
    typeof activePhase !== 'string' ||
    activePhase.length === 0 ||
    activePhase.trim() !== activePhase
  ) {
    throw new Error('capability manifest activePhase must not be empty');
  }
  const phases = candidate['phases'];
  if (!isRecord(phases)) {
    throw new Error('capability manifest phases must be an object');
  }
  if (!Object.hasOwn(phases, activePhase)) {
    throw new Error(`capability manifest does not define active phase ${activePhase}`);
  }
  for (const [phaseId, rawPhase] of Object.entries(phases)) {
    if (phaseId.length === 0 || phaseId.trim() !== phaseId || !isRecord(rawPhase)) {
      throw new Error(`invalid capability manifest phase ${phaseId || '(empty)'}`);
    }
    const workers = rawPhase['workers'];
    if (!isRecord(workers)) {
      throw new Error(`capability manifest phase ${phaseId} has no worker map`);
    }
    for (const [worker, rawPolicy] of Object.entries(workers)) {
      if (worker.length === 0 || worker.trim() !== worker || !isRecord(rawPolicy)) {
        throw new Error(`invalid capability policy for worker ${worker || '(empty)'}`);
      }
      const policy = rawPolicy;
      if (!validUniqueArray(policy['capabilities'], isCapability)) {
        throw new Error(`invalid capability policy for worker ${worker}`);
      }
      if (
        policy['priority'] !== undefined &&
        (!Number.isSafeInteger(policy['priority']) || Number(policy['priority']) < 0)
      ) {
        throw new Error(`invalid capability priority for worker ${worker}`);
      }
      if (
        policy['lifecycleRoles'] !== undefined &&
        !validUniqueArray(policy['lifecycleRoles'], isLifecycleRole)
      ) {
        throw new Error(`invalid lifecycle roles for worker ${worker}`);
      }
      if (
        policy['reviewRisks'] !== undefined &&
        !validUniqueArray(policy['reviewRisks'], isTaskRisk)
      ) {
        throw new Error(`invalid review risks for worker ${worker}`);
      }
      if (policy['ownership'] !== undefined && !validPaths(policy['ownership'])) {
        throw new Error(`invalid lifecycle ownership for worker ${worker}`);
      }
      if (policy['hotspots'] !== undefined && !validPaths(policy['hotspots'])) {
        throw new Error(`invalid lifecycle hotspots for worker ${worker}`);
      }
      if (Array.isArray(policy['reviewRisks']) && !Array.isArray(policy['lifecycleRoles'])) {
        throw new Error(`review risks require lifecycle roles for worker ${worker}`);
      }
    }
  }
  return value as unknown as CapabilityManifest;
}

export function loadCapabilityManifest(
  path = process.env['AGENT_OS_CAPABILITIES_PATH'] ?? DEFAULT_MANIFEST_PATH,
): CapabilityManifest {
  return parseCapabilityManifest(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

export function workerCapabilities(
  manifest: CapabilityManifest,
  workerId: string,
): WorkerCapabilities | undefined {
  return manifest.phases[manifest.activePhase]?.workers[workerId];
}

export function hasCapability(
  manifest: CapabilityManifest,
  workerId: string,
  capability: ExecutionCapability,
): boolean {
  return workerCapabilities(manifest, workerId)?.capabilities.includes(capability) === true;
}

export function workerPriority(manifest: CapabilityManifest, workerId: string): number {
  return workerCapabilities(manifest, workerId)?.priority ?? 0;
}
