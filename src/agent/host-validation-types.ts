// src/agent/host-validation-types.ts
import type { ResourceClass, RunExecutionEvidence, RunRequest } from './resource-scheduler';
import type { ValidationServiceProfile } from './validation-profile';
import type { WorkerEnvironmentCapabilities } from './worker-workspace';

export const HOST_VALIDATION_RESULTS = [
  'QUEUED',
  'RUNNING',
  'PASS',
  'TARGET_TEST_FAILURE',
  'HOST_SERVICE_UNREACHABLE',
  'ENVIRONMENT_BLOCKED',
  'CANCELLED',
  'REUSED',
] as const;

export type HostValidationResult = (typeof HOST_VALIDATION_RESULTS)[number];
export type HostValidationCheckId = string;

export interface HostValidationPolicy {
  resource: ResourceClass;
  command: readonly string[];
  requiredHostService?: string;
}

export interface HostValidationRequest {
  schemaVersion: 1;
  taskId: string;
  generation: number;
  requestedBy: string;
  checkId: HostValidationCheckId;
  candidateSha: string;
  worktree: string;
  gitControlDirectory?: string;
  environment: WorkerEnvironmentCapabilities;
}

export interface HostValidationEnvironmentRegistration {
  schemaVersion: 1;
  taskId: string;
  generation: number;
  requestedBy: string;
  worktree: string;
  gitControlDirectory?: string;
  candidateSha: string;
  treeSha: string;
  allowedChecks: HostValidationCheckId[];
  eligibility: 'READY_FOR_VALIDATION';
  environment: WorkerEnvironmentCapabilities;
  registeredAt: string;
}

export interface HostValidationJob extends HostValidationRequest {
  id: string;
  key: string;
  status: HostValidationResult;
  command: string[];
  resource: ResourceClass;
  environmentFingerprint: string;
  dependencyPreparationKey: string;
  productExecutionKey: string;
  requestedAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  resourceJobId?: string;
  reusedFrom?: string;
  summary?: string;
  leaseExpiresAt?: string;
  leaseToken?: string;
  attempt: number;
}

export interface HostValidationState {
  version: 1;
  jobs: HostValidationJob[];
}

export interface BootstrapToolIdentity {
  executable: string;
  version: string;
}

export interface DependencyPreparationIdentity {
  schemaVersion: 1;
  key: string;
  bootstrapTool: BootstrapToolIdentity;
  command: string[];
  environment: Record<string, string>;
  node: {
    executable: string;
    version: string;
    platform: NodeJS.Platform;
    architecture: string;
  };
  candidateDependencyKey: string;
}

export type ProductExecutionEnvironment = Record<string, string>;

export interface ProductValidationCachePolicy {
  schemaVersion: 1;
  mount: 'tmpfs';
  target: string;
  writable: true;
  disposable: true;
}

export const PRODUCT_VALIDATION_CACHE_POLICY: ProductValidationCachePolicy = {
  schemaVersion: 1,
  mount: 'tmpfs',
  target: '/tmp/agent-os-validation-workspace/node_modules/.cache',
  writable: true,
  disposable: true,
};

export interface ProductTurboScratchPolicy {
  schemaVersion: 1;
  mount: 'tmpfs';
  roots: string[];
  writable: true;
  disposable: true;
}

export interface ProductValidationScratchPolicy {
  schemaVersion: 1;
  mount: 'tmpfs';
  /** Relative to the read-only validation workspace; contents are disposable. */
  mounts: string[];
  writable: true;
  disposable: true;
}

export interface ProductExecutionIdentity {
  schemaVersion: 1;
  key: string;
  environmentFingerprint: string;
  sandboxCachePolicy: ProductValidationCachePolicy;
  turboScratchPolicy: ProductTurboScratchPolicy;
  validationToolScratchPolicy: ProductValidationScratchPolicy;
  dependencyPreparationKey: string;
  candidateSha: string;
  checkId: HostValidationCheckId;
  command: string[];
  node: {
    executable: string;
    version: string;
    platform: NodeJS.Platform;
    architecture: string;
  };
}

export interface HostValidationRunnerOptions {
  runtimeDir?: string;
  now?: () => Date;
  idFactory?: () => string;
  hostEnvironment?: NodeJS.ProcessEnv;
  allowedWorktreeRoots?: readonly string[];
  verifyCandidate?: (request: HostValidationRequest) => Promise<void>;
  probeService?: (service: string) => Promise<boolean>;
  execute?: (input: {
    request: HostValidationRequest;
    policy: HostValidationPolicy;
    dependencyPreparationKey: string;
    productExecutionKey: string;
    productEnvironment: Record<string, string>;
  }) => Promise<{
    exitCode: number;
    resourceJobId?: string;
    infrastructureFailure?: string;
  }>;
  runResourceJob?: (input: RunRequest) => Promise<{
    exitCode: number;
    job: { id: string };
    execution?: RunExecutionEvidence;
  }>;
  bootstrapToolIdentity?: BootstrapToolIdentity;
  bootstrapCommand?: readonly string[];
  bootstrapEnvironment?: Readonly<Record<string, string>>;
  dependencyFiles?: readonly string[];
  scratchPaths?: readonly string[];
  leaseMs?: number;
  allowUnsafeTestRuntime?: boolean;
  resourceAgent?: string;
  policies?: Readonly<Record<string, HostValidationPolicy>>;
  environmentNames?: readonly string[];
  services?: Readonly<Record<string, ValidationServiceProfile>>;
}
