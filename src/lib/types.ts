// === API Response Types ===

export interface UserInfo {
  name?: string;
  email?: string;
  hasApiKey: boolean;
}

export interface ModelConfig {
  label: string;
  modelOrAlias?: { model?: string };
  quotaInfo?: { remainingFraction?: number };
  isRecommended?: boolean;
  tagTitle?: string;
}

export interface ModelsResponse {
  clientModelConfigs?: ModelConfig[];
}

export interface Conversation {
  id: string;
  title: string;
  workspace: string;
  projectId?: string;
  projectName?: string;
  mtime: number;
  steps: number;
}

export interface HubProjectFolder {
  uri: string;
  path: string;
  allowWrite: boolean;
  kind: 'git' | 'folder';
}

export interface HubProject {
  id: string;
  name: string;
  folders: HubProjectFolder[];
}

export interface Server {
  pid: number;
  port: number;
  csrf: string;
  ideVersion?: string;
}

export interface Workspace {
  name: string;
  uri: string;
}

export interface WorkspacesResponse {
  workspaces: Workspace[];
  playgrounds: string[];
}

export type AgentRunStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'timeout';

export interface AgentRunResult {
  status: 'completed' | 'blocked' | 'failed' | 'cancelled' | 'timeout';
  summary: string;
  changedFiles: string[];
  blockers: string[];
  needsReview: string[];
}

export type ReviewDecision = 'approved' | 'revise' | 'rejected';
export type ReviewOutcome = 'approved' | 'rejected' | 'revise-exhausted';

export type ProjectStatus = "active" | "completed" | "archived" | "failed" | "cancelled" | "paused";

// ---------------------------------------------------------------------------
// Pipeline State (Frontend projection of backend project-types.ts)
// ---------------------------------------------------------------------------

export type PipelineStageStatusFE =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'skipped';

export interface PipelineStageProgressFE {
  groupId: string;
  stageIndex: number;
  runId?: string;
  status: PipelineStageStatusFE;
  attempts: number;
  lastError?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ProjectPipelineStateFE {
  templateId: string;
  stages: PipelineStageProgressFE[];
  currentStageIndex: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';
}

// ---------------------------------------------------------------------------
// Template Summary (lightweight frontend-only projection)
// ---------------------------------------------------------------------------

export interface TemplateGroupSummary {
  title: string;
  description?: string;
}

export interface TemplateSummaryFE {
  id: string;
  title: string;
  groups: Record<string, TemplateGroupSummary>;
  pipeline: Array<{ groupId: string }>;
}

// ---------------------------------------------------------------------------
// Resume API Types
// ---------------------------------------------------------------------------

export type ResumeAction = 'recover' | 'nudge' | 'restart_role' | 'cancel' | 'skip';

export interface ResumeProjectOptions {
  stageIndex?: number;
  action: ResumeAction;
  prompt?: string;
  roleId?: string;
}

export interface ResumeProjectResponse {
  status: string;
  requestedAction: ResumeAction;
  actualAction: ResumeAction;
  stageIndex: number;
  groupId: string;
  runId: string;
  activeConversationId?: string;
  message?: string;
}

export interface Project {
  projectId: string;
  name: string;
  goal: string;
  templateId?: string;
  workspace?: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  runIds: string[];
  pipelineState?: ProjectPipelineStateFE;
}


export interface RoleProgressFE {
  roleId: string;
  round: number;
  childConversationId?: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  reviewDecision?: ReviewDecision;
  result?: AgentRunResult;
  promptSnapshot?: string;
  promptRecordedAt?: string;
  inputReadAudit?: RoleInputReadAuditFE;
}

export interface AgentRun {
  runId: string;
  projectId?: string;
  groupId: string;
  workspace: string;
  parentConversationId?: string;
  childConversationId?: string;
  status: AgentRunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  lastError?: string;
  prompt: string;
  model?: string;
  result?: AgentRunResult;
  roles?: RoleProgressFE[];
  currentRound?: number;
  maxRounds?: number;
  artifactDir?: string;
  reviewOutcome?: ReviewOutcome;
  supervisorReviews?: Array<{
    id: string;
    round: number;
    stepCount: number;
    decision: { status: 'HEALTHY' | 'STUCK' | 'LOOPING' | 'DONE', analysis: string, suggestedAction?: string };
    timestamp: string;
  }>;
  supervisorSummary?: {
    totalRounds: number;
    healthyCount: number;
    stuckCount: number;
    loopingCount: number;
    doneCount: number;
    consecutiveStuckPeak: number;
    suggestedActions: string[];
  };
  // V2 envelope fields
  templateId?: string;
  taskEnvelope?: TaskEnvelopeFE;
  resultEnvelope?: ResultEnvelopeFE;
  artifactManifestPath?: string;
  sourceRunIds?: string[];
  liveState?: {
    cascadeStatus: string;
    stepCount: number;
    lastStepAt: string;
    lastStepType?: string;
    staleSince?: string;
  };
  activeConversationId?: string;
  activeRoleId?: string;
  supervisorConversationId?: string;
  // V3.5: Pipeline tracking
  pipelineId?: string;
  pipelineStageIndex?: number;
}

// ---------------------------------------------------------------------------
// V2 Envelope types (frontend)
// ---------------------------------------------------------------------------

export interface ContextRefFE {
  type: 'run' | 'artifact' | 'file';
  runId?: string;
  artifactId?: string;
  path?: string;
  label?: string;
}

export interface ArtifactRefFE {
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

export interface TaskEnvelopeFE {
  templateId: string;
  runId?: string;
  taskId?: string;
  goal: string;
  constraints?: string[];
  contextRefs?: ContextRefFE[];
  inputArtifacts?: ArtifactRefFE[];
  requestedDeliverables?: string[];
  successCriteria?: string[];
  governance?: {
    reviewRequired?: boolean;
    maxRounds?: number;
  };
}

export interface ResultEnvelopeFE {
  templateId: string;
  runId: string;
  taskId?: string;
  status: string;
  decision?: string;
  summary: string;
  outputArtifacts: ArtifactRefFE[];
  risks?: string[];
  openQuestions?: string[];
  nextAction?: string;
}

export interface ArtifactManifestFE {
  runId: string;
  templateId: string;
  items: ArtifactRefFE[];
}

export interface RoleReadEvidenceFE {
  stepIndex: number;
  stepType: string;
  target: string;
}

export type InputReadAuditStatusFE = 'not_applicable' | 'verified' | 'partial' | 'missing';

export interface InputArtifactReadAuditEntryFE {
  artifactId: string;
  title: string;
  kind: string;
  sourceRunId?: string;
  originalPath: string;
  canonicalPath: string;
  canonicalRead: boolean;
  evidence: RoleReadEvidenceFE[];
  alternateReadPaths?: string[];
}

export interface RoleInputReadAuditFE {
  status: InputReadAuditStatusFE;
  auditedAt: string;
  taskEnvelopePath?: string;
  taskEnvelopeRead: boolean;
  taskEnvelopeEvidence: RoleReadEvidenceFE[];
  requiredArtifactCount: number;
  canonicalReadCount: number;
  alternateReadCount: number;
  missingCanonicalPaths: string[];
  summary: string;
  entries: InputArtifactReadAuditEntryFE[];
}

export interface Skill {
  name: string;
  description: string;
  path: string;
  baseDir: string;
  scope: 'global' | 'workspace';
}

export interface Workflow {
  name: string;
  description: string;
  path: string;
  workspace?: string;
  content?: string;
  scope?: 'global' | 'workspace';
  baseDir?: string;
}

export interface Rule {
  name: string;
  description: string;
  path: string;
  content?: string;
  scope?: 'global' | 'workspace';
  baseDir?: string;
}

export interface AnalyticsData {
  completionStatistics?: {
    numCompletionsAccepted?: number;
    numCompletionsGenerated?: number;
  };
  completionsByDay?: Array<{
    date?: string;
    numCompletionsAccepted?: number;
  }>;
  completionsByLanguage?: Array<{
    language?: number;
    numCompletionsAccepted?: number;
  }>;
  chatsByModel?: Array<{
    model?: string;
    numChats?: number;
  }>;
}

export interface McpConfig {
  servers?: McpServer[];
}

export interface McpServer {
  name?: string;
  command?: string;
  description?: string;
}

// === Knowledge Item Types ===

export interface KnowledgeItem {
  id: string;
  title: string;
  summary: string;
  references: Array<{ type: string; value: string }>;
  timestamps: { created: string; modified: string; accessed: string };
  artifactFiles: string[];
}

export interface KnowledgeDetail extends KnowledgeItem {
  artifacts: Record<string, string>;
}

// === Step Types (match actual protobuf structure) ===

// Step status lifecycle: PENDING → RUNNING → GENERATING → DONE / CANCELED / ERROR
export type StepStatus =
  | 'CORTEX_STEP_STATUS_PENDING'
  | 'CORTEX_STEP_STATUS_RUNNING'
  | 'CORTEX_STEP_STATUS_GENERATING'
  | 'CORTEX_STEP_STATUS_DONE'
  | 'CORTEX_STEP_STATUS_CANCELED'
  | 'CORTEX_STEP_STATUS_ERROR';

export interface MessageItem {
  text?: string;
  item?: {
    file?: {
      absoluteUri?: string;
      workspaceUrisToRelativePaths?: Record<string, string>;
    };
  };
}

export interface MessageMedia {
  mimeType?: string;
  inlineData?: string;
  uri?: string;
  thumbnail?: string;
}

export interface Step {
  type: string;
  status?: string;
  // Each step has one of these populated based on type
  userInput?: {
    items?: MessageItem[];
    media?: MessageMedia[];
  };
  plannerResponse?: {
    response?: string;
    modifiedResponse?: string;
  };
  taskBoundary?: {
    taskName?: string;
    mode?: string;
    taskStatus?: string;
    taskSummary?: string;
  };
  notifyUser?: {
    notificationContent?: string;
    reviewAbsoluteUris?: string[];
    isBlocking?: boolean;
    // Rich fields from gRPC traffic
    blockedOnUser?: boolean;
    pathsToReview?: string[];
    shouldAutoProceed?: boolean;
  };
  codeAction?: {
    description?: string;
    isArtifactFile?: boolean;
    actionSpec?: {
      createFile?: { absoluteUri?: string };
      editFile?: { absoluteUri?: string };
      deleteFile?: { absoluteUri?: string };
    };
  };
  viewFile?: {
    absoluteUri?: string;
  };
  grepSearch?: {
    query?: string;
    searchPattern?: string;
  };
  runCommand?: {
    command?: string;
    commandLine?: string;
    safeToAutoRun?: boolean;
  };
  commandStatus?: {
    commandId?: string;
    output?: string;
  };
  sendCommandInput?: {
    commandId?: string;
    input?: string;
  };
  searchWeb?: {
    query?: string;
  };
  listDirectory?: {
    path?: string;
  };
  find?: {
    pattern?: string;
    searchDirectory?: string;
  };
  browserSubagent?: {
    taskName?: string;
    task?: string;
  };
  errorMessage?: {
    message?: string;
    errorMessage?: string;
  };
}

export interface StepsData {
  steps: Step[];
  cascadeStatus?: string; // 'running' | 'idle' — from WS
}
