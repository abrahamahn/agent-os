// src/control-plane/quality-control.ts
import {
  ResourceScheduler,
  type JobRequest,
  type ResourceRunResult,
} from '../agent/resource-scheduler';
import {
  buildInventory,
  discoverWorktrees,
  readProcessSnapshot,
  readSharedDev,
  readTmuxPanes,
} from '../process/guardian';
import {
  ValidationEvidenceStore,
  type EvidenceIdentity,
  type EvidenceJob,
} from '../validation/validation-evidence';

export const QUALITY_FAILURE_CATEGORIES = [
  'STATIC',
  'TEST_BUILD',
  'DB_RUNTIME',
  'INTEGRATION',
  'ENVIRONMENT',
  'TOOLING',
] as const;

export type QualityFailureCategory = (typeof QUALITY_FAILURE_CATEGORIES)[number];
export type FocusedFixOwner = 'A6' | 'A7' | 'A8';

export interface ProcessSafetySnapshot {
  readonly sharedDev: 'ACTIVE_PROTECTED' | 'STALE_PROTECTED' | 'UNREGISTERED';
  readonly targetProcesses: number;
  readonly cleanupEligible: number;
  readonly orphans: number;
  readonly staleTmuxSessions: number;
}

export interface QualityFailure {
  readonly schemaVersion: 1;
  readonly category: QualityFailureCategory;
  readonly checkId: string;
  readonly stage: 'PROCESS_SAFETY' | 'RESOURCE' | 'EXECUTION' | 'EVIDENCE';
  readonly exitCode: number | null;
  readonly orchestrator: 'A16';
  readonly focusedFixOwner: FocusedFixOwner | null;
  readonly retryOwner: 'CAPABILITY_OWNER';
  readonly message: string;
}

export interface QualityCheckRequest {
  readonly runnerId: string;
  readonly checkId: string;
  readonly command: readonly string[];
  readonly worktree: string;
  readonly identity: EvidenceIdentity;
  readonly failureCategory: Exclude<QualityFailureCategory, 'ENVIRONMENT' | 'TOOLING'>;
  readonly focusedFixOwner?: FocusedFixOwner;
}

export type QualityControlResult =
  | {
      readonly outcome: 'REUSE';
      readonly evidenceJob: EvidenceJob;
      readonly sourceJobId: string;
    }
  | {
      readonly outcome: 'WAIT';
      readonly evidenceJob: EvidenceJob;
    }
  | {
      readonly outcome: 'PASS';
      readonly evidenceJob: EvidenceJob;
      readonly resourceJobId: string;
      readonly processSafety: {
        readonly before: ProcessSafetySnapshot;
        readonly after: ProcessSafetySnapshot;
      };
    }
  | {
      readonly outcome: 'FAIL' | 'BLOCKED';
      readonly evidenceJob: EvidenceJob;
      readonly resourceJobId?: string;
      readonly failure: QualityFailure;
      readonly processSafety?: {
        readonly before: ProcessSafetySnapshot;
        readonly after?: ProcessSafetySnapshot;
      };
    };

export interface QualityControlDependencies {
  readonly evidence: ValidationEvidenceStore;
  readonly resources: ResourceScheduler;
  readonly inspectProcesses: (worktree: string) => Promise<ProcessSafetySnapshot>;
}

function failure(
  request: QualityCheckRequest,
  input: {
    category: QualityFailureCategory;
    stage: QualityFailure['stage'];
    exitCode?: number | null;
    message: string;
  },
): QualityFailure {
  const focused = !['ENVIRONMENT', 'TOOLING'].includes(input.category);
  return {
    schemaVersion: 1,
    category: input.category,
    checkId: request.checkId,
    stage: input.stage,
    exitCode: input.exitCode ?? null,
    orchestrator: 'A16',
    focusedFixOwner: focused ? (request.focusedFixOwner ?? null) : null,
    retryOwner: 'CAPABILITY_OWNER',
    message: input.message,
  };
}

function summary(
  value: QualityFailure | { readonly outcome: 'PASS'; readonly exitCode: 0 },
): string {
  return JSON.stringify(value);
}

export async function inspectProcessSafety(worktree: string): Promise<ProcessSafetySnapshot> {
  const registration = await readSharedDev();
  const roots = discoverWorktrees(worktree);
  if (registration !== null) roots.push(registration.worktree);
  const records = await readProcessSnapshot();
  const scriptRoots = process.env['AGENT_OS_SCRIPT_ROOTS']
    ?.split(',')
    .map((root) => root.trim())
    .filter(Boolean);
  const inventory = buildInventory({
    records,
    roots,
    registration,
    tmuxPanes: readTmuxPanes(),
    tmuxSessionPrefix: process.env['AGENT_OS_TMUX_SESSION_PREFIX'] ?? 'agent-os-',
    ...(scriptRoots === undefined ? {} : { scriptRoots }),
    currentPid: process.pid,
  });
  return {
    sharedDev:
      inventory.sharedDev.registration === null
        ? 'UNREGISTERED'
        : inventory.sharedDev.active
          ? 'ACTIVE_PROTECTED'
          : 'STALE_PROTECTED',
    targetProcesses: inventory.processes.length,
    cleanupEligible: inventory.processes.filter((entry) => entry.cleanupEligible).length,
    orphans: inventory.processes.filter((entry) => entry.orphan).length,
    staleTmuxSessions: inventory.tmuxSessions.filter((entry) => entry.stale).length,
  };
}

export function defaultQualityControlDependencies(): QualityControlDependencies {
  return {
    evidence: new ValidationEvidenceStore(),
    resources: new ResourceScheduler(),
    inspectProcesses: inspectProcessSafety,
  };
}

async function cancelEvidence(
  evidence: ValidationEvidenceStore,
  jobId: string,
  qualityFailure: QualityFailure,
): Promise<EvidenceJob> {
  return evidence.cancel(jobId, summary(qualityFailure));
}

export async function runQualityCheck(
  request: QualityCheckRequest,
  dependencies: QualityControlDependencies = defaultQualityControlDependencies(),
): Promise<QualityControlResult> {
  const reservation = await dependencies.evidence.request(request.identity, request.runnerId);
  if (reservation.action === 'REUSE') {
    return {
      outcome: 'REUSE',
      evidenceJob: reservation.job,
      sourceJobId: reservation.sourceJobId,
    };
  }
  if (reservation.action === 'WAIT') {
    return { outcome: 'WAIT', evidenceJob: reservation.job };
  }

  let before: ProcessSafetySnapshot;
  try {
    before = await dependencies.inspectProcesses(request.worktree);
  } catch (error) {
    const qualityFailure = failure(request, {
      category: 'ENVIRONMENT',
      stage: 'PROCESS_SAFETY',
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      outcome: 'BLOCKED',
      evidenceJob: await cancelEvidence(dependencies.evidence, reservation.job.id, qualityFailure),
      failure: qualityFailure,
    };
  }

  const resourceRequest: JobRequest = {
    agent: request.runnerId,
    resource: 'heavy',
    command: [...request.command],
    worktree: request.worktree,
    candidateSha: request.identity.candidateSha,
  };

  let resourceResult: ResourceRunResult;
  try {
    resourceResult = await dependencies.resources.run(resourceRequest, {
      onLeaseAcquired: async () => {
        await dependencies.evidence.start(reservation.job.id, request.runnerId);
      },
    });
  } catch (error) {
    const qualityFailure = failure(request, {
      category: 'TOOLING',
      stage: 'RESOURCE',
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      outcome: 'BLOCKED',
      evidenceJob: await cancelEvidence(dependencies.evidence, reservation.job.id, qualityFailure),
      failure: qualityFailure,
      processSafety: { before },
    };
  }

  if (!resourceResult.commandStarted) {
    const qualityFailure = failure(request, {
      category: 'TOOLING',
      stage: 'RESOURCE',
      exitCode: resourceResult.exitCode,
      message: 'resource lease did not start the validation command',
    });
    const currentEvidence = await dependencies.evidence.job(reservation.job.id);
    const evidenceJob =
      currentEvidence?.state === 'RUNNING'
        ? await dependencies.evidence.complete(reservation.job.id, {
            state: 'FAIL',
            summary: summary(qualityFailure),
          })
        : await cancelEvidence(dependencies.evidence, reservation.job.id, qualityFailure);
    return {
      outcome: 'BLOCKED',
      evidenceJob,
      resourceJobId: resourceResult.job.id,
      failure: qualityFailure,
      processSafety: { before },
    };
  }

  let after: ProcessSafetySnapshot;
  try {
    after = await dependencies.inspectProcesses(request.worktree);
  } catch (error) {
    const qualityFailure = failure(request, {
      category: 'TOOLING',
      stage: 'PROCESS_SAFETY',
      exitCode: resourceResult.exitCode,
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      outcome: 'FAIL',
      evidenceJob: await dependencies.evidence.complete(reservation.job.id, {
        state: 'FAIL',
        summary: summary(qualityFailure),
      }),
      resourceJobId: resourceResult.job.id,
      failure: qualityFailure,
      processSafety: { before },
    };
  }

  if (resourceResult.exitCode === 0) {
    return {
      outcome: 'PASS',
      evidenceJob: await dependencies.evidence.complete(reservation.job.id, {
        state: 'PASS',
        summary: summary({ outcome: 'PASS', exitCode: 0 }),
      }),
      resourceJobId: resourceResult.job.id,
      processSafety: { before, after },
    };
  }

  const qualityFailure = failure(request, {
    category: request.failureCategory,
    stage: 'EXECUTION',
    exitCode: resourceResult.exitCode,
    message: `validation command exited ${String(resourceResult.exitCode)}`,
  });
  return {
    outcome: 'FAIL',
    evidenceJob: await dependencies.evidence.complete(reservation.job.id, {
      state: 'FAIL',
      summary: summary(qualityFailure),
    }),
    resourceJobId: resourceResult.job.id,
    failure: qualityFailure,
    processSafety: { before, after },
  };
}
