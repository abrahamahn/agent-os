// src/agent/orchestrator-types.ts
import type { CapturedCandidate, WorkerEnvironmentCapabilities } from './worker-workspace';

export const TASK_STATUSES = [
  'READY',
  'DISPATCHED',
  'WORKING',
  'READY_FOR_REVIEW',
  'REVIEWING',
  'REVIEW_RETRYABLE',
  'CHANGES_REQUIRED',
  'BLOCKED',
  'REVIEW_PASS',
  'READY_FOR_INTEGRATION',
  'INTEGRATING',
  'VALIDATING',
  'ACCEPTED',
  'SUPERSEDED',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type AgentLifecycle =
  | 'IDLE'
  | 'DISPATCHED'
  | 'WORKING'
  | 'REVIEWING'
  | 'INTEGRATING'
  | 'VALIDATING'
  | 'BLOCKED'
  | 'OFFLINE';
export type CommandKind = 'BUILD' | 'REVIEW' | 'CORRECTION' | 'INTEGRATE' | 'VALIDATE';
export type CommandStatus = 'PENDING' | 'CLAIMED' | 'COMPLETED' | 'CANCELLED';

export interface ValidationRequirement {
  readonly checkId: string;
  readonly resource: 'medium' | 'heavy';
  readonly command: readonly string[];
  readonly environmentFingerprint?: string;
}

export interface TaskContract {
  readonly id: string;
  readonly cycle: string;
  readonly title: string;
  readonly priority: number;
  readonly ownerAgent: string;
  readonly reviewerAgent: string;
  readonly worktree: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly gitControlDirectory?: string;
  readonly environmentId?: string;
  readonly dependencies: readonly string[];
  readonly ownedPaths: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly supersedes?: string;
  readonly integration?: {
    readonly agent: string;
    readonly worktree: string;
    readonly branch: string;
    readonly gitControlDirectory?: string;
  };
  readonly validation?: {
    readonly agent: string;
    readonly checks: readonly ValidationRequirement[];
  };
}

export interface TaskRecord extends TaskContract {
  status: TaskStatus;
  generation: number;
  candidateSha?: string;
  acceptedSha?: string;
  blocker?: string;
  capturedCandidate?: CapturedCandidate;
  reviewMaterialization?: ReviewMaterialization;
  negativeReviewShas: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ReviewMaterialization {
  readonly id: string;
  readonly taskId: string;
  readonly generation: number;
  readonly candidateSha: string;
  readonly candidateTreeSha: string;
  readonly durableCandidateRef: string;
  readonly durableStoreGitDirectory: string;
  readonly checkout: string;
  readonly gitControlDirectory: string;
  readonly createdAt: string;
}

export interface ReviewExecutionBinding {
  readonly taskId: string;
  readonly generation: number;
  readonly commandId: string;
  readonly reviewerAgent: string;
  readonly reviewerSessionId: string;
  readonly candidateSha: string;
  readonly candidateTreeSha: string;
  readonly durableCandidateRef: string;
  readonly durableStoreGitDirectory: string;
  readonly materializationId: string;
  readonly reviewCheckout: string;
  readonly gitControlDirectory: string;
}

export interface ReviewSessionEnvironment {
  readonly sessionId: string;
  readonly taskId: string;
  readonly generation: number;
  readonly materializationId: string;
  readonly candidateSha: string;
  readonly candidateTreeSha: string;
  readonly durableCandidateRef: string;
  readonly durableStoreGitDirectory: string;
  readonly workspace: string;
  readonly gitControlDirectory: string;
}

export interface AgentRecord {
  id: string;
  role: string;
  lifecycle: AgentLifecycle;
  currentTask?: string;
  pid?: number;
  processStartTicks?: string;
  sessionId?: string;
  environment?: WorkerEnvironmentCapabilities;
  reviewEnvironment?: ReviewSessionEnvironment;
  lastHeartbeatAt?: string;
  updatedAt: string;
}

export interface AgentCommand {
  id: string;
  taskId: string;
  agent: string;
  kind: CommandKind;
  status: CommandStatus;
  generation: number;
  sessionId: string;
  artifactToken: string;
  prompt: string;
  createdAt: string;
  claimedAt?: string;
  completedAt?: string;
  reviewBinding?: ReviewExecutionBinding;
}

export interface ArtifactBinding {
  readonly commandId: string;
  readonly generation: number;
  readonly candidateSha: string;
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly artifactType:
    'BUILDER_RESULT' | 'REVIEW_RESULT' | 'INTEGRATION_RESULT' | 'VALIDATION_RESULT';
  readonly artifactToken: string;
}

export interface TestEvidenceClaim {
  readonly checkId: string;
  readonly status: 'PASS' | 'FAIL' | 'ENVIRONMENT_BLOCKED';
  readonly command: readonly string[];
  readonly evidenceId?: string;
}

export interface BuilderResultArtifact extends ArtifactBinding {
  readonly schemaVersion: 1;
  readonly kind: 'BUILDER_RESULT';
  readonly taskId: string;
  readonly agent: string;
  readonly worktree: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly resultSha: string;
  readonly status: 'PASS' | 'FAILED' | 'BLOCKED';
  readonly filesChanged: readonly string[];
  readonly tests: readonly TestEvidenceClaim[];
  readonly blockers: readonly string[];
}

export interface ReviewFinding {
  readonly severity: 'P0' | 'P1' | 'P2' | 'P3';
  readonly summary: string;
  readonly requiredCorrection: string;
  readonly file?: string;
}

export interface ReviewResultArtifact extends ArtifactBinding {
  readonly schemaVersion: 1;
  readonly kind: 'REVIEW_RESULT';
  readonly taskId: string;
  readonly agent: string;
  readonly reviewedSha: string;
  readonly candidateTreeSha: string;
  readonly durableCandidateRef: string;
  readonly durableStoreGitDirectory: string;
  readonly reviewMaterializationId: string;
  readonly reviewCheckout: string;
  readonly status: 'PASS' | 'CHANGES_REQUIRED' | 'BLOCKED';
  readonly findings: readonly ReviewFinding[];
  readonly evidenceInspected: readonly string[];
}

export interface IntegrationResultArtifact extends ArtifactBinding {
  readonly schemaVersion: 1;
  readonly kind: 'INTEGRATION_RESULT';
  readonly taskId: string;
  readonly agent: string;
  readonly worktree: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly sourceSha: string;
  readonly resultSha: string;
  readonly status: 'PASS' | 'FAILED' | 'BLOCKED';
  readonly filesChanged: readonly string[];
  readonly blockers: readonly string[];
}

export interface ValidationResultArtifact extends ArtifactBinding {
  readonly schemaVersion: 1;
  readonly kind: 'VALIDATION_RESULT';
  readonly taskId: string;
  readonly agent: string;
  readonly resultSha: string;
  readonly status: 'PASS' | 'FAILED' | 'BLOCKED';
  readonly evidenceIds: readonly string[];
  readonly blockers: readonly string[];
}

export type AgentArtifact =
  | BuilderResultArtifact
  | ReviewResultArtifact
  | IntegrationResultArtifact
  | ValidationResultArtifact;

export interface StoredArtifact {
  id: string;
  sequence?: number;
  artifact: AgentArtifact;
  taskGeneration?: number;
  verification: 'ACCEPTED' | 'REJECTED';
  verificationErrors: string[];
  receivedAt: string;
  supersededAt?: string;
  supersededReason?: string;
}

export interface IntegrationEntry {
  taskId: string;
  sourceSha: string;
  candidateSha: string;
  reviewArtifactId: string;
  reviewedSha: string;
  reviewSequence: number;
  reviewGeneration: number;
  reviewer: string;
  reviewVerdict: 'PASS';
  reviewedAt: string;
  reviewSupersessionState: 'CURRENT' | 'SUPERSEDED';
  candidateTreeSha: string;
  durableCandidateRef: string;
  expectedPredecessorSha: string;
  dependencies: string[];
  status: 'QUEUED' | 'INTEGRATING' | 'VALIDATING' | 'ACCEPTED' | 'SUPERSEDED' | 'REMOVED';
  queuedAt: string;
  resultSha?: string;
  failureCode?: 'REVIEW_STATE_CONFLICT' | 'REVIEW_INVALIDATED' | 'INTEGRATION_OUTCOME_UNKNOWN';
}

export interface OrchestrationEvent {
  sequence: number;
  at: string;
  type: string;
  taskId?: string;
  agent?: string;
  detail: string;
}

export interface OrchestrationState {
  version: 1;
  sequence: number;
  cycle: string;
  integratedSha?: string;
  tasks: TaskRecord[];
  agents: AgentRecord[];
  commands: AgentCommand[];
  artifacts: StoredArtifact[];
  integrationQueue: IntegrationEntry[];
  events: OrchestrationEvent[];
  lastBriefSequence: number;
  updatedAt: string;
}

export interface ReconcileResult {
  changed: boolean;
  commandsCreated: AgentCommand[];
  events: OrchestrationEvent[];
}

export interface GitCandidate {
  readonly worktree: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly resultSha: string;
  readonly filesChanged: readonly string[];
  readonly previousSha?: string;
  readonly gitControlDirectory?: string;
}

export interface ReviewTruth {
  eligible: boolean;
  conflict: boolean;
  invalidated?: boolean;
  code?: 'REVIEW_STATE_CONFLICT' | 'REVIEW_INVALIDATED';
  reason: string;
  reviewArtifactId?: string;
  reviewedSha?: string;
  reviewSequence?: number;
  reviewGeneration?: number;
  reviewer?: string;
  verdict?: ReviewResultArtifact['status'];
  reviewedAt?: string;
  supersessionState?: 'CURRENT';
}

export interface EvidenceRecord {
  readonly state: string;
  readonly identity: {
    readonly candidateSha: string;
    readonly checkId: string;
    readonly environmentFingerprint?: string;
  };
}

export interface OrchestratorOptions {
  runtimeDir?: string;
  now?: () => Date;
  idFactory?: () => string;
  lockPollMs?: number;
  evidenceLookup?: (id: string) => Promise<EvidenceRecord | undefined>;
  allowUnsafeTestRuntime?: boolean;
}
