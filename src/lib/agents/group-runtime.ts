/**
 * V2.5 Multi-Agent System — Group Runtime
 *
 * Core orchestrator: dispatch → child conversation → watch → compact → result.
 * V1.5: multi-role serial execution with review loop.
 * V2: envelope protocol, artifact manifest, advisory handoff.
 * V2.5: execution mode routing, source contract, work package, delivery finalization, scope audit.
 * Directly calls bridge/gRPC layer (no HTTP roundtrip, no adapter abstraction).
 */

import {
  getLanguageServer,
  getApiKey,
  refreshOwnerMap,
  preRegisterOwner,
  getOwnerConnection,
  grpc,
} from '../bridge/gateway';
import { getGroup } from './group-registry';
import { createRun, updateRun, getRun } from './run-registry';
import { watchConversation, type ConversationWatchState } from './watch-conversation';
import type {
  AgentRunState, TaskResult, GroupDefinition, GroupRoleDefinition,
  RoleProgress, ReviewDecision, ReviewOutcome,
  TaskEnvelope, ResultEnvelope, ArtifactManifest, ArtifactRef,
  GroupSourceContract, RunLiveState, SupervisorReview, SupervisorDecision, SupervisorSummary,
  RoleInputReadAudit, RoleReadEvidence, InputArtifactReadAuditEntry,
} from './group-types';
import { TERMINAL_STATUSES } from './group-types';
import type { DevelopmentWorkPackage, DevelopmentDeliveryPacket, WriteScopeAudit } from './development-template-types';
import { ARTIFACT_ROOT_DIR } from './gateway-home';
import { createLogger } from '../logger';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { ReviewEngine } from './review-engine';
import { AssetLoader } from './asset-loader';
import { checkWriteScopeConflicts } from "./scope-governor";
import { getNextStage } from './pipeline-registry';

const log = createLogger('Runtime');

// ---------------------------------------------------------------------------
// Active run tracking (watchers + timers for cleanup on cancel/timeout)
// ---------------------------------------------------------------------------

interface ActiveRun {
  abortWatch: () => void;
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

const activeRuns = new Map<string, ActiveRun>();

function isAuthoritativeConversation(run: AgentRunState | null, conversationId: string): run is AgentRunState {
  return !!run && (!run.activeConversationId || run.activeConversationId === conversationId);
}

async function cancelCascadeBestEffort(
  cascadeId: string | undefined,
  conn: { port: number; csrf: string },
  apiKey: string,
  shortRunId: string,
): Promise<void> {
  if (!cascadeId) return;
  try {
    await grpc.cancelCascade(conn.port, conn.csrf, apiKey, cascadeId);
  } catch (err: any) {
    log.warn({ runId: shortRunId, cascadeId: cascadeId.slice(0, 8), err: err.message }, 'Best-effort cancel for superseded cascade failed');
  }
}

// ---------------------------------------------------------------------------
// DispatchRunInput — V2 unified input type
// ---------------------------------------------------------------------------

export interface DispatchRunInput {
  groupId: string;
  workspace: string;
  prompt?: string;
  model?: string;
  parentConversationId?: string;
  taskEnvelope?: TaskEnvelope;
  sourceRunIds?: string[];
  projectId?: string;
  hubProjectId?: string;
  pipelineId?: string;
  pipelineStageIndex?: number;
}

// ---------------------------------------------------------------------------
// V2.5: Source Contract Resolution
// ---------------------------------------------------------------------------

interface ResolvedSourceContext {
  sourceRuns: AgentRunState[];
  inputArtifacts: ArtifactRef[];
}

function resolveSourceContext(
  group: GroupDefinition,
  input: DispatchRunInput,
  workspacePath: string,
): ResolvedSourceContext {
  const contract = group.sourceContract;
  if (!contract) {
    return { sourceRuns: [], inputArtifacts: input.taskEnvelope?.inputArtifacts || [] };
  }

  if (!input.sourceRunIds || input.sourceRunIds.length === 0) {
    throw new Error(`Group ${group.id} requires sourceRunIds per its source contract`);
  }

  const requiredOutcomes = contract.requireReviewOutcome || ['approved'];
  const resolvedRuns: AgentRunState[] = [];
  const upstreamRunIds = new Set<string>();

  // Validate direct source runs against contract
  for (const srcRunId of input.sourceRunIds) {
    const srcRun = getRun(srcRunId);
    if (!srcRun) throw new Error(`Source run ${srcRunId} not found`);

    if (!contract.acceptedSourceGroupIds.includes(srcRun.groupId)) {
      throw new Error(`Source run ${srcRunId} has groupId '${srcRun.groupId}', but group '${group.id}' only accepts: ${contract.acceptedSourceGroupIds.join(', ')}`);
    }

    if (!srcRun.reviewOutcome || !requiredOutcomes.includes(srcRun.reviewOutcome)) {
      throw new Error(`Source run ${srcRunId} reviewOutcome is '${srcRun.reviewOutcome || 'none'}', required: ${requiredOutcomes.join(', ')}`);
    }

    const srcWs = srcRun.workspace.replace(/^file:\/\//, '');
    if (srcWs !== workspacePath) {
      throw new Error(`Source run ${srcRunId} belongs to workspace ${srcWs}, but target is ${workspacePath}`);
    }

    resolvedRuns.push(srcRun);

    // Collect upstream transitive sourceRunIds
    if (contract.autoIncludeUpstreamSourceRuns && srcRun.sourceRunIds) {
      for (const upId of srcRun.sourceRunIds) upstreamRunIds.add(upId);
    }
  }

  // Add transitive upstream runs (e.g., product-spec via architecture-advisory)
  for (const upId of upstreamRunIds) {
    if (input.sourceRunIds.includes(upId)) continue; // already direct
    const upRun = getRun(upId);
    if (upRun) resolvedRuns.push(upRun);
  }

  // Auto-build inputArtifacts from all resolved source runs
  let inputArtifacts = input.taskEnvelope?.inputArtifacts || [];
  if (contract.autoBuildInputArtifactsFromSources && inputArtifacts.length === 0) {
    const built: ArtifactRef[] = [];
    for (const run of resolvedRuns) {
      if (run.resultEnvelope?.outputArtifacts) {
        built.push(...run.resultEnvelope.outputArtifacts);
      }
    }
    inputArtifacts = built;
  }

  // For non-autoBuild contracts, validate caller-provided inputArtifacts
  if (!contract.autoBuildInputArtifactsFromSources) {
    if (inputArtifacts.length === 0) {
      throw new Error(`Group ${group.id} requires inputArtifacts — source contract does not auto-build`);
    }
    const sourceRunIdSet = new Set(input.sourceRunIds);
    for (const art of inputArtifacts) {
      if (!art.sourceRunId) {
        throw new Error(`Input artifact "${art.path}" has no sourceRunId — provenance required`);
      }
      if (!sourceRunIdSet.has(art.sourceRunId)) {
        throw new Error(`Input artifact "${art.path}" references source run ${art.sourceRunId} which is not in sourceRunIds`);
      }
      const srcRun = getRun(art.sourceRunId);
      if (srcRun?.artifactDir) {
        const artAbsPath = path.join(workspacePath, srcRun.artifactDir, art.path);
        if (!fs.existsSync(artAbsPath)) {
          throw new Error(`Input artifact "${art.path}" does not exist at ${artAbsPath}`);
        }
      }
    }
  }

  return { sourceRuns: resolvedRuns, inputArtifacts };
}

// ---------------------------------------------------------------------------
// V2.5: Work Package Builder
// ---------------------------------------------------------------------------

function buildDevelopmentWorkPackage(
  runId: string,
  goal: string,
  sourceArchitectureRun: AgentRunState,
  sourceProductRuns: AgentRunState[],
  inputArtifacts: ArtifactRef[],
  workspacePath: string,
  artifactAbsDir: string,
): DevelopmentWorkPackage {
  const taskId = `wp_${runId.slice(0, 8)}`;

  // Try to read write-scope-plan.json from architecture source
  let allowedWriteScope: DevelopmentWorkPackage['allowedWriteScope'] = [];
  if (sourceArchitectureRun.artifactDir) {
    const scopePath = path.join(workspacePath, sourceArchitectureRun.artifactDir, 'architecture', 'write-scope-plan.json');
    try {
      if (fs.existsSync(scopePath)) {
        const raw = JSON.parse(fs.readFileSync(scopePath, 'utf-8'));
        if (Array.isArray(raw)) {
          allowedWriteScope = raw.map((entry: any) => ({
            path: String(entry.path || entry.file || ''),
            operation: (['create', 'modify', 'delete'].includes(entry.operation) ? entry.operation : 'modify') as 'create' | 'modify' | 'delete',
          })).filter((e: any) => e.path);
        } else if (raw.files || raw.scope) {
          const arr = raw.files || raw.scope || [];
          allowedWriteScope = (Array.isArray(arr) ? arr : []).map((entry: any) => ({
            path: String(typeof entry === 'string' ? entry : entry.path || entry.file || ''),
            operation: 'modify' as const,
          })).filter((e: any) => e.path);
        }
      }
    } catch {
      log.warn({ runId: runId.slice(0, 8) }, 'Failed to parse write-scope-plan.json, defaulting to empty scope');
    }
  }

  const workPackage: DevelopmentWorkPackage = {
    templateId: 'development-template-1',
    taskId,
    goal,
    sourceArchitectureRunId: sourceArchitectureRun.runId,
    sourceProductRunIds: sourceProductRuns.map(r => r.runId),
    requestedDeliverables: [
      'delivery/implementation-summary.md',
      'delivery/test-results.md',
      'delivery/delivery-packet.json',
    ],
    successCriteria: [
      'All requested changes implemented',
      'Type checking passes (npx tsc --noEmit)',
      'delivery-packet.json written with status and summary',
    ],
    referencedArtifacts: inputArtifacts,
    allowedWriteScope,
  };

  // Write work-package.json
  const wpDir = path.join(artifactAbsDir, 'work-package');
  if (!fs.existsSync(wpDir)) fs.mkdirSync(wpDir, { recursive: true });
  fs.writeFileSync(path.join(wpDir, 'work-package.json'), JSON.stringify(workPackage, null, 2), 'utf-8');
  log.info({ runId: runId.slice(0, 8), taskId }, 'Work package written');

  return workPackage;
}

// ---------------------------------------------------------------------------
// dispatchRun
// ---------------------------------------------------------------------------

export async function dispatchRun(input: DispatchRunInput): Promise<{ runId: string }> {
  // 1. Validate group
  const group = getGroup(input.groupId);
  if (!group) {
    throw new Error(`Unknown group: ${input.groupId}`);
  }

  // 2. Validate input: must have either prompt or taskEnvelope
  const goal = input.taskEnvelope?.goal || input.prompt;
  if (!goal) {
    throw new Error('Either prompt or taskEnvelope.goal is required');
  }

  // 3. V2.5: Source contract validation (replaces hardcoded product-spec check)
  const workspacePath = (input.workspace || '').replace(/^file:\/\//, '');
  let resolvedSource: ResolvedSourceContext = { sourceRuns: [], inputArtifacts: [] };

  if (group.sourceContract) {
    resolvedSource = resolveSourceContext(group, input, workspacePath);
  } else if (group.capabilities?.requiresInputArtifacts) {
    // Legacy V2 path: caller must provide inputArtifacts directly
    const inputArtifacts = input.taskEnvelope?.inputArtifacts;
    if (!inputArtifacts || inputArtifacts.length === 0) {
      throw new Error(`Group ${input.groupId} requires inputArtifacts from an approved source run`);
    }
    if (!input.sourceRunIds || input.sourceRunIds.length === 0) {
      throw new Error(`Group ${input.groupId} requires sourceRunIds`);
    }
    resolvedSource = { sourceRuns: [], inputArtifacts };
  }

  // 4. Attach to the 2.0 hub
  const server = getLanguageServer();
  if (!server) {
    throw new Error('No Antigravity hub running');
  }

  const apiKey = getApiKey();

  // 5. Build or synthesize TaskEnvelope
  const finalModel = input.model || group.defaultModel || 'MODEL_PLACEHOLDER_M26';
  let envelope = input.taskEnvelope;
  if (!envelope) {
    // Synthesize default envelope for legacy prompt path
    envelope = {
      templateId: group.templateId,
      goal: input.prompt!,
    };
  }

  // V2.5: Populate resolved inputArtifacts into envelope if auto-built
  if (resolvedSource.inputArtifacts.length > 0 && (!envelope.inputArtifacts || envelope.inputArtifacts.length === 0)) {
    envelope = { ...envelope, inputArtifacts: resolvedSource.inputArtifacts };
  }

  // V2.5: Merge all resolved source run IDs
  const allSourceRunIds = [
    ...(input.sourceRunIds || []),
    ...resolvedSource.sourceRuns
      .filter(r => !input.sourceRunIds?.includes(r.runId))
      .map(r => r.runId),
  ];

  // 6. Create run record
  const run = createRun({
    groupId: input.groupId,
    workspace: input.workspace,
    prompt: goal,
    model: finalModel,
    parentConversationId: input.parentConversationId,
    templateId: group.templateId,
    taskEnvelope: envelope,
    sourceRunIds: allSourceRunIds.length > 0 ? allSourceRunIds : input.sourceRunIds,
    projectId: input.projectId,
    hubProjectId: input.hubProjectId,
    pipelineId: input.pipelineId,
    pipelineStageIndex: input.pipelineStageIndex,
  });

  const runId = run.runId;
  const shortRunId = runId.slice(0, 8);

  try {
    const wsUri = input.workspace.startsWith('file://') ? input.workspace : `file://${input.workspace}`;

    // V2.5: Route by executionMode
    if (group.executionMode === 'legacy-single') {
      // V3.5 Fix: Run-scoped artifact paths for legacy-single too
      const artifactDir = run.projectId
        ? `${ARTIFACT_ROOT_DIR}/projects/${run.projectId}/runs/${runId}/`
        : `${ARTIFACT_ROOT_DIR}/runs/${runId}/`;
      const artifactAbsDir = path.join(workspacePath, artifactDir);
      if (!fs.existsSync(artifactAbsDir)) {
        fs.mkdirSync(artifactAbsDir, { recursive: true });
      }
      updateRun(runId, { artifactDir });

      // ── Single-role path (V1 backward-compat) ──────────────────────────
      const workflowContent = AssetLoader.resolveWorkflowContent(group.roles[0].workflow);
      const cascadeId = await createAndDispatchChild(
        server, apiKey, wsUri, runId, input.groupId, group.roles[0].id,
        `${workflowContent}\n\n${goal}`,
        finalModel, input.parentConversationId,
      );

      updateRun(runId, { status: 'running' });
      startWatching(runId, cascadeId, { port: server.port, csrf: server.csrf }, apiKey, group.roles[0]);

      log.info({ runId: shortRunId, cascadeId: cascadeId.slice(0, 8) }, 'Single-role run dispatched');
    } else {
      // ── Envelope path: review-loop or delivery-single-pass (V1.5+/V2.5) ──
      log.info({ runId: shortRunId, mode: group.executionMode, roleCount: group.roles.length }, 'Starting envelope run');
      executeSerialEnvelopeRun(runId, group, server, apiKey, input, finalModel, resolvedSource).catch((err: any) => {
        log.error({ runId: shortRunId, err: err.message }, 'Envelope run failed');
        updateRun(runId, { status: 'failed', lastError: err.message });
      });
    }

    return { runId };
  } catch (err: any) {
    log.error({ runId: shortRunId, err: err.message }, 'Dispatch failed');
    updateRun(runId, { status: 'failed', lastError: err.message });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// createAndDispatchChild — reusable child conversation creation
// ---------------------------------------------------------------------------

async function createAndDispatchChild(
  server: { port: number; csrf: string },
  apiKey: string,
  wsUri: string,
  runId: string,
  groupId: string,
  roleId: string,
  prompt: string,
  model: string,
  parentConversationId?: string,
): Promise<string> {
  const shortRunId = runId.slice(0, 8);

  // PITFALL #12: Must addTrackedWorkspace before startCascade so the language server
  // knows about this workspace's filesystem. Without this, tool calls like
  // LIST_DIRECTORY get CANCELED because the server can't access the files.
  const run = getRun(runId);
  const { getAgyProject, projectFolderUris } = await import('../bridge/agy-projects');
  const hubProject = run?.hubProjectId ? getAgyProject(run.hubProjectId) : null;
  const folderUris = hubProject ? projectFolderUris(hubProject) : (wsUri ? [wsUri] : []);
  log.info({ runId: shortRunId, roleId, port: server.port, hubProjectId: hubProject?.id, folders: folderUris.length }, 'Starting child conversation');
  for (const uri of folderUris) {
    try {
      await grpc.addTrackedWorkspace(server.port, server.csrf, uri.replace(/^file:\/\//, ''));
    } catch (e: any) {
      log.warn({ runId: shortRunId, roleId, err: e.message }, 'AddTrackedWorkspace failed (may already be tracked)');
    }
  }

  const startResult = await grpc.startCascade(server.port, server.csrf, apiKey, {
    projectId: hubProject?.id,
    workspaceUris: folderUris,
  });
  const cascadeId = startResult?.cascadeId;

  if (!cascadeId) {
    throw new Error('StartCascade returned no cascadeId');
  }

  updateRun(runId, {
    status: 'starting',
    childConversationId: cascadeId,
    activeConversationId: cascadeId,
    activeRoleId: roleId,
    startedAt: new Date().toISOString(),
  });

  preRegisterOwner(cascadeId, {
    port: server.port,
    csrf: server.csrf,
    apiKey,
    stepCount: 0,
  });

  log.debug({ runId: shortRunId, cascadeId: cascadeId.slice(0, 8), roleId }, 'Setting hidden annotations');
  await grpc.updateConversationAnnotations(server.port, server.csrf, apiKey, cascadeId, {
    'antigravity.task.hidden': 'true',
    'antigravity.task.parentId': parentConversationId || '',
    'antigravity.task.groupId': groupId,
    'antigravity.task.runId': runId,
    'antigravity.task.roleId': roleId,
    lastUserViewTime: new Date().toISOString(),
  });

  log.info({ runId: shortRunId, cascadeId: cascadeId.slice(0, 8), roleId, promptLength: prompt.length }, 'Sending workflow prompt');
  await grpc.sendMessage(server.port, server.csrf, apiKey, cascadeId, prompt, model, false /* Fast mode */, undefined, 'ARTIFACT_REVIEW_MODE_TURBO');

  return cascadeId;
}

// ---------------------------------------------------------------------------
// startWatching — fire-and-forget watcher for single-role runs
// ---------------------------------------------------------------------------

function startWatching(
  runId: string,
  cascadeId: string,
  conn: { port: number; csrf: string },
  apiKey: string,
  roleConfig: { timeoutMs: number; autoApprove: boolean },
): void {
  const shortRunId = runId.slice(0, 8);
  let lastWasActive = true;
  let idleDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const stopLocalWatch = () => {
    if (stopped) return;
    stopped = true;
    if (idleDebounceTimer) clearTimeout(idleDebounceTimer);
    abortWatch();
    const active = activeRuns.get(runId);
    if (active?.abortWatch === abortWatch) {
      if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
      activeRuns.delete(runId);
    }
  };

  const abortWatch = watchConversation(
    conn,
    cascadeId,
    async (state: ConversationWatchState) => {
      const currentRun = getRun(runId);
      if (!isAuthoritativeConversation(currentRun, cascadeId)) {
        log.warn({ runId: shortRunId, cascadeId: cascadeId.slice(0, 8) }, 'Ignoring stale watcher for superseded branch');
        stopLocalWatch();
        return;
      }
      if (!currentRun || currentRun.status === 'cancelled' || currentRun.status === 'failed') {
        log.debug({ runId: shortRunId, status: currentRun?.status }, 'Run already terminal, cleaning up watcher');
        stopLocalWatch();
        return;
      }

      if (roleConfig.autoApprove) {
        await handleAutoApprove(state.steps, cascadeId, conn, apiKey, runId);
      }

      // V2.5.1: Propagate liveState to run
      updateRun(runId, {
        liveState: {
          cascadeStatus: state.cascadeStatus,
          stepCount: state.stepCount,
          lastStepAt: state.lastStepAt,
          lastStepType: state.lastStepType,
          staleSince: state.staleSince,
        },
      });

      // V2.5.1: Detect error steps as fallback completion signal
      if (state.hasErrorSteps && lastWasActive) {
        log.warn({ runId: shortRunId, stepCount: state.steps.length }, 'Child conversation ended with ERROR/CANCELED steps — completing with failure');
        if (idleDebounceTimer) clearTimeout(idleDebounceTimer);
        idleDebounceTimer = setTimeout(() => {
          const latestRun = getRun(runId);
          if (!isAuthoritativeConversation(latestRun, cascadeId)) {
            log.warn({ runId: shortRunId, cascadeId: cascadeId.slice(0, 8) }, 'Ignoring stale completion from superseded branch');
            stopLocalWatch();
            return;
          }
          handleCompletion(runId, state.steps);
        }, 2000);
        lastWasActive = false;
        return;
      }

      if (!state.isActive && lastWasActive) {
        log.info({ runId: shortRunId, cascadeStatus: state.cascadeStatus, stepCount: state.steps.length }, 'Child went idle, starting completion debounce');
        if (idleDebounceTimer) clearTimeout(idleDebounceTimer);
        idleDebounceTimer = setTimeout(() => {
          const latestRun = getRun(runId);
          if (!isAuthoritativeConversation(latestRun, cascadeId)) {
            log.warn({ runId: shortRunId, cascadeId: cascadeId.slice(0, 8) }, 'Ignoring stale completion from superseded branch');
            stopLocalWatch();
            return;
          }
          handleCompletion(runId, state.steps);
        }, 2000);
      } else if (state.isActive) {
        if (idleDebounceTimer) { clearTimeout(idleDebounceTimer); idleDebounceTimer = null; }
      }

      lastWasActive = state.isActive;
    },
    (err: Error) => {
      log.warn({ runId: shortRunId, err: err.message }, 'Watch stream disconnected');
      setTimeout(async () => {
        const currentRun = getRun(runId);
        if (!isAuthoritativeConversation(currentRun, cascadeId) || currentRun.status !== 'running') return;

        try {
          await refreshOwnerMap();
          const newConn = getOwnerConnection(cascadeId);
          if (newConn) {
            log.info({ runId: shortRunId }, 'Watch reconnecting');
            stopLocalWatch();
            startWatching(runId, cascadeId, newConn, apiKey, roleConfig);
          } else {
            log.error({ runId: shortRunId }, 'Watch reconnect failed: no owner');
            updateRun(runId, { status: 'failed', lastError: 'Watch stream lost and reconnect failed' });
            stopLocalWatch();
          }
        } catch (e: any) {
          log.error({ runId: shortRunId, err: e.message }, 'Watch reconnect error');
          updateRun(runId, { status: 'failed', lastError: `Reconnect error: ${e.message}` });
          stopLocalWatch();
        }
      }, 3000);
    },
    apiKey,
  );

  const timeoutTimer = setTimeout(() => {
    const currentRun = getRun(runId);
    if (currentRun && currentRun.status === 'running') {
      log.warn({ runId: shortRunId, timeoutMs: roleConfig.timeoutMs }, 'Run timed out');
      cancelRunInternal(runId, cascadeId, conn, apiKey, 'timeout');
    }
  }, roleConfig.timeoutMs);

  activeRuns.set(runId, { abortWatch, timeoutTimer });
}

// ---------------------------------------------------------------------------
// V3.5: Run Intervention — same-run continuation for stale or failed roles
// ---------------------------------------------------------------------------

export type InterventionAction = 'nudge' | 'retry' | 'restart_role' | 'evaluate';

// V3.5 Fix 6: Atomic intervention lock — prevents concurrent interventions on the same run
const activeInterventions = new Set<string>();

export class InterventionConflictError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} already has an active intervention in progress`);
    this.name = 'InterventionConflictError';
  }
}

export async function interveneRun(
  runId: string,
  action: InterventionAction,
  prompt?: string,
  roleId?: string,
): Promise<{ status: string; action: InterventionAction; cascadeId?: string }> {
  // V3.5 Fix 6: Atomic admission — no TOCTOU gap in single-threaded Node.js
  if (activeInterventions.has(runId)) {
    throw new InterventionConflictError(runId);
  }
  activeInterventions.add(runId);

  try {
    const run = getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    const effectiveAction: InterventionAction = action === 'retry' ? 'restart_role' : action;
    const isTerminal = run.status === 'failed' || run.status === 'blocked' || run.status === 'timeout' || run.status === 'cancelled';
    const isStaleActive = (run.status === 'starting' || run.status === 'running') && !!run.liveState?.staleSince;
    // V3.5: evaluate is allowed on any status — it's a read-only diagnostic
    if (effectiveAction === 'evaluate') {
      // no status gate — allow on any state
    } else if (effectiveAction === 'nudge') {
      if (!isStaleActive) {
        throw new Error(`Cannot nudge run ${runId}: status '${run.status}' is not stale-active`);
      }
    } else if (!isTerminal && !isStaleActive) {
      throw new Error(`Cannot ${effectiveAction} run ${runId}: status '${run.status}' is not actionable`);
    }

    const group = getGroup(run.groupId);
    if (!group) throw new Error(`Unknown group: ${run.groupId}`);

    const shortRunId = runId.slice(0, 8);
    const workspacePath = run.workspace.replace(/^file:\/\//, '');

    const server = getLanguageServer();
    if (!server) throw new Error('No Antigravity hub running');

    const apiKey = getApiKey();

    // Find the last failed/completed role
    const roles = run.roles || [];
    const targetRoleId = roleId || roles[roles.length - 1]?.roleId;
    if (!targetRoleId) throw new Error('No role found to intervene on');

    const roleDef = group.roles.find(r => r.id === targetRoleId);
    if (!roleDef) throw new Error(`Role ${targetRoleId} not found in group ${group.id}`);

    const isReviewer = group.roles.indexOf(roleDef) > 0 && group.executionMode === 'review-loop';
    const wsUri = run.workspace.startsWith('file://') ? run.workspace : `file://${run.workspace}`;
    const artifactDir = run.artifactDir || (run.projectId ? `${ARTIFACT_ROOT_DIR}/projects/${run.projectId}/runs/${runId}/` : `${ARTIFACT_ROOT_DIR}/runs/${runId}/`);
    const artifactAbsDir = path.join(workspacePath, artifactDir);

    log.info({ runId: shortRunId, action, targetRoleId, isReviewer }, 'Intervening on run');

    if (effectiveAction === 'nudge') {
      // ── NUDGE: send a follow-up message to the existing child conversation ──
      // V3.5 Fix 7: Find the LATEST matching role's cascadeId (reverse search)
      const matchingRoles = roles.filter(r => r.roleId === targetRoleId && r.childConversationId);
      const latestRole = matchingRoles[matchingRoles.length - 1];
      const cascadeId = latestRole?.childConversationId || run.childConversationId;
      if (!cascadeId) throw new Error('No child conversation found to nudge');

      updateRun(runId, {
        status: run.status === 'starting' ? 'starting' : 'running',
        lastError: undefined,
        activeConversationId: cascadeId,
        activeRoleId: targetRoleId,
      });

      const nudgePrompt = prompt || (isReviewer
        ? 'You forgot to output a DECISION marker at the end of your review. Please review your analysis above and output exactly one of: DECISION: APPROVED, DECISION: REVISE, or DECISION: REJECTED. Output it now as the last line of your response.'
        : 'Your previous output was incomplete. Please complete your task and write result.json as specified in your workflow instructions.');

      log.info({ runId: shortRunId, cascadeId: cascadeId.slice(0, 8), promptLength: nudgePrompt.length }, 'Sending nudge to existing cascade');

      await grpc.sendMessage(server.port, server.csrf, apiKey, cascadeId, nudgePrompt, run.model);

      // Watch for completion
      let steps: any[];
      let result: TaskResult;
      try {
        ({ steps, result } = await watchUntilComplete(
          runId, cascadeId, { port: server.port, csrf: server.csrf }, apiKey, roleDef, cascadeId,
        ));
      } catch (err: any) {
        if (err?.message === 'superseded') {
          log.info({ runId: shortRunId, cascadeId: cascadeId.slice(0, 8) }, 'Nudge result ignored because the branch was superseded');
          return { status: 'superseded', action, cascadeId };
        }
        throw err;
      }

      if (!isAuthoritativeConversation(getRun(runId), cascadeId)) {
        log.info({ runId: shortRunId, cascadeId: cascadeId.slice(0, 8) }, 'Skipping nudge writeback for superseded branch');
        return { status: 'superseded', action, cascadeId };
      }

      // Update role progress — find by cascadeId, not blindly last
      const nudgeTaskEnvelope = getCanonicalTaskEnvelope(runId, run.taskEnvelope);
      const nudgeAudit = buildRoleInputReadAudit(runId, artifactDir, nudgeTaskEnvelope, steps);
      const nudgeResult = enforceCanonicalInputReadProtocol(targetRoleId, result, nudgeAudit);
      const rolesAfter = getRun(runId)?.roles || [];
      const matchIdx = rolesAfter.findIndex(r => r.childConversationId === cascadeId);
      const targetIdx = matchIdx >= 0 ? matchIdx : rolesAfter.length - 1;
      if (targetIdx >= 0) {
        rolesAfter[targetIdx] = {
          ...rolesAfter[targetIdx],
          status: nudgeResult.status,
          finishedAt: new Date().toISOString(),
          result: nudgeResult,
          inputReadAudit: nudgeAudit,
        };
        updateRun(runId, { roles: rolesAfter });
      }

      // Process result
      await processInterventionResult(runId, run, group, roleDef, isReviewer, nudgeResult, steps, artifactAbsDir);

      return { status: 'completed', action, cascadeId };

    } else if (effectiveAction === 'evaluate') {
      // ── EVALUATE: on-demand AI supervisor assessment — read-only, no state change ──
      const goal = run.taskEnvelope?.goal || run.prompt;
      const cascadeId = run.activeConversationId || run.childConversationId;

      // Fetch recent steps from the last known conversation
      let recentStepsText = 'No conversation data available.';
      if (cascadeId) {
        try {
          const resp = await grpc.getTrajectorySteps(server.port, server.csrf, apiKey, cascadeId);
          const allSteps = (resp?.steps || []).filter((s: any) => s != null);
          const recentSteps = allSteps.slice(-12).map(summarizeStepForSupervisor);
          recentStepsText = recentSteps.join('\n') || 'No recent actions.';
        } catch {
          recentStepsText = 'Failed to fetch conversation steps.';
        }
      }

      // Build diagnostic prompt
      const evalPrompt = `[On-Demand Diagnostic Assessment]
Task Goal: ${goal}

Current Run State:
- Status: ${run.status}
- Active Role: ${run.activeRoleId || 'unknown'}
- Last Error: ${run.lastError || 'none'}
- Total Roles Executed: ${(run.roles || []).length}

Recent Actions (last 12 steps):
${recentStepsText}

Please analyze this run and provide:
1. What the agent was trying to do
2. What went wrong (if failed)
3. Whether a retry/restart is likely to succeed
4. Recommended action

Reply with ONLY a JSON object: {"status": "HEALTHY|STUCK|LOOPING|DONE", "analysis": "detailed diagnosis"}`;

      // Create a one-shot supervisor conversation
      const evalWsUri = wsUri;
      const startResult = await grpc.startCascade(server.port, server.csrf, apiKey, evalWsUri);
      const evalCascadeId = startResult?.cascadeId;
      if (!evalCascadeId) {
        throw new Error('Failed to start supervisor evaluation conversation');
      }

      // Store conversation ID on run immediately so frontend can open it in real-time
      updateRun(runId, { supervisorConversationId: evalCascadeId });

      // Mark as supervisor task (NOT hidden — user needs to see it)
      await grpc.updateConversationAnnotations(server.port, server.csrf, apiKey, evalCascadeId, {
        'antigravity.task.type': 'supervisor-evaluate',
        'antigravity.task.runId': runId,
      });

      // Send evaluation prompt
      await grpc.sendMessage(
        server.port, server.csrf, apiKey, evalCascadeId,
        evalPrompt, SUPERVISOR_MODEL,
        false, undefined, 'ARTIFACT_REVIEW_MODE_TURBO',
      );

      // Poll for response
      const pollStart = Date.now();
      const EVAL_POLL_INTERVAL = 5_000;
      const EVAL_POLL_TIMEOUT = 90_000;
      let responseText = '';
      const preStepsResp = await grpc.getTrajectorySteps(server.port, server.csrf, apiKey, evalCascadeId);
      const preStepCount = (preStepsResp?.steps || []).filter((s: any) => s != null).length;

      while (Date.now() - pollStart < EVAL_POLL_TIMEOUT) {
        await new Promise(r => setTimeout(r, EVAL_POLL_INTERVAL));
        const stepsResp = await grpc.getTrajectorySteps(server.port, server.csrf, apiKey, evalCascadeId);
        const evalSteps = (stepsResp?.steps || []).filter((s: any) => s != null);
        for (let j = evalSteps.length - 1; j >= preStepCount; j--) {
          const step = evalSteps[j];
          if (step?.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
            const planner = step.plannerResponse || step.response || {};
            const text = planner.modifiedResponse || planner.response || '';
            if (text) { responseText = text; break; }
          }
        }
        if (responseText) break;
      }

      // Parse decision
      let decision: SupervisorDecision;
      if (!responseText) {
        decision = { status: 'STUCK', analysis: 'Supervisor evaluation timed out — no response received.' };
      } else {
        try {
          const jsonMatch = responseText.match(/\{[\s\S]*?\}/);
          decision = jsonMatch ? JSON.parse(jsonMatch[0]) : { status: 'STUCK', analysis: responseText.slice(0, 500) };
          if (!['HEALTHY', 'STUCK', 'LOOPING', 'DONE'].includes(decision.status)) {
            decision.status = 'STUCK';
          }
        } catch {
          decision = { status: 'STUCK', analysis: `(Parse failed) ${responseText.slice(0, 500)}` };
        }
      }

      // Write review result — does NOT change run status
      const review: SupervisorReview = {
        id: `eval-${Date.now()}`,
        timestamp: new Date().toISOString(),
        round: -1, // negative round = on-demand evaluation
        stepCount: (run.roles || []).length,
        decision,
      };
      const currentRun = getRun(runId);
      if (currentRun) {
        const reviews = [...(currentRun.supervisorReviews || []), review];
        updateRun(runId, { supervisorReviews: reviews });
      }

      log.info({ runId: shortRunId, decision: decision.status }, 'On-demand supervisor evaluation completed');
      return { status: 'evaluated', action };

    } else {
      // ── RESTART ROLE: create a fresh child conversation for this role ──
      const goal = run.taskEnvelope?.goal || run.prompt;
      const round = run.currentRound || 1;
      const previousCascadeId = run.activeConversationId || run.childConversationId;

      const retryTaskEnvelope = getCanonicalTaskEnvelope(runId, run.taskEnvelope);
      const retryPrompt = prompt || buildRetryPrompt(roleDef, goal, artifactDir, round, isReviewer, retryTaskEnvelope);
      const cascadeId = await createAndDispatchChild(
        server, apiKey, wsUri, runId, run.groupId, targetRoleId,
        retryPrompt,
        run.model || 'MODEL_PLACEHOLDER_M26',
        run.parentConversationId,
      );

      updateRun(runId, {
        status: 'running',
        lastError: undefined,
        activeConversationId: cascadeId,
        activeRoleId: targetRoleId,
      });
      await cancelCascadeBestEffort(previousCascadeId, { port: server.port, csrf: server.csrf }, apiKey, shortRunId);

      // Record new role progress
      const newRoles = [...(getRun(runId)?.roles || [])];
      const startedAt = new Date().toISOString();
      newRoles.push({
        roleId: targetRoleId,
        round: round,
        childConversationId: cascadeId,
        status: 'running',
        startedAt,
        promptSnapshot: retryPrompt,
        promptRecordedAt: startedAt,
      });
      updateRun(runId, { roles: newRoles, childConversationId: cascadeId, activeConversationId: cascadeId, activeRoleId: targetRoleId });

      log.info({ runId: shortRunId, cascadeId: cascadeId.slice(0, 8), roleId: targetRoleId }, 'Restart-role dispatched');

      // Watch for completion
      let steps: any[];
      let result: TaskResult;
      try {
        ({ steps, result } = await watchUntilComplete(
          runId, cascadeId, { port: server.port, csrf: server.csrf }, apiKey, roleDef, cascadeId,
        ));
      } catch (err: any) {
        if (err?.message === 'superseded') {
          log.info({ runId: shortRunId, cascadeId: cascadeId.slice(0, 8) }, 'Restart-role result ignored because the branch was superseded');
          return { status: 'superseded', action, cascadeId };
        }
        throw err;
      }

      if (!isAuthoritativeConversation(getRun(runId), cascadeId)) {
        log.info({ runId: shortRunId, cascadeId: cascadeId.slice(0, 8) }, 'Skipping restart-role writeback for superseded branch');
        return { status: 'superseded', action, cascadeId };
      }

      // Update role progress
      const restartAudit = buildRoleInputReadAudit(runId, artifactDir, retryTaskEnvelope, steps);
      const restartResult = enforceCanonicalInputReadProtocol(targetRoleId, result, restartAudit);
      const rolesAfter = getRun(runId)?.roles || [];
      if (rolesAfter.length > 0) {
        rolesAfter[rolesAfter.length - 1] = {
          ...rolesAfter[rolesAfter.length - 1],
          status: restartResult.status,
          finishedAt: new Date().toISOString(),
          result: restartResult,
          inputReadAudit: restartAudit,
        };
        updateRun(runId, { roles: rolesAfter });
      }

      // Process result
      await processInterventionResult(runId, run, group, roleDef, isReviewer, restartResult, steps, artifactAbsDir);

      return { status: 'completed', action, cascadeId };
    }

  } finally {
    activeInterventions.delete(runId);
  }
}

/**
 * After an intervention completes, process the result the same way
 * the original review-loop or delivery path would.
 */
export async function processInterventionResult(
  runId: string,
  originalRun: AgentRunState,
  group: GroupDefinition,
  roleDef: GroupRoleDefinition,
  isReviewer: boolean,
  result: TaskResult,
  steps: any[],
  artifactAbsDir: string,
): Promise<void> {
  const shortRunId = runId.slice(0, 8);

  if (result.status !== 'completed') {
    log.warn({ runId: shortRunId, roleId: roleDef.id, status: result.status }, 'Intervention did not complete successfully');
    updateRun(runId, {
      status: result.status === 'blocked' ? 'blocked' : 'failed',
      result,
      lastError: getFailureReason(result) || `Intervention failed: role ${roleDef.id} status=${result.status}`,
    });
    return;
  }

  if (isReviewer) {
    // V3.5 Fix 4: Use fresh run state, not stale originalRun snapshot
    const freshRun = getRun(runId);
    let decision: string = extractReviewDecision(artifactAbsDir, freshRun?.currentRound || 1, steps, result);

    // Policy engine override
    const policy = group.reviewPolicyId ? AssetLoader.getReviewPolicy(group.reviewPolicyId) : undefined;
    if (policy && freshRun) {
      const engineDecision = ReviewEngine.evaluate(freshRun, policy);
      if (engineDecision === 'revise-exhausted' || engineDecision === 'rejected') {
        decision = engineDecision as any;
      }
    }

    log.info({ runId: shortRunId, decision }, 'Intervention review decision extracted');

    if (decision === 'approved') {
      updateRun(runId, { status: 'completed', result, reviewOutcome: 'approved' });
      finalizeAdvisoryRun(runId, group, artifactAbsDir, 'approved', result);
      // Pipeline auto-trigger
      const input: DispatchRunInput = {
        groupId: group.id,
        workspace: originalRun.workspace,
        projectId: originalRun.projectId,
        pipelineId: originalRun.pipelineId,
        pipelineStageIndex: originalRun.pipelineStageIndex,
      };
      void tryAutoTriggerNextStage(runId, group.id, input);
    } else if (decision === 'rejected') {
      updateRun(runId, { status: 'blocked', result, reviewOutcome: 'rejected', lastError: 'Reviewer rejected the spec' });
      finalizeAdvisoryRun(runId, group, artifactAbsDir, 'rejected', result);
    } else if (decision === 'revise-exhausted') {
      updateRun(runId, { status: 'blocked', reviewOutcome: 'revise-exhausted', lastError: 'Exceeded max review rounds per policy' });
      finalizeAdvisoryRun(runId, group, artifactAbsDir, 'revise-exhausted', undefined);
    } else {
      // 'revise' — resume the review loop from the next round
      // V3.5 Fix 4: Use fresh run state for currentRound
      const currentRound = freshRun?.currentRound || 1;
      const nextRound = currentRound + 1;
      log.info({ runId: shortRunId, nextRound }, 'Intervention: reviewer requested revision, resuming review loop');
      updateRun(runId, { currentRound: nextRound });

      // Re-enter the review loop from the next round
      const workspacePath = originalRun.workspace.replace(/^file:\/\//, '');
      const wsUri = originalRun.workspace.startsWith('file://') ? originalRun.workspace : `file://${originalRun.workspace}`;
      const server = getLanguageServer();
      if (!server) {
        updateRun(runId, { status: 'failed', lastError: 'Cannot resume review loop: no language server found' });
        return;
      }
      const apiKey = getApiKey();

      const input: DispatchRunInput = {
        groupId: group.id,
        workspace: originalRun.workspace,
        prompt: originalRun.prompt,
        projectId: originalRun.projectId,
        pipelineId: originalRun.pipelineId,
        pipelineStageIndex: originalRun.pipelineStageIndex,
        taskEnvelope: originalRun.taskEnvelope,
      };

      // Fire-and-forget: resume the review loop asynchronously
      executeReviewLoop(
        runId, group, server, apiKey, wsUri,
        originalRun.taskEnvelope?.goal || originalRun.prompt,
        originalRun.model || 'MODEL_PLACEHOLDER_M26',
        input, artifactAbsDir.replace(workspacePath + '/', ''), artifactAbsDir,
      ).catch((err: any) => {
        log.error({ runId: shortRunId, err: err.message }, 'Resumed review loop failed');
        updateRun(runId, { status: 'failed', lastError: err.message });
      });
    }
  } else if (group.executionMode === 'review-loop') {
    // V3.5 Fix 2: Author recovered in a review-loop — resume from the NEXT role (reviewer)
    // instead of marking the whole run as completed and skipping the reviewer
    const freshRun = getRun(runId);
    const currentRound = freshRun?.currentRound || 1;
    const authorIndex = group.roles.findIndex(r => r.id === roleDef.id);
    const nextRoleIndex = authorIndex + 1;

    log.info({ runId: shortRunId, currentRound, authorIndex, nextRoleIndex }, 'Author recovered, resuming review round from next role');

    const workspacePath = originalRun.workspace.replace(/^file:\/\//, '');
    const wsUri = originalRun.workspace.startsWith('file://') ? originalRun.workspace : `file://${originalRun.workspace}`;
    const server = getLanguageServer();
    if (!server) {
      updateRun(runId, { status: 'failed', lastError: 'Cannot resume review round: no language server found' });
      return;
    }
    const apiKey = getApiKey();

    const input: DispatchRunInput = {
      groupId: group.id,
      workspace: originalRun.workspace,
      prompt: originalRun.prompt,
      projectId: originalRun.projectId,
      pipelineId: originalRun.pipelineId,
      pipelineStageIndex: originalRun.pipelineStageIndex,
      taskEnvelope: originalRun.taskEnvelope,
    };
    const artifactDirRel = artifactAbsDir.replace(workspacePath + '/', '');

    // Fire-and-forget: run the current round from the reviewer role
    executeReviewRound(
      runId, group, server, apiKey, wsUri,
      originalRun.taskEnvelope?.goal || originalRun.prompt,
      originalRun.model || 'MODEL_PLACEHOLDER_M26',
      input, artifactDirRel, artifactAbsDir, currentRound, nextRoleIndex,
    ).then(async (decision) => {
      if (decision === 'revise') {
        const nextRound = currentRound + 1;
        updateRun(runId, { currentRound: nextRound });
        await executeReviewLoop(
          runId, group, server, apiKey, wsUri,
          originalRun.taskEnvelope?.goal || originalRun.prompt,
          originalRun.model || 'MODEL_PLACEHOLDER_M26',
          input, artifactDirRel, artifactAbsDir,
        );
      }
    }).catch((err: any) => {
      log.error({ runId: shortRunId, err: err.message }, 'Author recovery review round failed');
      updateRun(runId, { status: 'failed', lastError: err.message });
    });
  } else if (group.executionMode === 'delivery-single-pass') {
    // Delivery finalization
    finalizeDeliveryRun(runId, group, artifactAbsDir, result, undefined);
    const input: DispatchRunInput = {
      groupId: group.id,
      workspace: originalRun.workspace,
      projectId: originalRun.projectId,
      pipelineId: originalRun.pipelineId,
      pipelineStageIndex: originalRun.pipelineStageIndex,
    };
    void tryAutoTriggerNextStage(runId, group.id, input);
  } else {
    // Non-review-loop, non-delivery author completed — mark success
    updateRun(runId, { status: 'completed', result });
  }
}

/**
 * Build a retry prompt for a role that is being re-executed.
 */
function buildRetryPrompt(
  role: GroupRoleDefinition,
  goal: string,
  artifactDir: string,
  round: number,
  isReviewer: boolean,
  taskEnvelope?: TaskEnvelope,
): string {
  const taskEnvelopePath = `${artifactDir}task-envelope.json`;
  const inputArtifactLines = formatPromptArtifactLines(artifactDir, taskEnvelope?.inputArtifacts || []);

  if (isReviewer) {
    return [
      AssetLoader.resolveWorkflowContent(role.workflow),
      '',
      'Retry context',
      '- This review role is being re-executed because the previous attempt failed to produce a valid output.',
      `- Task envelope: ${taskEnvelopePath}`,
      `- Review round: ${round}`,
      '',
      'Canonical upstream inputs',
      ...inputArtifactLines,
      '',
      'Critical instructions',
      '- Read the task envelope first, then the canonical upstream inputs listed above.',
      '- Review the author output files carefully before deciding.',
      '- You MUST end your review with exactly one of: DECISION: APPROVED, DECISION: REVISE, DECISION: REJECTED.',
      '',
      'Original goal',
      goal,
    ].join('\n');
  }

  return [
    AssetLoader.resolveWorkflowContent(role.workflow),
    '',
    'Retry context',
    '- This role is being re-executed because the previous attempt failed.',
    `- Task envelope: ${taskEnvelopePath}`,
    '',
    'Canonical upstream inputs',
    ...inputArtifactLines,
    '',
    'Critical instructions',
    '- Read the task envelope first, then the canonical upstream inputs listed above.',
    '- Complete the task as specified in your workflow instructions.',
    '',
    'Original goal',
    goal,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// watchUntilComplete — Promise-based watcher for multi-role serial execution
// ---------------------------------------------------------------------------

function watchUntilComplete(
  runId: string,
  cascadeId: string,
  conn: { port: number; csrf: string },
  apiKey: string,
  roleConfig: GroupRoleDefinition,
  expectedConversationId: string,
): Promise<{ steps: any[]; result: TaskResult }> {
  return new Promise((resolve, reject) => {
    const shortRunId = runId.slice(0, 8);
    let lastWasActive = true;
    let idleDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let isSettled = false;

    const settle = (fn: () => void) => {
      if (isSettled) return;
      isSettled = true;
      if (idleDebounceTimer) clearTimeout(idleDebounceTimer);
      clearTimeout(timeoutTimer);
      abortWatch();
      const active = activeRuns.get(runId);
      if (active?.abortWatch === abortWatch) {
        activeRuns.delete(runId);
      }
      fn();
    };

    const abortWatch = watchConversation(
      conn,
      cascadeId,
      async (state: ConversationWatchState) => {
        if (isSettled) return;

        const currentRun = getRun(runId);
        if (!isAuthoritativeConversation(currentRun, expectedConversationId)) {
          log.warn({ runId: shortRunId, cascadeId: cascadeId.slice(0, 8) }, 'Stale watcher for superseded branch');
          settle(() => reject(new Error('superseded')));
          return;
        }
        if (!currentRun || currentRun.status === 'cancelled' || currentRun.status === 'failed') {
          log.debug({ runId: shortRunId, status: currentRun?.status }, 'Run already terminal, settling watcher');
          settle(() => reject(new Error(currentRun?.status || 'cancelled')));
          return;
        }

        if (roleConfig.autoApprove) {
          await handleAutoApprove(state.steps, cascadeId, conn, apiKey, runId);
        }

        // V2.5.1: Propagate liveState to run
        updateRun(runId, {
          liveState: {
            cascadeStatus: state.cascadeStatus,
            stepCount: state.stepCount,
            lastStepAt: state.lastStepAt,
            lastStepType: state.lastStepType,
            staleSince: state.staleSince,
          },
        });

        // V2.5.1: Detect error steps as fallback completion signal
        if (state.hasErrorSteps && lastWasActive) {
          log.warn({ runId: shortRunId, roleId: roleConfig.id, stepCount: state.steps.length }, 'Child ended with ERROR/CANCELED steps — treating as failed completion');
          if (idleDebounceTimer) clearTimeout(idleDebounceTimer);
          idleDebounceTimer = setTimeout(() => {
            const latestRun = getRun(runId);
            if (!isAuthoritativeConversation(latestRun, expectedConversationId)) {
              log.warn({ runId: shortRunId, cascadeId: cascadeId.slice(0, 8) }, 'Ignoring stale completion from superseded branch');
              settle(() => reject(new Error('superseded')));
              return;
            }
            const run = getRun(runId);
            const absDir = run?.artifactDir ? path.join((run.workspace || '').replace(/^file:\/\//, ''), run.artifactDir) : undefined;
            const result = compactCodingResult(state.steps, absDir, roleConfig);
            // Only force failed if result.json didn't claim success
            if (!absDir || result.status !== 'completed') {
              result.status = 'failed';
              if (!result.summary || result.summary === 'Task completed (no summary extracted)') {
                result.summary = 'Child conversation ended with tool errors';
              }
            } else {
              log.info({ runId: shortRunId }, 'result.json reports completed despite hasErrorSteps — trusting result.json');
            }
            settle(() => resolve({ steps: state.steps, result }));
          }, 2000);
          lastWasActive = false;
          return;
        }

        if (!state.isActive && lastWasActive) {
          log.info({ runId: shortRunId, roleId: roleConfig.id, cascadeStatus: state.cascadeStatus, stepCount: state.steps.length }, 'Child went idle in multi-role watcher');
          if (idleDebounceTimer) clearTimeout(idleDebounceTimer);
          idleDebounceTimer = setTimeout(() => {
            const latestRun = getRun(runId);
            if (!isAuthoritativeConversation(latestRun, expectedConversationId)) {
              log.warn({ runId: shortRunId, cascadeId: cascadeId.slice(0, 8) }, 'Ignoring stale completion from superseded branch');
              settle(() => reject(new Error('superseded')));
              return;
            }
            const run = getRun(runId);
            const absDir = run?.artifactDir ? path.join((run.workspace || '').replace(/^file:\/\//, ''), run.artifactDir) : undefined;
            const result = compactCodingResult(state.steps, absDir, roleConfig);
            settle(() => resolve({ steps: state.steps, result }));
          }, 2000);
        } else if (state.isActive) {
          if (idleDebounceTimer) { clearTimeout(idleDebounceTimer); idleDebounceTimer = null; }
        }

        lastWasActive = state.isActive;
      },
      (err: Error) => {
        log.warn({ runId: shortRunId, err: err.message }, 'Watch stream disconnected in multi-role');
        setTimeout(async () => {
          if (isSettled) return;
          const currentRun = getRun(runId);
          if (!isAuthoritativeConversation(currentRun, expectedConversationId) || currentRun.status !== 'running') return;

          try {
            await refreshOwnerMap();
            const newConn = getOwnerConnection(cascadeId);
            if (newConn) {
              log.info({ runId: shortRunId }, 'Watch reconnecting (multi-role)');
              settle(() => { });
              watchUntilComplete(runId, cascadeId, newConn, apiKey, roleConfig, expectedConversationId)
                .then(resolve)
                .catch(reject);
            } else {
              settle(() => reject(new Error('Watch stream lost and reconnect failed')));
            }
          } catch (e: any) {
            settle(() => reject(e));
          }
        }, 3000);
      },
      apiKey,
    );

    const timeoutTimer = setTimeout(() => {
      log.warn({ runId: shortRunId, timeoutMs: roleConfig.timeoutMs }, 'Role timed out');
      settle(() => reject(new Error('timeout')));
    }, roleConfig.timeoutMs);

    activeRuns.set(runId, { abortWatch, timeoutTimer });
  });
}

// ---------------------------------------------------------------------------
// V3.5: AI Supervisor Loop — uses internal task dispatch (not external API)
// Reuses a single supervisor conversation across all review rounds for context
// continuity. Each review prompt includes historical comparison data so the
// model can detect changes between rounds (progress vs stuck).
// ---------------------------------------------------------------------------

const SUPERVISOR_MODEL = 'MODEL_PLACEHOLDER_M47'; // Gemini 3 Flash

/**
 * Summarize a single step into a human-readable one-liner for the supervisor prompt.
 */
function summarizeStepForSupervisor(step: any): string {
  const type = (step.type || '').replace('CORTEX_STEP_TYPE_', '');
  switch (type) {
    case 'CODE_ACTION': {
      const spec = step.codeAction?.actionSpec || {};
      const file = (spec.createFile?.absoluteUri || spec.editFile?.absoluteUri || spec.deleteFile?.absoluteUri || '').split('/').pop() || '?';
      const action = spec.createFile ? 'create' : spec.deleteFile ? 'delete' : 'edit';
      return `[CODE_ACTION] ${action} ${file}`;
    }
    case 'VIEW_FILE':
      return `[VIEW_FILE] ${(step.viewFile?.absoluteUri || '').split('/').pop() || '?'}`;
    case 'GREP_SEARCH':
      return `[GREP_SEARCH] "${step.grepSearch?.query || step.grepSearch?.searchPattern || '?'}"`;
    case 'RUN_COMMAND':
      return `[RUN_COMMAND] ${(step.runCommand?.command || step.runCommand?.commandLine || '?').slice(0, 80)}`;
    case 'SEARCH_WEB':
      return `[SEARCH_WEB] "${step.searchWeb?.query || '?'}"`;
    case 'FIND':
      return `[FIND] pattern="${step.find?.pattern || '?'}" in ${(step.find?.searchDirectory || '').split('/').pop() || '/'}`;
    case 'LIST_DIRECTORY':
      return `[LIST_DIR] ${(step.listDirectory?.path || '').split('/').pop() || '/'}`;
    case 'PLANNER_RESPONSE': {
      const pr = step.plannerResponse || {};
      const text = pr.modifiedResponse || pr.response || '';
      return `[PLANNER_RESPONSE] ${text.slice(0, 120)}${text.length > 120 ? '...' : ''}`;
    }
    case 'USER_INPUT':
      return `[USER_INPUT]`;
    case 'ERROR_MESSAGE':
      return `[ERROR] ${(step.errorMessage?.message || '').slice(0, 80)}`;
    default:
      return `[${type}]`;
  }
}

async function startSupervisorLoop(
  runId: string,
  cascadeId: string,
  goal: string,
  apiKey: string,
  server: { port: number; csrf: string },
  wsUri: string,
) {
  const MAX_REVIEWS = 10;
  const REVIEW_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
  const POLL_INTERVAL_MS = 5_000;
  const POLL_TIMEOUT_MS = 90_000; // max wait per review round
  const STUCK_CANCEL_THRESHOLD = 3; // consecutive STUCK rounds before suggesting cancel

  // Create a single supervisor conversation for all review rounds
  let supervisorCascadeId: string | undefined;

  // Track previous review state for comparison
  let prevStepCount = 0;
  let prevLastStepType = '';
  let prevDecision: string | undefined;

  // Track consecutive stuck/looping for escalation
  let consecutiveStuck = 0;
  let consecutiveStuckPeak = 0;
  let healthyCount = 0;
  let stuckCount = 0;
  let loopingCount = 0;
  let doneCount = 0;
  const suggestedActions: string[] = [];
  const loopStartedAt = new Date().toISOString();

  // Wait one interval before first review
  await new Promise(r => setTimeout(r, REVIEW_INTERVAL_MS));

  for (let i = 1; i <= MAX_REVIEWS; i++) {
    const run = getRun(runId);
    // V3.5 Fix: Only exit on terminal status, NOT on activeConversationId change.
    // The supervisor should survive role switches and keep monitoring the run.
    if (!run || TERMINAL_STATUSES.has(run.status)) {
      break;
    }
    if (!run.liveState) continue;

    // Dynamically track the current active conversation (changes on role switch)
    const currentCascadeId = run.activeConversationId || cascadeId;

    try {
      // 1. Collect context: fetch recent steps of the currently active agent
      const resp = await grpc.getTrajectorySteps(server.port, server.csrf, apiKey, currentCascadeId);
      const allSteps = (resp?.steps || []).filter((s: any) => s != null);

      // Summarize last 8 steps with meaningful content
      const recentSteps = allSteps.slice(-8).map(summarizeStepForSupervisor);
      const recentStepsText = recentSteps.join('\n') || 'No recent actions.';

      const currentStepCount = allSteps.length;
      const currentLastStepType = run.liveState.lastStepType || 'None';
      const staleTimeMs = run.liveState.staleSince
        ? Date.now() - new Date(run.liveState.staleSince).getTime()
        : 0;

      // Build comparison context from previous review
      const deltaSteps = currentStepCount - prevStepCount;
      const comparisonText = i === 1
        ? '(First review — no prior data to compare)'
        : `Previous review (#${i - 1}):
- Previous step count: ${prevStepCount} → Current: ${currentStepCount} (delta: ${deltaSteps > 0 ? '+' : ''}${deltaSteps})
- Previous last activity: ${prevLastStepType}
- Previous assessment: ${prevDecision || 'N/A'}
${deltaSteps === 0 ? '⚠️ NO NEW STEPS since last review — agent may be stuck!' : ''}`;

      // 2. Build review prompt (include active role for context)
      const activeRoleId = run.activeRoleId || 'unknown';
      const reviewPrompt = `[Review Round #${i}]
Task Goal: ${goal}

Current State: 
- Active Role: ${activeRoleId}
- Cascade Status: ${run.liveState.cascadeStatus}
- Total steps executed: ${currentStepCount}
- Last activity type: ${currentLastStepType}
- Time since last step: ${Math.round(staleTimeMs / 1000)}s

Comparison with previous review:
${comparisonText}

Recent Actions (last 8 steps):
${recentStepsText}

Is the agent making meaningful progress toward the goal, stuck, looping, or done?
Reply with ONLY a JSON object: {"status": "HEALTHY|STUCK|LOOPING|DONE", "analysis": "brief reason"}`;

      // 3. Create or reuse the supervisor conversation
      if (!supervisorCascadeId) {
        const startResult = await grpc.startCascade(server.port, server.csrf, apiKey, wsUri);
        supervisorCascadeId = startResult?.cascadeId;
        if (!supervisorCascadeId) {
          log.warn({ runId: runId.slice(0, 8), round: i }, 'Supervisor review: startCascade returned no cascadeId');
          continue;
        }
        // Mark as hidden supervisor task
        await grpc.updateConversationAnnotations(server.port, server.csrf, apiKey, supervisorCascadeId, {
          'antigravity.task.hidden': 'true',
          'antigravity.task.type': 'supervisor-review',
          'antigravity.task.runId': runId,
        });
      }

      // Send review prompt to the SAME conversation (accumulates context)
      await grpc.sendMessage(
        server.port, server.csrf, apiKey, supervisorCascadeId,
        reviewPrompt, SUPERVISOR_MODEL,
        false, // agenticMode = false — just answer, no tools
        undefined,
        'ARTIFACT_REVIEW_MODE_TURBO',
      );

      // 4. Poll for the model's response
      const pollStart = Date.now();
      let responseText = '';
      // Track the step count before this send, so we only look at new planner responses
      const preStepsResp = await grpc.getTrajectorySteps(server.port, server.csrf, apiKey, supervisorCascadeId);
      const preStepCount = (preStepsResp?.steps || []).filter((s: any) => s != null).length;

      while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

        const stepsResp = await grpc.getTrajectorySteps(server.port, server.csrf, apiKey, supervisorCascadeId);
        const steps = (stepsResp?.steps || []).filter((s: any) => s != null);

        // Only look at steps after our send
        for (let j = steps.length - 1; j >= preStepCount; j--) {
          const step = steps[j];
          if (step?.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
            const planner = step.plannerResponse || step.response || {};
            const text = planner.modifiedResponse || planner.response || '';
            if (text) {
              responseText = text;
              break;
            }
          }
        }
        if (responseText) break;
      }

      if (!responseText) {
        log.warn({ runId: runId.slice(0, 8), round: i }, 'Supervisor review: no response within timeout');
        continue;
      }

      // 5. Parse JSON from the model response
      let decision: SupervisorDecision;
      try {
        const jsonMatch = responseText.match(/\{[\s\S]*?\}/);
        decision = jsonMatch ? JSON.parse(jsonMatch[0]) : { status: 'HEALTHY', analysis: responseText.slice(0, 200) };
        if (!['HEALTHY', 'STUCK', 'LOOPING', 'DONE'].includes(decision.status)) {
          decision.status = 'HEALTHY';
        }
      } catch {
        decision = { status: 'HEALTHY', analysis: `(Parse failed) ${responseText.slice(0, 200)}` };
      }

      // Update comparison state for next round
      prevStepCount = currentStepCount;
      prevLastStepType = currentLastStepType;
      prevDecision = decision.status;

      // Track consecutive stuck and compute suggested action (simulate, don't execute)
      let suggestedAction: 'none' | 'nudge' | 'cancel' = 'none';
      if (decision.status === 'STUCK' || decision.status === 'LOOPING') {
        consecutiveStuck++;
        if (consecutiveStuck > consecutiveStuckPeak) consecutiveStuckPeak = consecutiveStuck;
        if (consecutiveStuck >= STUCK_CANCEL_THRESHOLD) {
          suggestedAction = 'cancel';
          suggestedActions.push(`Round ${i}: suggest cancel (${consecutiveStuck} consecutive ${decision.status})`);
        } else {
          suggestedAction = 'nudge';
          suggestedActions.push(`Round ${i}: suggest nudge (${decision.status})`);
        }
      } else {
        consecutiveStuck = 0;
      }

      // Count by status
      switch (decision.status) {
        case 'HEALTHY': healthyCount++; break;
        case 'STUCK': stuckCount++; break;
        case 'LOOPING': loopingCount++; break;
        case 'DONE': doneCount++; break;
      }

      decision.suggestedAction = suggestedAction;

      // 6. Write review result
      const review: SupervisorReview = {
        id: `rev-${Date.now()}`,
        timestamp: new Date().toISOString(),
        round: i,
        stepCount: currentStepCount,
        decision,
      };

      const currentRun = getRun(runId);
      if (currentRun) {
        const reviews = [...(currentRun.supervisorReviews || []), review];
        updateRun(runId, { supervisorReviews: reviews });
        log.info({ runId: runId.slice(0, 8), reviewRound: i, decision: decision.status, steps: currentStepCount, delta: deltaSteps }, 'Supervisor review completed');
      }
    } catch (err: any) {
      log.warn({ runId: runId.slice(0, 8), round: i, err: err.message }, 'Supervisor loop iteration failed');
    }

    if (i < MAX_REVIEWS) {
      await new Promise(r => setTimeout(r, REVIEW_INTERVAL_MS));
    }
  }

  // Write supervisor summary when loop exits
  const finalRun = getRun(runId);
  if (finalRun) {
    const totalRounds = (finalRun.supervisorReviews || []).length;
    const summary: SupervisorSummary = {
      totalRounds,
      healthyCount,
      stuckCount,
      loopingCount,
      doneCount,
      consecutiveStuckPeak,
      suggestedActions,
      startedAt: loopStartedAt,
      finishedAt: new Date().toISOString(),
    };
    updateRun(runId, { supervisorSummary: summary });
    log.info({ runId: runId.slice(0, 8), totalRounds, healthyCount, stuckCount, loopingCount, doneCount, consecutiveStuckPeak }, 'Supervisor loop finished');
  }
}

// ---------------------------------------------------------------------------
// executeSerialEnvelopeRun — unified envelope run for review-loop & delivery-single-pass
// V2: advisory review loop. V2.5: also delivery single-pass.
// ---------------------------------------------------------------------------

async function executeSerialEnvelopeRun(
  runId: string,
  group: GroupDefinition,
  server: { port: number; csrf: string; workspace?: string },
  apiKey: string,
  input: DispatchRunInput,
  finalModel: string,
  resolvedSource: ResolvedSourceContext = { sourceRuns: [], inputArtifacts: [] },
): Promise<void> {
  const shortRunId = runId.slice(0, 8);
  const goal = input.taskEnvelope?.goal || input.prompt || '';
  const wsUri = input.workspace.startsWith('file://') ? input.workspace : `file://${input.workspace}`;
  const workspacePath = input.workspace.replace(/^file:\/\//, '');
  // V3.5 Fix: Run-scoped artifact paths to prevent cross-run contamination
  const run = getRun(runId);
  const artifactDir = run?.projectId
    ? `${ARTIFACT_ROOT_DIR}/projects/${run.projectId}/runs/${runId}/`
    : `${ARTIFACT_ROOT_DIR}/runs/${runId}/`;
  const artifactAbsDir = path.join(workspacePath, artifactDir);

  updateRun(runId, {
    status: 'running',
    startedAt: new Date().toISOString(),
    artifactDir,
    currentRound: 1,
    roles: [],
  });

  const effectiveTaskEnvelope = getCanonicalTaskEnvelope(runId, input.taskEnvelope);
  const effectiveInput: DispatchRunInput = effectiveTaskEnvelope
    ? { ...input, taskEnvelope: effectiveTaskEnvelope }
    : input;

  // Shared: Write task-envelope.json + copy upstream artifacts
  if (group.capabilities?.emitsManifest) {
    writeEnvelopeFile(artifactAbsDir, 'task-envelope.json', getRun(runId)?.taskEnvelope);
  }
  if (group.capabilities?.requiresInputArtifacts) {
    const artsToCopy = resolvedSource.inputArtifacts.length > 0
      ? resolvedSource.inputArtifacts
      : (effectiveInput.taskEnvelope?.inputArtifacts || []);
    if (artsToCopy.length > 0) {
      copyUpstreamArtifacts(workspacePath, artifactAbsDir, artsToCopy, runId);
    }
  }

  // V2.5: Build work package for delivery groups
  let workPackage: DevelopmentWorkPackage | undefined;
  if (group.executionMode === 'delivery-single-pass' && group.capabilities?.delivery) {
    const archRuns = resolvedSource.sourceRuns.filter(r => r.groupId === 'architecture-advisory');
    const prodRuns = resolvedSource.sourceRuns.filter(r => r.groupId === 'product-spec');
    const archRun = archRuns[0];
    if (archRun) {
      workPackage = buildDevelopmentWorkPackage(
        runId, goal, archRun, prodRuns, resolvedSource.inputArtifacts, workspacePath, artifactAbsDir,
      );
      // Update task envelope with V2.5 active fields
      const run = getRun(runId);
      if (run?.taskEnvelope) {
        const updatedEnvelope: TaskEnvelope = {
          ...run.taskEnvelope,
          taskId: workPackage.taskId,
          requestedDeliverables: workPackage.requestedDeliverables,
          successCriteria: workPackage.successCriteria,
          governance: { reviewRequired: true },
        };
        updateRun(runId, { taskEnvelope: updatedEnvelope });
        writeEnvelopeFile(artifactAbsDir, 'task-envelope.json', updatedEnvelope);
      }
    }
  }

  try {
    if (group.executionMode === 'delivery-single-pass') {
      // ── Delivery single-pass: one role, then finalize ──────────────────
      await executeDeliverySinglePass(runId, group, server, apiKey, wsUri, goal, finalModel, effectiveInput, artifactDir, artifactAbsDir, workPackage);
    } else {
      // ── Review-loop: multi-round author/reviewer cycle ─────────────────
      await executeReviewLoop(runId, group, server, apiKey, wsUri, goal, finalModel, effectiveInput, artifactDir, artifactAbsDir);
    }
  } catch (err: any) {
    const errMsg = err.message || '';
    if (errMsg === 'timeout') {
      log.warn({ runId: shortRunId }, 'Envelope run timed out');
      propagateTermination(runId, 'timeout');
    } else if (errMsg === 'superseded') {
      log.info({ runId: shortRunId }, 'Envelope branch was superseded by a newer conversation');
    } else if (errMsg === 'cancelled') {
      log.info({ runId: shortRunId }, 'Envelope run was cancelled');
      propagateTermination(runId, 'cancelled');
    } else {
      log.error({ runId: shortRunId, err: errMsg }, 'Envelope execution failed');
      updateRun(runId, { status: 'failed', lastError: errMsg });
    }
  }
}

// ---------------------------------------------------------------------------
// executeDeliverySinglePass — V2.5 delivery exit strategy
// ---------------------------------------------------------------------------

async function executeDeliverySinglePass(
  runId: string,
  group: GroupDefinition,
  server: { port: number; csrf: string },
  apiKey: string,
  wsUri: string,
  goal: string,
  finalModel: string,
  input: DispatchRunInput,
  artifactDir: string,
  artifactAbsDir: string,
  workPackage?: DevelopmentWorkPackage,
): Promise<void> {
  const shortRunId = runId.slice(0, 8);
  const role = group.roles[0];
  const taskEnvelope = getCanonicalTaskEnvelope(runId, input.taskEnvelope);

  // Build delivery-specific prompt
  const prompt = buildDeliveryPrompt(role, goal, artifactDir, artifactAbsDir, taskEnvelope);

  const cascadeId = await createAndDispatchChild(
    server, apiKey, wsUri, runId, input.groupId, role.id,
    prompt, finalModel, input.parentConversationId,
  );

  // Record role progress
  const run = getRun(runId);
  const roles = [...(run?.roles || [])];
  const startedAt = new Date().toISOString();
  roles.push({
    roleId: role.id,
    round: 1,
    childConversationId: cascadeId,
    status: 'running',
    startedAt,
    promptSnapshot: prompt,
    promptRecordedAt: startedAt,
  });
  updateRun(runId, { roles, childConversationId: cascadeId });

  // Fire-and-forget supervisor loop
  void startSupervisorLoop(runId, cascadeId, goal, apiKey, server, wsUri);

  log.info({ runId: shortRunId, roleId: role.id, cascadeId: cascadeId.slice(0, 8) }, 'Watching delivery execution');
  const { steps, result } = await watchUntilComplete(
    runId, cascadeId, { port: server.port, csrf: server.csrf }, apiKey, role, cascadeId,
  );

  if (!isAuthoritativeConversation(getRun(runId), cascadeId)) {
    log.info({ runId: shortRunId, cascadeId: cascadeId.slice(0, 8) }, 'Skipping delivery writeback for superseded branch');
    return;
  }

  // Update role progress
  const audit = buildRoleInputReadAudit(runId, artifactDir, taskEnvelope, steps);
  const finalizedResult = enforceCanonicalInputReadProtocol(role.id, result, audit);
  const rolesAfter = getRun(runId)?.roles || [];
  if (rolesAfter.length > 0) {
    rolesAfter[rolesAfter.length - 1] = {
      ...rolesAfter[rolesAfter.length - 1],
      status: finalizedResult.status,
      finishedAt: new Date().toISOString(),
      result: finalizedResult,
      inputReadAudit: audit,
    };
    updateRun(runId, { roles: rolesAfter });
  }

  // Gate: child must complete successfully before finalization
  if (finalizedResult.status !== 'completed') {
    log.warn({ runId: shortRunId, roleId: role.id, status: finalizedResult.status }, 'Delivery child did not complete, stopping');
    propagateTermination(runId, finalizedResult.status, getFailureReason(finalizedResult));
    return;
  }

  // Finalize delivery (hard contract — missing packet = blocked)
  finalizeDeliveryRun(runId, group, artifactAbsDir, finalizedResult, workPackage);

  // Pipeline auto-trigger: dispatch next stage if this run belongs to a pipeline
  const runAfterFinalize = getRun(runId);
  if (runAfterFinalize?.status === 'completed' && runAfterFinalize.pipelineId) {
    void tryAutoTriggerNextStage(runId, group.id, input);
  }
}

// ---------------------------------------------------------------------------
// executeReviewLoop — extracted from old executeMultiRoleRun (V1.5/V2)
// ---------------------------------------------------------------------------

async function executeReviewLoop(
  runId: string,
  group: GroupDefinition,
  server: { port: number; csrf: string },
  apiKey: string,
  wsUri: string,
  goal: string,
  finalModel: string,
  input: DispatchRunInput,
  artifactDir: string,
  artifactAbsDir: string,
): Promise<void> {
  // V3.5 Bugfix: When resuming a loop via Intervention, respect the next round counter
  const initialRunState = getRun(runId);
  let round = initialRunState?.currentRound || 1;

  while (true) {
    updateRun(runId, { currentRound: round });
    const decision = await executeReviewRound(
      runId, group, server, apiKey, wsUri, goal, finalModel,
      input, artifactDir, artifactAbsDir, round, 0,
    );

    if (decision !== 'revise') return; // approved, rejected, revise-exhausted, or failed — loop ends
    round++;
  }
}

// ---------------------------------------------------------------------------
// executeReviewRound — run one round of roles starting from startRoleIndex
// Returns the review decision or 'failed' if the round couldn't complete.
// ---------------------------------------------------------------------------

type ReviewRoundResult = 'approved' | 'rejected' | 'revise' | 'revise-exhausted' | 'failed';

async function executeReviewRound(
  runId: string,
  group: GroupDefinition,
  server: { port: number; csrf: string },
  apiKey: string,
  wsUri: string,
  goal: string,
  finalModel: string,
  input: DispatchRunInput,
  artifactDir: string,
  artifactAbsDir: string,
  round: number,
  startRoleIndex: number,
): Promise<ReviewRoundResult> {
  const shortRunId = runId.slice(0, 8);
  const policy = group.reviewPolicyId ? AssetLoader.getReviewPolicy(group.reviewPolicyId) : null;
  const taskEnvelope = getCanonicalTaskEnvelope(runId, input.taskEnvelope);

  log.info({ runId: shortRunId, round, roleCount: group.roles.length, startRoleIndex }, 'Starting review round');

  for (let i = startRoleIndex; i < group.roles.length; i++) {
    const role = group.roles[i];
    const isReviewer = i === group.roles.length - 1 && group.reviewPolicyId !== undefined;

    const currentRun = getRun(runId);
    if (!currentRun || currentRun.status === 'cancelled') {
      log.info({ runId: shortRunId }, 'Run cancelled externally, stopping');
      return 'failed';
    }

    log.info({ runId: shortRunId, roleId: role.id, round, isReviewer }, 'Dispatching role');

    const rolePrompt = buildRolePrompt(role, goal, artifactDir, round, isReviewer, taskEnvelope?.inputArtifacts || []);

    const cascadeId = await createAndDispatchChild(
      server, apiKey, wsUri, runId, input.groupId, role.id,
      rolePrompt, finalModel, input.parentConversationId,
    );

    const run = getRun(runId);
    const roles = [...(run?.roles || [])];
    const startedAt = new Date().toISOString();
    const roleProgress: RoleProgress = {
      roleId: role.id,
      round,
      childConversationId: cascadeId,
      status: 'running',
      startedAt,
      promptSnapshot: rolePrompt,
      promptRecordedAt: startedAt,
    };
    roles.push(roleProgress);
    updateRun(runId, { roles, childConversationId: cascadeId });

    // V3.5 Fix: Only start supervisor on the very first role of the first round.
    // The supervisor dynamically tracks activeConversationId across role switches.
    if (round === 1 && i === 0) {
      void startSupervisorLoop(runId, cascadeId, goal, apiKey, server, wsUri);
    }

    log.info({ runId: shortRunId, roleId: role.id, round, cascadeId: cascadeId.slice(0, 8), promptLength: rolePrompt.length }, 'Watching role execution');
    const { steps, result } = await watchUntilComplete(
      runId, cascadeId, { port: server.port, csrf: server.csrf }, apiKey, role, cascadeId,
    );
    if (!isAuthoritativeConversation(getRun(runId), cascadeId)) {
      log.info({ runId: shortRunId, roleId: role.id, cascadeId: cascadeId.slice(0, 8) }, 'Skipping review-loop writeback for superseded branch');
      return 'failed';
    }
    log.info({ runId: shortRunId, roleId: role.id, round, resultStatus: result.status, summaryLength: result.summary.length, changedFiles: result.changedFiles.length }, 'Role execution completed');

    const audit = buildRoleInputReadAudit(runId, artifactDir, taskEnvelope, steps);
    const finalizedResult = enforceCanonicalInputReadProtocol(role.id, result, audit);
    const rolesAfter = getRun(runId)?.roles || [];
    const roleIdx = rolesAfter.length - 1;
    if (roleIdx >= 0) {
      rolesAfter[roleIdx] = {
        ...rolesAfter[roleIdx],
        status: finalizedResult.status,
        finishedAt: new Date().toISOString(),
        result: finalizedResult,
        inputReadAudit: audit,
      };
      updateRun(runId, { roles: rolesAfter });
    }

    if (finalizedResult.status !== 'completed') {
      log.warn({ runId: shortRunId, roleId: role.id, status: finalizedResult.status }, 'Role did not complete, stopping chain');
      propagateTermination(runId, finalizedResult.status, getFailureReason(finalizedResult));
      return 'failed';
    }

    // V2.5.1: After author role completes, validate that output files were actually created
    if (!isReviewer) {
      const outputDir = role.id.includes('architect') ? 'architecture' : 'specs';
      const outputAbsPath = path.join(artifactAbsDir, outputDir);
      const hasOutput = fs.existsSync(outputAbsPath) && fs.readdirSync(outputAbsPath).length > 0;
      if (!hasOutput) {
        log.error({ runId: shortRunId, roleId: role.id, round, expectedOutput: outputAbsPath }, 'Author role completed but produced no output files — reviewer cannot proceed');
        updateRun(runId, {
          status: 'failed',
          lastError: `Author role ${role.id} completed without producing output files in ${outputDir}/. The child conversation may have errored during file creation.`,
        });
        return 'failed';
      }
      log.info({ runId: shortRunId, roleId: role.id, round, outputDir }, 'Author output directory validated');
    }

    if (isReviewer) {
      let decision: string = extractReviewDecision(artifactAbsDir, round, steps, finalizedResult);

      // Allow policy engine to override LLM decision based on rules (e.g. max rounds)
      const runState = getRun(runId);
      if (policy && runState) {
        const engineDecision = ReviewEngine.evaluate(runState, policy);
        if (engineDecision === 'revise-exhausted' || engineDecision === 'rejected') {
          decision = engineDecision as any;
        }
      }

      const rolesDecision = getRun(runId)?.roles || [];
      const decIdx = rolesDecision.length - 1;
      if (decIdx >= 0) {
        rolesDecision[decIdx] = { ...rolesDecision[decIdx], reviewDecision: decision as any };
        updateRun(runId, { roles: rolesDecision });
      }

      log.info({ runId: shortRunId, round, decision }, 'Review decision extracted');

      if (decision === 'approved') {
        updateRun(runId, { status: 'completed', result: finalizedResult, reviewOutcome: 'approved' });
        finalizeAdvisoryRun(runId, group, artifactAbsDir, 'approved', finalizedResult);
        // Pipeline auto-trigger: dispatch next stage if this run belongs to a pipeline
        void tryAutoTriggerNextStage(runId, group.id, input);
        return 'approved';
      }
      if (decision === 'rejected') {
        updateRun(runId, { status: 'blocked', result: finalizedResult, reviewOutcome: 'rejected', lastError: 'Reviewer rejected the spec' });
        finalizeAdvisoryRun(runId, group, artifactAbsDir, 'rejected', finalizedResult);
        return 'rejected';
      }
      if (decision === 'revise-exhausted') {
        log.warn({ runId: shortRunId }, 'Review policy exhausted or forced termination');
        updateRun(runId, { status: 'blocked', reviewOutcome: 'revise-exhausted', lastError: 'Exceeded max review rounds per policy' });
        finalizeAdvisoryRun(runId, group, artifactAbsDir, 'revise-exhausted', undefined);
        return 'revise-exhausted';
      }
      return 'revise';
    }
  }

  // Should not reach here in normal flow, but handle gracefully
  return 'failed';
}

// ---------------------------------------------------------------------------
// V2: Advisory run finalization — manifest scan + result envelope
// ---------------------------------------------------------------------------

function finalizeAdvisoryRun(
  runId: string,
  group: GroupDefinition,
  artifactAbsDir: string,
  decision: string,
  result?: TaskResult,
): void {
  if (!group.capabilities?.emitsManifest) return;

  const shortRunId = runId.slice(0, 8);

  try {
    // 1. Scan artifact directory and build manifest
    const manifest = scanArtifactManifest(runId, group.templateId, artifactAbsDir);
    const manifestPath = path.join(artifactAbsDir, 'artifacts.manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    log.info({ runId: shortRunId, items: manifest.items.length }, 'Artifact manifest written');

    // 2. Build and write result envelope
    const run = getRun(runId);
    const resultEnvelope = buildResultEnvelope(run!, manifest, decision, result);
    writeEnvelopeFile(artifactAbsDir, 'result-envelope.json', resultEnvelope);

    // 3. Update run state with manifest path and result envelope
    // V3.5 Fix: Use run's artifactDir (now per-run isolated) for manifest path
    const relManifestPath = run?.artifactDir
      ? `${run.artifactDir}artifacts.manifest.json`
      : `${ARTIFACT_ROOT_DIR}/runs/${runId}/artifacts.manifest.json`;
    updateRun(runId, {
      artifactManifestPath: relManifestPath,
      resultEnvelope,
    });

    log.info({ runId: shortRunId, decision }, 'Advisory run finalized');
  } catch (err: any) {
    log.warn({ runId: shortRunId, err: err.message }, 'Failed to finalize advisory run (non-fatal)');
  }
}

// ---------------------------------------------------------------------------
// V2.5: Delivery run finalization — delivery packet + scope audit + manifest
// ---------------------------------------------------------------------------

function finalizeDeliveryRun(
  runId: string,
  group: GroupDefinition,
  artifactAbsDir: string,
  result: TaskResult,
  workPackage?: DevelopmentWorkPackage,
): void {
  const shortRunId = runId.slice(0, 8);

  try {
    // 1. Read delivery packet (HARD CONSTRAINT: missing packet = protocol violation)
    const expectedTaskId = workPackage?.taskId || getRun(runId)?.taskEnvelope?.taskId;
    const deliveryPacket = readDeliveryPacket(artifactAbsDir, shortRunId, expectedTaskId);
    if (!deliveryPacket) {
      log.error({ runId: shortRunId }, 'delivery-packet.json missing or invalid — delivery contract violated');
      updateRun(runId, {
        status: 'blocked',
        result: { ...result, status: 'blocked' },
        lastError: 'Delivery contract violated: delivery-packet.json is missing or invalid',
      });
      return;
    }

    // 2. Build scope audit
    const scopeAudit = buildWriteScopeAudit(artifactAbsDir, workPackage, result, deliveryPacket, shortRunId);

    // 3. Determine decision
    let decision: string;
    if (deliveryPacket.status === 'blocked') {
      decision = 'blocked-by-team';
    } else if (scopeAudit && !scopeAudit.withinScope && scopeAudit.outOfScopeFiles.length > 0) {
      decision = 'delivered-with-scope-warnings';
    } else {
      decision = 'delivered';
    }

    // 4. Scan manifest
    const manifest = scanArtifactManifest(runId, group.templateId, artifactAbsDir);
    const manifestPath = path.join(artifactAbsDir, 'artifacts.manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    // 5. Build result envelope with delivery-specific fields
    const run = getRun(runId);
    const resultEnvelope: ResultEnvelope = {
      templateId: group.templateId,
      runId,
      taskId: workPackage?.taskId || run?.taskEnvelope?.taskId,
      status: decision === 'blocked-by-team' ? 'blocked' : 'completed',
      decision,
      summary: deliveryPacket?.summary || result.summary,
      outputArtifacts: manifest.items,
      risks: deliveryPacket?.residualRisks || [],
      openQuestions: deliveryPacket?.openQuestions || [],
      nextAction: deliveryPacket?.status === 'blocked'
        ? `Blocked: ${deliveryPacket.blockedReason || 'unknown reason'}`
        : deliveryPacket?.followUps?.join('; '),
    };
    writeEnvelopeFile(artifactAbsDir, 'result-envelope.json', resultEnvelope);

    // 6. Update run state
    // V3.5 Fix: Use run's artifactDir (now per-run isolated) for manifest path
    const relManifestPath = run?.artifactDir
      ? `${run.artifactDir}artifacts.manifest.json`
      : `${ARTIFACT_ROOT_DIR}/runs/${runId}/artifacts.manifest.json`;
    const finalStatus = decision === 'blocked-by-team' ? 'blocked' as const : 'completed' as const;
    updateRun(runId, {
      status: finalStatus,
      result: {
        ...result,
        status: finalStatus,
        summary: deliveryPacket?.summary || result.summary,
      },
      artifactManifestPath: relManifestPath,
      resultEnvelope,
      lastError: decision === 'blocked-by-team' ? deliveryPacket?.blockedReason : undefined,
    });

    log.info({ runId: shortRunId, decision, scopeOk: scopeAudit?.withinScope }, 'Delivery run finalized');
  } catch (err: any) {
    log.error({ runId: shortRunId, err: err.message }, 'Delivery finalization failed');
    updateRun(runId, {
      status: 'blocked',
      result: { ...result, status: 'blocked' },
      lastError: `Delivery finalization error: ${err.message}`,
    });
  }
}

// ---------------------------------------------------------------------------
// V3.5: Pipeline auto-trigger — dispatch next stage when current stage completes
// ---------------------------------------------------------------------------

async function tryAutoTriggerNextStage(
  runId: string,
  currentGroupId: string,
  input: DispatchRunInput,
): Promise<void> {
  const run = getRun(runId);
  // Use templateId to look up the pipeline (template = pipeline now)
  const templateId = run?.templateId || run?.pipelineId;
  if (!templateId) return;

  const shortRunId = runId.slice(0, 8);
  const next = getNextStage(templateId, currentGroupId);
  if (!next) {
    log.info({ runId: shortRunId, templateId }, 'Pipeline completed — no next stage');
    return;
  }

  const { stage, stageIndex } = next;

  if (run?.projectId) {
    const { getProject } = require('./project-registry');
    const project = getProject(run.projectId);
    const nextStage = project?.pipelineState?.stages[stageIndex];
    if (nextStage?.runId && nextStage.status !== 'pending') {
      log.info({
        runId: shortRunId,
        stageIndex,
        nextGroupId: stage.groupId,
        existingStatus: nextStage.status,
      }, 'Downstream stage already has a canonical run, skipping auto-trigger');
      return;
    }
  }

  // Check auto-trigger flag
  if (!stage.autoTrigger) {
    log.info({ runId: shortRunId, nextGroupId: stage.groupId }, 'Next pipeline stage exists but autoTrigger is false');
    return;
  }

  // Check trigger condition
  const triggerOn = stage.triggerOn || 'approved';
  if (triggerOn === 'approved' && run!.reviewOutcome !== 'approved' && run!.status !== 'completed') {
    log.info({ runId: shortRunId, triggerOn, reviewOutcome: run!.reviewOutcome }, 'Trigger condition not met');
    return;
  }

  log.info({
    runId: shortRunId,
    templateId,
    nextGroupId: stage.groupId,
    stageIndex,
  }, 'Auto-triggering next pipeline stage');

  try {
    const nextInput: DispatchRunInput = {
      groupId: stage.groupId,
      workspace: input.workspace,
      prompt: stage.promptTemplate || run!.prompt,
      model: input.model || run!.model,
      projectId: run!.projectId,
      sourceRunIds: [runId],
      pipelineId: templateId,
      pipelineStageIndex: stageIndex,
      taskEnvelope: run!.taskEnvelope ? {
        ...run!.taskEnvelope,
        goal: stage.promptTemplate || run!.taskEnvelope.goal,
      } : undefined,
    };
    const result = await dispatchRun(nextInput);

    // V3.5 Fix 8: Track dispatch via unified helper
    if (run!.projectId && result?.runId) {
      const { addRunToProject, trackStageDispatch } = require('./project-registry');
      addRunToProject(run!.projectId, result.runId);
      trackStageDispatch(run!.projectId, stageIndex, result.runId);
    }
  } catch (err: any) {
    log.error({ runId: shortRunId, nextGroupId: stage.groupId, err: err.message }, 'Failed to auto-trigger next pipeline stage');
  }
}

// ---------------------------------------------------------------------------
// V2.5: Read & validate delivery-packet.json
// ---------------------------------------------------------------------------

function readDeliveryPacket(
  artifactAbsDir: string,
  shortRunId: string,
  expectedTaskId?: string,
): DevelopmentDeliveryPacket | undefined {
  const packetPath = path.join(artifactAbsDir, 'delivery', 'delivery-packet.json');
  try {
    if (!fs.existsSync(packetPath)) {
      log.error({ runId: shortRunId }, 'delivery-packet.json not found');
      return undefined;
    }
    const raw = JSON.parse(fs.readFileSync(packetPath, 'utf-8'));

    // Required fields (must match DevelopmentDeliveryPacket type)
    if (!raw.status || !raw.summary || !raw.taskId || !raw.changedFiles) {
      log.error({ runId: shortRunId }, 'delivery-packet.json missing required fields (status, summary, taskId, changedFiles)');
      return undefined;
    }

    // Validate status enum
    if (raw.status !== 'completed' && raw.status !== 'blocked') {
      log.error({ runId: shortRunId, status: raw.status }, 'delivery-packet.json has invalid status (must be completed|blocked)');
      return undefined;
    }

    // blocked MUST have blockedReason
    if (raw.status === 'blocked' && !raw.blockedReason) {
      log.error({ runId: shortRunId }, 'delivery-packet.json has blocked status but no blockedReason — protocol violation');
      return undefined;
    }

    // taskId cross-check
    if (expectedTaskId && raw.taskId !== expectedTaskId) {
      log.error({ runId: shortRunId, expected: expectedTaskId, got: raw.taskId }, 'delivery-packet.json taskId mismatch — possible cross-contamination');
      return undefined;
    }

    // changedFiles must be array
    if (!Array.isArray(raw.changedFiles)) {
      log.error({ runId: shortRunId }, 'delivery-packet.json changedFiles is not an array');
      return undefined;
    }

    return raw as DevelopmentDeliveryPacket;
  } catch (err: any) {
    log.error({ runId: shortRunId, err: err.message }, 'Failed to parse delivery-packet.json');
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// V2.5: Build scope audit (soft check, does not block)
// ---------------------------------------------------------------------------

function buildWriteScopeAudit(
  artifactAbsDir: string,
  workPackage: DevelopmentWorkPackage | undefined,
  result: TaskResult,
  deliveryPacket: DevelopmentDeliveryPacket | undefined,
  shortRunId: string,
): WriteScopeAudit | undefined {
  if (!workPackage || workPackage.allowedWriteScope.length === 0) {
    return undefined;
  }

  try {
    const declaredPaths = workPackage.allowedWriteScope.map(s => s.path);
    const observedChangedFiles = result.changedFiles || [];
    const reportedChangedFiles = deliveryPacket?.changedFiles || [];
    const effectiveChangedFiles = [...new Set([...observedChangedFiles, ...reportedChangedFiles])];

    const outOfScopeFiles = effectiveChangedFiles.filter(f => {
      return !declaredPaths.some(dp => f.includes(dp) || dp.includes(f));
    });

    const audit: WriteScopeAudit = {
      taskId: workPackage.taskId,
      withinScope: outOfScopeFiles.length === 0,
      declaredScopeCount: declaredPaths.length,
      observedChangedFiles,
      reportedChangedFiles,
      effectiveChangedFiles,
      outOfScopeFiles,
    };

    // Write scope audit
    const deliveryDir = path.join(artifactAbsDir, 'delivery');
    if (!fs.existsSync(deliveryDir)) fs.mkdirSync(deliveryDir, { recursive: true });
    fs.writeFileSync(path.join(deliveryDir, 'scope-audit.json'), JSON.stringify(audit, null, 2), 'utf-8');
    log.info({ runId: shortRunId, withinScope: audit.withinScope, outOfScope: outOfScopeFiles.length }, 'Scope audit written');

    return audit;
  } catch (err: any) {
    log.warn({ runId: shortRunId, err: err.message }, 'Failed to build scope audit');
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// V2: Scan artifact directory to build manifest (recursive)
// ---------------------------------------------------------------------------

function scanArtifactManifest(
  runId: string,
  templateId: string,
  artifactAbsDir: string,
): ArtifactManifest {
  const items: ArtifactRef[] = [];
  const allowedExtensions = new Set(['.md', '.json', '.txt']);

  // M3: Scan whitelist directories recursively
  const scanDirs = [
    { dir: 'specs', kindPrefix: 'product' },
    { dir: 'architecture', kindPrefix: 'architecture' },
    { dir: 'review', kindPrefix: 'review' },
    { dir: 'delivery', kindPrefix: 'delivery' },
    // work-package is runtime-generated input, NOT delivery output — excluded from manifest
  ];

  function scanRecursive(baseDirPath: string, kindPrefix: string): void {
    if (!fs.existsSync(baseDirPath)) return;
    try {
      const entries = fs.readdirSync(baseDirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(baseDirPath, entry.name);
        if (entry.isDirectory()) {
          scanRecursive(fullPath, kindPrefix);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (!allowedExtensions.has(ext)) continue;

          const baseName = path.basename(entry.name, ext);
          const relPath = path.relative(artifactAbsDir, fullPath);
          const kind = `${kindPrefix}.${baseName}`;

          items.push({
            id: randomUUID(),
            kind,
            title: baseName.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            path: relPath,
            format: ext.slice(1) as 'md' | 'json' | 'txt',
            sourceRunId: runId,
          });
        }
      }
    } catch {
      // Directory read failed, skip
    }
  }

  for (const { dir, kindPrefix } of scanDirs) {
    scanRecursive(path.join(artifactAbsDir, dir), kindPrefix);
  }

  return { runId, templateId, items };
}

// ---------------------------------------------------------------------------
// V2/H1: Copy upstream artifacts into current run's input/ directory
// ---------------------------------------------------------------------------

function copyUpstreamArtifacts(
  workspacePath: string,
  artifactAbsDir: string,
  inputArtifacts: ArtifactRef[],
  runId: string,
): void {
  const shortRunId = runId.slice(0, 8);
  const inputDir = path.join(artifactAbsDir, 'input');

  try {
    if (!fs.existsSync(inputDir)) {
      fs.mkdirSync(inputDir, { recursive: true });
    }

    for (const art of inputArtifacts) {
      if (!art.sourceRunId) continue;
      const srcRun = getRun(art.sourceRunId);
      if (!srcRun?.artifactDir) continue;

      const srcPath = path.join(workspacePath, srcRun.artifactDir, art.path);
      if (!fs.existsSync(srcPath)) {
        log.warn({ runId: shortRunId, srcPath: art.path }, 'Source artifact not found, skipping copy');
        continue;
      }

      // Copy to input/<sourceRunId-short>/<original-path>
      const destDir = path.join(inputDir, art.sourceRunId.slice(0, 8));
      const destPath = path.join(destDir, art.path);
      const destParent = path.dirname(destPath);
      if (!fs.existsSync(destParent)) {
        fs.mkdirSync(destParent, { recursive: true });
      }
      fs.copyFileSync(srcPath, destPath);
      log.debug({ runId: shortRunId, src: art.path }, 'Upstream artifact copied');
    }

    log.info({ runId: shortRunId, count: inputArtifacts.length }, 'Upstream artifacts copied to input/');
  } catch (err: any) {
    log.warn({ runId: shortRunId, err: err.message }, 'Failed to copy upstream artifacts (non-fatal)');
  }
}

// ---------------------------------------------------------------------------
// V2: Build ResultEnvelope from run state + manifest
// ---------------------------------------------------------------------------

function buildResultEnvelope(
  run: AgentRunState,
  manifest: ArtifactManifest,
  decision: string,
  result?: TaskResult,
): ResultEnvelope {
  return {
    templateId: run.templateId || manifest.templateId,
    runId: run.runId,
    status: run.status,
    decision,
    summary: result?.summary || run.result?.summary || 'Advisory run completed',
    outputArtifacts: manifest.items,
    risks: [],
    nextAction: decision === 'approved'
      ? 'Ready for next phase'
      : decision === 'rejected'
        ? 'Requires re-evaluation'
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// V2: Helper to write envelope JSON files
// ---------------------------------------------------------------------------

function writeEnvelopeFile(artifactAbsDir: string, filename: string, data: unknown): void {
  try {
    if (!fs.existsSync(artifactAbsDir)) {
      fs.mkdirSync(artifactAbsDir, { recursive: true });
    }
    fs.writeFileSync(path.join(artifactAbsDir, filename), JSON.stringify(data, null, 2), 'utf-8');
  } catch (err: any) {
    log.warn({ filename, err: err.message }, 'Failed to write envelope file');
  }
}

function getCanonicalTaskEnvelope(runId: string, fallback?: TaskEnvelope): TaskEnvelope | undefined {
  return getRun(runId)?.taskEnvelope || fallback;
}

function getCopiedArtifactPath(artifact: ArtifactRef): string {
  const shortSrcId = artifact.sourceRunId?.slice(0, 8) || 'unknown';
  return `input/${shortSrcId}/${artifact.path}`;
}

function normalizeComparablePath(value: string | undefined): string {
  if (!value) return '';
  let normalized = value.trim();
  if (normalized.startsWith('file://')) {
    normalized = normalized.replace(/^file:\/\//, '');
  }
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep original if URI decoding fails
  }
  return path.normalize(normalized).replace(/\\/g, '/');
}

function includesPathCandidate(haystack: string, candidate: string): boolean {
  if (!haystack || !candidate) return false;
  return haystack.replace(/\\/g, '/').includes(candidate.replace(/\\/g, '/'));
}

function extractStepReadEvidence(steps: any[]): RoleReadEvidence[] {
  const evidence: RoleReadEvidence[] = [];

  steps.forEach((step, stepIndex) => {
    const stepType = typeof step?.type === 'string' ? step.type : 'unknown';
    const viewTarget = step?.viewFile?.absoluteUri || step?.viewFile?.absolutePathUri || step?.viewFile?.absolutePath;
    if (typeof viewTarget === 'string' && viewTarget.trim()) {
      evidence.push({ stepIndex, stepType, target: viewTarget });
    }

    const commandTarget = step?.runCommand?.commandLine || step?.runCommand?.command;
    if (typeof commandTarget === 'string' && commandTarget.trim()) {
      evidence.push({ stepIndex, stepType, target: commandTarget });
    }
  });

  return evidence;
}

function filterEvidenceByCandidates(evidence: RoleReadEvidence[], candidates: string[]): RoleReadEvidence[] {
  const normalizedCandidates = candidates
    .map(candidate => normalizeComparablePath(candidate))
    .filter(Boolean);

  return evidence.filter((item) => {
    const normalizedTarget = normalizeComparablePath(item.target);
    return normalizedCandidates.some((candidate) =>
      normalizedTarget === candidate
      || includesPathCandidate(item.target, candidate)
      || includesPathCandidate(normalizedTarget, candidate));
  });
}

function dedupeStringList(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function buildRoleInputReadAudit(
  runId: string,
  artifactDir: string,
  taskEnvelope: TaskEnvelope | undefined,
  steps: any[],
): RoleInputReadAudit | undefined {
  const run = getRun(runId);
  if (!run) return undefined;

  const workspacePath = run.workspace.replace(/^file:\/\//, '');
  const taskEnvelopeRelPath = `${artifactDir}task-envelope.json`;
  const taskEnvelopeAbsPath = path.join(workspacePath, taskEnvelopeRelPath);
  const evidence = extractStepReadEvidence(steps);
  const taskEnvelopeEvidence = filterEvidenceByCandidates(evidence, [taskEnvelopeAbsPath, taskEnvelopeRelPath]);
  const inputArtifacts = taskEnvelope?.inputArtifacts || [];

  if (inputArtifacts.length === 0) {
    return {
      status: 'not_applicable',
      auditedAt: new Date().toISOString(),
      taskEnvelopePath: taskEnvelopeRelPath,
      taskEnvelopeRead: taskEnvelopeEvidence.length > 0,
      taskEnvelopeEvidence,
      requiredArtifactCount: 0,
      canonicalReadCount: 0,
      alternateReadCount: 0,
      missingCanonicalPaths: [],
      summary: 'No canonical input artifacts were required for this role.',
      entries: [],
    };
  }

  const entries: InputArtifactReadAuditEntry[] = inputArtifacts.map((artifact) => {
    const canonicalRelPath = `${artifactDir}${getCopiedArtifactPath(artifact)}`;
    const canonicalAbsPath = path.join(workspacePath, canonicalRelPath);
    const canonicalEvidence = filterEvidenceByCandidates(evidence, [canonicalAbsPath, canonicalRelPath]);

    const alternateCandidates: string[] = [];
    if (artifact.sourceRunId) {
      const sourceRun = getRun(artifact.sourceRunId);
      if (sourceRun?.artifactDir) {
        const sourceRelPath = `${sourceRun.artifactDir}${artifact.path}`;
        const sourceAbsPath = path.join(workspacePath, sourceRelPath);
        alternateCandidates.push(sourceAbsPath, sourceRelPath);
      }
    }

    const alternateEvidence = filterEvidenceByCandidates(evidence, alternateCandidates).filter((item) =>
      !canonicalEvidence.some((match) =>
        match.stepIndex === item.stepIndex
        && match.stepType === item.stepType
        && match.target === item.target));

    return {
      artifactId: artifact.id,
      title: artifact.title,
      kind: artifact.kind,
      sourceRunId: artifact.sourceRunId,
      originalPath: artifact.path,
      canonicalPath: canonicalRelPath,
      canonicalRead: canonicalEvidence.length > 0,
      evidence: canonicalEvidence,
      alternateReadPaths: dedupeStringList(alternateEvidence.map(item => item.target)),
    };
  });

  const canonicalReadCount = entries.filter(entry => entry.canonicalRead).length;
  const alternateReadCount = entries.filter(entry => (entry.alternateReadPaths || []).length > 0).length;
  const missingCanonicalPaths = entries
    .filter(entry => !entry.canonicalRead)
    .map(entry => entry.canonicalPath);

  const status = canonicalReadCount === inputArtifacts.length
    ? 'verified'
    : canonicalReadCount > 0
      ? 'partial'
      : 'missing';

  const summaryParts = [
    `Canonical inputs read: ${canonicalReadCount}/${inputArtifacts.length}.`,
    taskEnvelopeEvidence.length > 0 ? 'Task envelope read: yes.' : 'Task envelope read: no.',
  ];
  if (alternateReadCount > 0) {
    summaryParts.push(`Alternate/source-path reads observed for ${alternateReadCount} artifact(s).`);
  }
  if (missingCanonicalPaths.length > 0) {
    summaryParts.push(`Missing canonical reads: ${missingCanonicalPaths.join(', ')}.`);
  }

  return {
    status,
    auditedAt: new Date().toISOString(),
    taskEnvelopePath: taskEnvelopeRelPath,
    taskEnvelopeRead: taskEnvelopeEvidence.length > 0,
    taskEnvelopeEvidence,
    requiredArtifactCount: inputArtifacts.length,
    canonicalReadCount,
    alternateReadCount,
    missingCanonicalPaths,
    summary: summaryParts.join(' '),
    entries,
  };
}

function enforceCanonicalInputReadProtocol(
  roleId: string,
  result: TaskResult,
  audit: RoleInputReadAudit | undefined,
): TaskResult {
  if (!audit || result.status !== 'completed' || audit.status === 'not_applicable' || audit.status === 'verified') {
    return result;
  }

  const violation = audit.missingCanonicalPaths.length > 0
    ? `Protocol violation: role ${roleId} did not read required canonical input artifacts from this run: ${audit.missingCanonicalPaths.join(', ')}`
    : `Protocol violation: role ${roleId} did not verify required canonical input artifact reads.`;

  const blockers = dedupeStringList([...(result.blockers || []), violation, audit.summary]);
  const summary = result.summary ? `${result.summary}\n\n${violation}` : violation;

  return {
    ...result,
    status: 'blocked',
    summary,
    blockers,
  };
}

function formatPromptArtifactLines(artifactDir: string, inputArtifacts: ArtifactRef[]): string[] {
  if (inputArtifacts.length === 0) {
    return ['- None were provided. If you need upstream inputs and cannot find them, stop and report blocked.'];
  }

  return inputArtifacts.map((artifact, index) => {
    const label = artifact.title || artifact.kind || artifact.path;
    const copiedPath = `${artifactDir}${getCopiedArtifactPath(artifact)}`;
    const sourceSuffix = artifact.sourceRunId ? `; sourceRunId=${artifact.sourceRunId}` : '';
    return `- [${index + 1}] ${label} (${artifact.kind}) -> ${copiedPath}${sourceSuffix}`;
  });
}

// ---------------------------------------------------------------------------
// buildRolePrompt — construct the workflow prompt for each role
// ---------------------------------------------------------------------------

function buildRolePrompt(
  role: GroupRoleDefinition,
  originalPrompt: string,
  artifactDir: string,
  round: number,
  isReviewer: boolean,
  inputArtifacts: ArtifactRef[] = [],
): string {
  const taskEnvelopePath = `${artifactDir}task-envelope.json`;
  const outputDir = role.id.includes('architect') ? 'architecture' : 'specs';
  const reviewPrefix = role.id.includes('architecture') ? 'architecture-' : '';
  const inputArtifactLines = formatPromptArtifactLines(artifactDir, inputArtifacts);

  const workflowContent = AssetLoader.resolveWorkflowContent(role.workflow);
  const sharedIntro = [
    workflowContent,
    '',
    'Stage context',
    `- Task envelope: ${taskEnvelopePath}`,
    '- Workspace root: use the current workspace root as cwd.',
    '',
    'Canonical upstream inputs',
    ...inputArtifactLines,
    '',
    'Execution rules',
    '- Read the task envelope first, then every canonical upstream input listed above before planning.',
    '- Treat the copied input artifacts above as the authoritative upstream deliverables for this stage.',
    '- Prefer the copied files under this run over searching for alternate copies elsewhere in the workspace.',
    '- If any required input file is missing or inconsistent, stop and report blocked instead of guessing.',
    '- Preserve explicit tradeoffs and constraints from the upstream spec in your output.',
  ];

  if (isReviewer) {
    return [
      ...sharedIntro,
      '',
      'Review assignment',
      `- Review target directory: ${artifactDir}${reviewPrefix ? 'architecture' : 'specs'}/`,
      `- Review round: ${round}`,
      `- Write review markdown to: ${artifactDir}review/${reviewPrefix}review-round-${round}.md`,
      `- Write decision JSON to: ${artifactDir}review/result-round-${round}.json`,
      '- The decision JSON must include a "decision" field with exactly one of: "approved", "revise", "rejected".',
      '- Review both the generated specs and the canonical upstream inputs before deciding.',
      '',
      'Original goal',
      originalPrompt,
    ].join('\n');
  }

  if (round === 1) {
    return [
      ...sharedIntro,
      '',
      'Author assignment',
      `- Write specs to: ${artifactDir}${outputDir}/`,
      '- Produce concrete, implementation-driving decisions. Avoid vague recommendations.',
      '- Use the canonical upstream inputs above as the source of truth for this stage.',
      '',
      'Original goal',
      originalPrompt,
    ].join('\n');
  }

  return [
    ...sharedIntro,
    '',
    'Revision assignment',
    `- Revision round: ${round}`,
    `- Read reviewer feedback from: ${artifactDir}review/${reviewPrefix}review-round-${round - 1}.md`,
    `- Update specs in: ${artifactDir}${outputDir}/`,
    '- Address every reviewer concern explicitly and keep the upstream constraints intact.',
    '',
    'Original goal',
    originalPrompt,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// V2.5: buildDeliveryPrompt — construct the workflow prompt for delivery runs
// ---------------------------------------------------------------------------

function buildDeliveryPrompt(
  role: GroupRoleDefinition,
  originalPrompt: string,
  artifactDir: string,
  artifactAbsDir: string,
  taskEnvelope?: TaskEnvelope,
): string {
  const wpPath = `${artifactDir}work-package/work-package.json`;
  const inputDir = `${artifactDir}input/`;
  const taskEnvelopePath = `${artifactDir}task-envelope.json`;
  const inputArtifactLines = formatPromptArtifactLines(artifactDir, taskEnvelope?.inputArtifacts || []);

  // Check if work package exists for more specific instructions
  const wpAbsPath = path.join(artifactAbsDir, 'work-package', 'work-package.json');
  const hasWorkPackage = fs.existsSync(wpAbsPath);

  if (hasWorkPackage) {
    return [
      AssetLoader.resolveWorkflowContent(role.workflow),
      '',
      'Stage context',
      `- Task envelope: ${taskEnvelopePath}`,
      `- Work package: ${wpPath}`,
      `- Input directory root: ${inputDir}`,
      '',
      'Canonical upstream inputs',
      ...inputArtifactLines,
      '',
      'Delivery assignment',
      '- Read the work package first, then the task envelope, then every canonical upstream input listed above.',
      '- Implement all requested changes in the workspace codebase.',
      `- Write delivery artifacts to: ${artifactDir}delivery/`,
      '- You MUST create: delivery/delivery-packet.json, delivery/implementation-summary.md, and delivery/test-results.md.',
      '- If a required upstream artifact is missing, report blocked instead of inferring requirements from memory.',
      '',
      'Original goal',
      originalPrompt,
    ].join('\n');
  }

  return [
    AssetLoader.resolveWorkflowContent(role.workflow),
    '',
    'Stage context',
    `- Task envelope: ${taskEnvelopePath}`,
    `- Input directory root: ${inputDir}`,
    '',
    'Canonical upstream inputs',
    ...inputArtifactLines,
    '',
    'Delivery assignment',
    `- Write your delivery artifacts to: ${artifactDir}delivery/`,
    '- You MUST create: delivery/delivery-packet.json (with status, summary, changedFiles, tests fields), delivery/implementation-summary.md, and delivery/test-results.md.',
    '- Read the task envelope and canonical upstream inputs before implementation.',
    '',
    'Original goal',
    originalPrompt,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// extractReviewDecision — parse DECISION marker from review file then steps
// ---------------------------------------------------------------------------

function extractReviewDecision(
  artifactAbsDir: string,
  round: number,
  steps: any[],
  result: TaskResult,
): ReviewDecision {
  // 1. Primary: Try reading round-scoped result-round-N.json
  const roundResultPath = path.join(artifactAbsDir, 'review', `result-round-${round}.json`);
  const legacyResultPath = path.join(artifactAbsDir, 'review', 'result.json');

  // Try round-scoped first, then legacy only for round 1 (backward compat)
  const pathsToTry = [roundResultPath];
  if (round === 1) pathsToTry.push(legacyResultPath);

  for (const resultJsonPath of pathsToTry) {
    try {
      if (fs.existsSync(resultJsonPath)) {
        const data = JSON.parse(fs.readFileSync(resultJsonPath, 'utf-8'));
        if (data.decision && typeof data.decision === 'string') {
          const decisionLower = data.decision.toLowerCase();
          if (['approved', 'revise', 'rejected'].includes(decisionLower)) {
            return decisionLower as ReviewDecision;
          }
        }
      }
    } catch {
      // Silent fail, fallback to other methods
    }
  }

  // 2. Secondary: If result object has decision directly
  if (result?.decision && typeof result.decision === 'string') {
    const decisionLower = result.decision.toLowerCase();
    if (['approved', 'revise', 'rejected'].includes(decisionLower)) {
      return decisionLower as ReviewDecision;
    }
  }

  // 3. Fallback: Parse Markdown markers for legacy runs
  const reviewPatterns = [
    path.join(artifactAbsDir, 'review', `review-round-${round}.md`),
    path.join(artifactAbsDir, 'review', `architecture-review-round-${round}.md`),
  ];

  for (const reviewPath of reviewPatterns) {
    try {
      if (fs.existsSync(reviewPath)) {
        const content = fs.readFileSync(reviewPath, 'utf-8');
        const decision = parseDecisionMarker(content);
        if (decision) return decision;
      }
    } catch {
      // File read failed, try next
    }
  }

  // Fallback: scan raw steps for DECISION marker
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step?.type !== 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') continue;
    const planner = step.plannerResponse || step.response || {};
    const text = planner.modifiedResponse || planner.response || '';
    const decision = parseDecisionMarker(text);
    if (decision) return decision;
  }

  // M1: No summary fallback — summary is not an authoritative decision carrier.
  // If no decision found in review file or steps, it's a protocol violation.
  throw new Error('Missing explicit review decision (no DECISION: marker found in review file or conversation steps)');
}

function parseDecisionMarker(text: string): ReviewDecision | null {
  // Matches "DECISION:" optionally wrapped in bold/newlines, followed by APPROVED/REVISE/REJECTED
  // This handles "**DECISION:** APPROVED", "DECISION:  REVISE.", etc.
  const match = text.match(/DECISION:\s*\**\s*(APPROVED|REVISE|REJECTED)/i);

  if (!match) return null;

  const decision = match[1].toUpperCase();
  if (decision === 'APPROVED') return 'approved';
  if (decision === 'REVISE') return 'revise';
  if (decision === 'REJECTED') return 'rejected';

  return null;
}

// ---------------------------------------------------------------------------
// propagateTermination — mark run and pending roles on failure
// ---------------------------------------------------------------------------

function summarizeFailureText(text?: string): string | undefined {
  if (!text) return undefined;
  const firstMeaningfulLine = text
    .split('\n')
    .map(line => line.trim().replace(/^#+\s*/, ''))
    .find(line => line.length > 0);

  if (!firstMeaningfulLine) return undefined;
  return firstMeaningfulLine.length > 240
    ? `${firstMeaningfulLine.slice(0, 237)}...`
    : firstMeaningfulLine;
}

function getFailureReason(result: TaskResult): string | undefined {
  return result.blockers[0] || summarizeFailureText(result.summary);
}

function propagateTermination(
  runId: string,
  failStatus: 'failed' | 'blocked' | 'cancelled' | 'timeout',
  lastError?: string,
): void {
  const run = getRun(runId);
  if (run?.roles) {
    for (const role of run.roles) {
      if (role.status === 'queued' || role.status === 'starting') {
        role.status = 'cancelled';
      }
    }
    updateRun(runId, { roles: run.roles });
  }
  updateRun(runId, {
    status: failStatus,
    lastError: lastError ?? run?.lastError ?? (failStatus === 'timeout' ? 'Role exceeded timeout limit' : undefined),
  });
}

// ---------------------------------------------------------------------------
// handleAutoApprove — approve blocking artifacts automatically
// ---------------------------------------------------------------------------

async function handleAutoApprove(
  steps: any[],
  cascadeId: string,
  conn: { port: number; csrf: string },
  apiKey: string,
  runId: string,
): Promise<void> {
  const shortRunId = runId.slice(0, 8);

  for (const step of steps) {
    if (step?.type !== 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') continue;

    const planner = step.plannerResponse || step.response || {};
    const isBlocking = planner.isBlocking === true;
    if (!isBlocking) continue;

    if (step._autoApproved) continue;

    const reviewUris: string[] = [];
    if (planner.reviewAbsoluteUris?.length) {
      reviewUris.push(...planner.reviewAbsoluteUris);
    } else if (planner.pathsToReview?.length) {
      reviewUris.push(...planner.pathsToReview.map((p: string) => `file://${p}`));
    }

    if (reviewUris.length > 0) {
      log.info({ runId: shortRunId, uriCount: reviewUris.length }, 'Auto-approving artifacts');
      for (const uri of reviewUris) {
        try {
          await grpc.proceedArtifact(conn.port, conn.csrf, apiKey, cascadeId, uri);
          log.debug({ runId: shortRunId, uri: uri.split('/').pop() }, 'Artifact approved');
        } catch (err: any) {
          log.warn({ runId: shortRunId, uri, err: err.message }, 'Artifact approve failed');
        }
      }
      step._autoApproved = true;
    } else if (isBlocking) {
      log.info({ runId: shortRunId }, 'Run blocked: isBlocking=true with no artifact URIs');
      updateRun(runId, { status: 'blocked' });
      cleanup(runId);
    }
  }
}

// ---------------------------------------------------------------------------
// handleCompletion — extract result when child goes idle (single-role)
// ---------------------------------------------------------------------------

function handleCompletion(runId: string, steps: any[]): void {
  const shortRunId = runId.slice(0, 8);
  const currentRun = getRun(runId);
  if (!currentRun || currentRun.status !== 'running') return;

  const run = getRun(runId);
  const absDir = run?.artifactDir ? path.join((run.workspace || '').replace(/^file:\/\//, ''), run.artifactDir) : undefined;
  const result = compactCodingResult(steps, absDir);
  log.info({
    runId: shortRunId,
    status: result.status,
    changedFiles: result.changedFiles.length,
    summaryLength: result.summary.length,
    source: absDir ? 'result.json or step-parse' : 'step-parse only',
  }, 'Run completed');

  updateRun(runId, { status: result.status, result });

  // Sync pipeline state for legacy-single runs (same as envelope path)
  if (run?.projectId && run.pipelineStageIndex !== undefined) {
    const { updatePipelineStage } = require('./project-registry');
    const stageStatus = result.status === 'completed' ? 'completed'
      : result.status === 'blocked' ? 'blocked' : 'failed';
    updatePipelineStage(run.projectId, run.pipelineStageIndex, {
      status: stageStatus,
      runId,
    });
  }

  cleanup(runId);
}

// ---------------------------------------------------------------------------
// compactCodingResult
// ---------------------------------------------------------------------------

/**
 * V3: Try to read a structured result.json from the artifact directory.
 * Returns a TaskResult if found and valid, or null if not found or malformed.
 */
function getResultJsonCandidates(
  artifactAbsDir: string,
  roleConfig?: GroupRoleDefinition,
): string[] {
  const candidates: string[] = [];

  if (roleConfig?.id.includes('author')) {
    const outputDir = roleConfig.id.includes('architect') ? 'architecture' : 'specs';
    candidates.push(path.join(artifactAbsDir, outputDir, 'result.json'));
  }

  candidates.push(path.join(artifactAbsDir, 'result.json'));

  return [...new Set(candidates)];
}

function tryReadResultJson(
  artifactAbsDir: string,
  roleConfig?: GroupRoleDefinition,
): TaskResult | null {
  try {
    for (const resultPath of getResultJsonCandidates(artifactAbsDir, roleConfig)) {
      if (!fs.existsSync(resultPath)) continue;

      const raw = fs.readFileSync(resultPath, 'utf-8');
      const data = JSON.parse(raw);

      // Validate required fields
      if (!data.status || !data.summary) {
        log.warn({ resultPath, keys: Object.keys(data) }, 'result.json exists but missing required fields (status/summary)');
        continue;
      }

      const validStatuses = ['completed', 'blocked', 'failed'];
      const status = validStatuses.includes(data.status) ? data.status : 'completed';

      log.info({
        resultPath: path.relative(artifactAbsDir, resultPath) || 'result.json',
        artifactAbsDir: artifactAbsDir.split('/').slice(-3).join('/'),
        status,
        changedFiles: (data.changedFiles || []).length,
        summaryLength: data.summary.length,
      }, 'result.json found — using structured result');

      return {
        status,
        summary: data.summary,
        changedFiles: data.changedFiles || [],
        blockers: data.blockedReason ? [data.blockedReason] : [],
        needsReview: data.outputArtifacts || [],
      };
    }

    return null;
  } catch (err: any) {
    log.warn({ artifactAbsDir, err: err.message }, 'result.json exists but failed to parse');
    return null;
  }
}

export function compactCodingResult(
  steps: any[],
  artifactAbsDir?: string,
  roleConfig?: GroupRoleDefinition,
): TaskResult {
  // V3: Try structured result.json first
  if (artifactAbsDir) {
    const jsonResult = tryReadResultJson(artifactAbsDir, roleConfig);
    if (jsonResult) return jsonResult;
    log.debug({ artifactAbsDir: artifactAbsDir.split('/').slice(-3).join('/') }, 'No result.json found — falling back to step parsing');
  }

  let summary = '';
  const changedFiles = new Set<string>();
  const blockers: string[] = [];
  const needsReview: string[] = [];
  let hasErrorMessage = false;

  // V2.5.1: Check for ERROR_MESSAGE steps — only mark failed if the agent
  // did NOT recover (i.e. no successful PLANNER_RESPONSE or CODE_ACTION after the last error)
  let lastErrorIndex = -1;
  for (let i = 0; i < steps.length; i++) {
    if (steps[i]?.type === 'CORTEX_STEP_TYPE_ERROR_MESSAGE') {
      lastErrorIndex = i;
    }
  }
  if (lastErrorIndex >= 0) {
    // Check if agent recovered after the last error
    let recovered = false;
    for (let i = lastErrorIndex + 1; i < steps.length; i++) {
      const t = steps[i]?.type;
      if (t === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' || t === 'CORTEX_STEP_TYPE_CODE_ACTION') {
        recovered = true;
        break;
      }
    }
    hasErrorMessage = !recovered;
  }

  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step?.type !== 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') continue;

    const planner = step.plannerResponse || step.response || {};
    const plannerStatus = planner.status || step.status || '';

    if (plannerStatus === 'DONE' || plannerStatus === 'STATUS_DONE') {
      const text = planner.modifiedResponse || planner.response || '';
      if (text.trim()) {
        summary = text.trim();
        break;
      }
    }
  }

  if (!summary) {
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i];
      if (step?.type !== 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') continue;
      const planner = step.plannerResponse || step.response || {};
      const text = planner.modifiedResponse || planner.response || '';
      if (text.trim()) {
        summary = text.trim();
        break;
      }
    }
  }

  for (const step of steps) {
    if (step?.type === 'CORTEX_STEP_TYPE_CODE_ACTION') {
      const action = step.codeAction || step.actionSpec || {};
      const spec = action.actionSpec || action;

      for (const key of Object.keys(spec)) {
        const sub = spec[key];
        if (sub?.absoluteUri) {
          changedFiles.add(sub.absoluteUri.replace(/^file:\/\//, ''));
        }
        if (sub?.uri) {
          changedFiles.add(sub.uri.replace(/^file:\/\//, ''));
        }
      }

      if (action.absoluteUri) {
        changedFiles.add(action.absoluteUri.replace(/^file:\/\//, ''));
      }
    }
  }

  for (const step of steps) {
    if (step?.type !== 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') continue;

    const planner = step.plannerResponse || step.response || {};
    if (planner.isBlocking && !step._autoApproved) {
      const blockerText = planner.modifiedResponse || planner.response || 'Blocking notification';
      blockers.push(blockerText.slice(0, 200));
    }

    if (planner.reviewAbsoluteUris?.length) {
      needsReview.push(...planner.reviewAbsoluteUris);
    }
    if (planner.pathsToReview?.length) {
      needsReview.push(...planner.pathsToReview);
    }
  }

  return {
    status: hasErrorMessage ? 'failed' : (blockers.length > 0 ? 'blocked' : 'completed'),
    summary: summary || (hasErrorMessage ? 'Task failed due to an error in the child conversation' : 'Task completed (no summary extracted)'),
    changedFiles: [...changedFiles],
    blockers,
    needsReview: [...new Set(needsReview)],
  };
}

// ---------------------------------------------------------------------------
// cancelRun
// ---------------------------------------------------------------------------

export async function cancelRun(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (run.status === 'cancelled' || run.status === 'completed') {
    throw new Error(`Run ${runId} is already ${run.status}`);
  }

  const activeCascadeId = run.activeConversationId || run.childConversationId;
  if (activeCascadeId) {
    const conn = getOwnerConnection(activeCascadeId);
    const apiKey = getApiKey();
    if (conn) {
      await cancelRunInternal(runId, activeCascadeId, conn, apiKey, 'cancelled');
      return;
    }
  }

  if (run.projectId && run.pipelineStageIndex !== undefined) {
    const { updatePipelineStage } = require('./project-registry');
    updatePipelineStage(run.projectId, run.pipelineStageIndex, { status: 'cancelled', runId });
  }
  updateRun(runId, { status: 'cancelled' });
  cleanup(runId);
}

// ---------------------------------------------------------------------------
// cancelRunInternal — shared by cancelRun and timeout
// ---------------------------------------------------------------------------

async function cancelRunInternal(
  runId: string,
  cascadeId: string,
  conn: { port: number; csrf: string },
  apiKey: string,
  status: 'cancelled' | 'timeout',
): Promise<void> {
  const shortRunId = runId.slice(0, 8);
  try {
    log.info({ runId: shortRunId, status }, 'Cancelling child cascade');
    await grpc.cancelCascade(conn.port, conn.csrf, apiKey, cascadeId);
  } catch (err: any) {
    log.warn({ runId: shortRunId, err: err.message }, 'Cancel cascade failed (may already be idle)');
  }

  const run = getRun(runId);
  if (status === 'cancelled' && run?.projectId && run.pipelineStageIndex !== undefined) {
    const { updatePipelineStage } = require('./project-registry');
    updatePipelineStage(run.projectId, run.pipelineStageIndex, { status: 'cancelled', runId });
  }
  updateRun(runId, {
    status,
    lastError: status === 'timeout' ? 'Run exceeded timeout limit' : undefined,
  });
  cleanup(runId);
}

// ---------------------------------------------------------------------------
// cleanup — stop watching + clear timeout
// ---------------------------------------------------------------------------

function cleanup(runId: string): void {
  const active = activeRuns.get(runId);
  if (active) {
    active.abortWatch();
    if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
    activeRuns.delete(runId);
  }
}

/**
 * V3: 从 architecture run 的 write-scope-plan.json 拆分出多个 Work Package 的 scope
 * 这是一个辅助函数供 Governor 调用
 */
export function splitWriteScopeForMultiWP(
  writeScopePlanPath: string,
  workPackageGoals: { taskId: string; goalDescription: string; suggestedFiles?: string[] }[]
): { taskId: string; writeScope: { path: string; operation: string }[] }[] {
  try {
    const raw = fs.readFileSync(writeScopePlanPath, "utf-8");
    const fullScope: { path: string; operation: string }[] = JSON.parse(raw);

    return workPackageGoals.map(wp => {
      // If suggestedFiles provided, use them; otherwise include all
      const scope = wp.suggestedFiles
        ? fullScope.filter(entry => wp.suggestedFiles!.some(f => entry.path.includes(f)))
        : fullScope;
      return { taskId: wp.taskId, writeScope: scope };
    });
  } catch {
    return workPackageGoals.map(wp => ({ taskId: wp.taskId, writeScope: [] }));
  }
}
