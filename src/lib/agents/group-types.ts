/**
 * V2.5 Multi-Agent System — Core Type Definitions
 *
 * Defines all types needed by the runtime and API layer.
 * V2: adds platform envelope protocol + group capabilities.
 * V2.5: adds execution mode routing, source contract, delivery capability.
 */

// ---------------------------------------------------------------------------
// Group Definition
// ---------------------------------------------------------------------------

export type ReviewDecision = 'approved' | 'revise' | 'rejected';
export type ReviewOutcome = 'approved' | 'rejected' | 'revise-exhausted';

// ---------------------------------------------------------------------------
// V2.5: Execution Mode & Source Contract
// ---------------------------------------------------------------------------

export type GroupExecutionMode =
  | 'legacy-single'
  | 'review-loop'
  | 'delivery-single-pass';

export interface GroupSourceContract {
  /** Which upstream group IDs this group accepts as source */
  acceptedSourceGroupIds: string[];
  /** Required review outcome on the source run (default: ['approved']) */
  requireReviewOutcome?: ReviewOutcome[];
  /** Auto-include the source run's own sourceRunIds (transitive upstream) */
  autoIncludeUpstreamSourceRuns?: boolean;
  /** Auto-build inputArtifacts from all resolved source runs' outputArtifacts */
  autoBuildInputArtifactsFromSources?: boolean;
}

export interface GroupRoleDefinition {
  id: string;
  workflow: string;
  timeoutMs: number;
  autoApprove: boolean;
}

export interface GroupCapabilities {
  /** Group accepts TaskEnvelope as structured input */
  acceptsEnvelope?: boolean;
  /** Group emits ArtifactManifest on completion */
  emitsManifest?: boolean;
  /** Group requires inputArtifacts from a source run */
  requiresInputArtifacts?: boolean;
  /** Group is advisory (produces documents, not code) */
  advisory?: boolean;
  /** Group is a delivery team (produces code + delivery packet) */
  delivery?: boolean;
}

export interface GroupDefinition {
  id: string;
  title: string;
  description: string;
  templateId: string;
  executionMode: GroupExecutionMode;
  capabilities?: GroupCapabilities;
  sourceContract?: GroupSourceContract;
  roles: GroupRoleDefinition[];
  reviewPolicyId?: string;
  /** Group recommended default model */
  defaultModel?: string;
}

// ---------------------------------------------------------------------------
// Run Status & Result
// ---------------------------------------------------------------------------

export type RunStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'timeout';

export interface TaskResult {
  status: 'completed' | 'blocked' | 'failed' | 'cancelled' | 'timeout';
  summary: string;
  changedFiles: string[];
  blockers: string[];
  needsReview: string[];
  decision?: string; // Optional reviewer decision (approved, revise, rejected)
}

export interface RoleReadEvidence {
  stepIndex: number;
  stepType: string;
  target: string;
}

export type InputReadAuditStatus = 'not_applicable' | 'verified' | 'partial' | 'missing';

export interface InputArtifactReadAuditEntry {
  artifactId: string;
  title: string;
  kind: string;
  sourceRunId?: string;
  originalPath: string;
  canonicalPath: string;
  canonicalRead: boolean;
  evidence: RoleReadEvidence[];
  alternateReadPaths?: string[];
}

export interface RoleInputReadAudit {
  status: InputReadAuditStatus;
  auditedAt: string;
  taskEnvelopePath?: string;
  taskEnvelopeRead: boolean;
  taskEnvelopeEvidence: RoleReadEvidence[];
  requiredArtifactCount: number;
  canonicalReadCount: number;
  alternateReadCount: number;
  missingCanonicalPaths: string[];
  summary: string;
  entries: InputArtifactReadAuditEntry[];
}

export interface RoleProgress {
  roleId: string;
  round: number;
  childConversationId?: string;
  status: RunStatus;
  startedAt?: string;
  finishedAt?: string;
  reviewDecision?: ReviewDecision;
  result?: TaskResult;
  promptSnapshot?: string;
  promptRecordedAt?: string;
  inputReadAudit?: RoleInputReadAudit;
}

// ---------------------------------------------------------------------------
// Platform Envelope Types (V2)
// ---------------------------------------------------------------------------

export interface ContextRef {
  type: 'run' | 'artifact' | 'file';
  runId?: string;
  artifactId?: string;
  path?: string;
  label?: string;
}

export interface ArtifactRef {
  id: string;
  kind: string;
  title: string;
  path: string;
  format?: 'md' | 'json' | 'txt';
  roleId?: string;
  round?: number;
  sourceRunId?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskEnvelope {
  templateId: string;
  runId?: string;                    // runtime-assigned, caller should not provide
  taskId?: string;                   // V2.5: active for delivery work packages
  goal: string;
  constraints?: string[];
  contextRefs?: ContextRef[];
  inputArtifacts?: ArtifactRef[];
  requestedDeliverables?: string[];  // V2.5: active for delivery groups
  successCriteria?: string[];        // V2.5: active for delivery groups
  governance?: {                     // V2.5: active for delivery groups
    reviewRequired?: boolean;
    maxRounds?: number;
  };
}

export interface ResultEnvelope {
  templateId: string;
  runId: string;
  taskId?: string;
  status: RunStatus;
  decision?: string;
  summary: string;
  outputArtifacts: ArtifactRef[];
  risks?: string[];
  openQuestions?: string[];
  nextAction?: string;
}

export interface ArtifactManifest {
  runId: string;
  templateId: string;
  items: ArtifactRef[];
}

// ---------------------------------------------------------------------------
// V2.5.1: Real-time cascade monitoring (separate from run lifecycle status)
// ---------------------------------------------------------------------------

export interface RunLiveState {
  /** Current cascade status: 'idle' | 'running' | 'streaming' etc. */
  cascadeStatus: string;
  /** Total steps in the active child conversation */
  stepCount: number;
  /** ISO timestamp of the last step count change */
  lastStepAt: string;
  /** Type of the last step (e.g. 'VIEW_FILE', 'PLANNER_RESPONSE') */
  lastStepType?: string;
  /** ISO timestamp when stale was first detected (undefined = healthy) */
  staleSince?: string;
}

// ---------------------------------------------------------------------------
// Agent Run State
// ---------------------------------------------------------------------------

export interface AgentRunState {
  runId: string;
  projectId?: string;
  groupId: string;
  workspace: string;
  hubProjectId?: string;
  parentConversationId?: string;
  childConversationId?: string;
  activeConversationId?: string;
  activeRoleId?: string;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  lastError?: string;
  prompt: string;
  model?: string;
  result?: TaskResult;
  roles?: RoleProgress[];
  currentRound?: number;
  maxRounds?: number;
  artifactDir?: string;
  reviewOutcome?: ReviewOutcome;
  // V2 envelope fields
  templateId?: string;
  taskEnvelope?: TaskEnvelope;
  resultEnvelope?: ResultEnvelope;
  artifactManifestPath?: string;
  sourceRunIds?: string[];
  // V2.5.1: live cascade monitoring
  liveState?: RunLiveState;
  // V3.5: AI Supervisor monitoring
  supervisorReviews?: SupervisorReview[];
  supervisorSummary?: SupervisorSummary;
  supervisorConversationId?: string;
  // V3.5: Pipeline tracking
  pipelineId?: string;
  pipelineStageIndex?: number;
}

// ---------------------------------------------------------------------------
// V3.5: AI Supervisor Loop
// ---------------------------------------------------------------------------

export interface SupervisorDecision {
  status: 'HEALTHY' | 'STUCK' | 'LOOPING' | 'DONE';
  analysis: string;
  suggestedAction?: 'none' | 'nudge' | 'cancel';
}

export interface SupervisorReview {
  id: string;
  timestamp: string;
  round: number;
  stepCount: number;
  decision: SupervisorDecision;
}

export interface SupervisorSummary {
  totalRounds: number;
  healthyCount: number;
  stuckCount: number;
  loopingCount: number;
  doneCount: number;
  consecutiveStuckPeak: number;
  suggestedActions: string[];
  startedAt: string;
  finishedAt: string;
}

// ---------------------------------------------------------------------------
// Terminal statuses (run is done, no more updates expected)
// ---------------------------------------------------------------------------

export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
  'completed',
  'blocked',
  'failed',
  'cancelled',
  'timeout',
]);
