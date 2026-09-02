/**
 * V2 Multi-Agent System — Run Registry
 *
 * In-memory store for AgentRunState with JSON file persistence.
 * Survives dev-mode restarts. In-progress runs are marked failed on recovery.
 * V2: supports envelope fields, templateId, sourceRunIds.
 */

import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import type { AgentRunState, RunStatus, TaskEnvelope } from './group-types';
import { TERMINAL_STATUSES } from './group-types';
import { createLogger } from '../logger';
import { GATEWAY_HOME, RUNS_FILE } from './gateway-home';

const log = createLogger('RunRegistry');

// ---------------------------------------------------------------------------
// Persistence path
// ---------------------------------------------------------------------------

const PERSIST_FILE = RUNS_FILE;

// ---------------------------------------------------------------------------
// In-memory store (Preserved across Next.js HMR)
// ---------------------------------------------------------------------------

const globalForRegistry = globalThis as unknown as {
  __AGENT_RUNS_REGISTRY_MAP?: Map<string, AgentRunState>;
};

const runs = globalForRegistry.__AGENT_RUNS_REGISTRY_MAP || new Map<string, AgentRunState>();
if (process.env.NODE_ENV !== 'production') {
  globalForRegistry.__AGENT_RUNS_REGISTRY_MAP = runs;
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function saveToDisk(): void {
  try {
    if (!existsSync(GATEWAY_HOME)) {
      mkdirSync(GATEWAY_HOME, { recursive: true });
    }
    const entries = Array.from(runs.values());
    writeFileSync(PERSIST_FILE, JSON.stringify(entries, null, 2), 'utf-8');
    log.debug({ count: entries.length }, 'Runs persisted');
  } catch (err: any) {
    log.error({ err: err.message }, 'Failed to persist runs');
  }
}

/**
 * Attempt to recover a run from its artifacts.
 * @param force - if true, also attempts recovery on already-terminal runs (e.g. failed after restart).
 *                This is needed because loadFromDisk marks interrupted runs as failed,
 *                and the resume API's 'recover' action needs to re-check those.
 */
export function recoverInterruptedRun(entry: AgentRunState, force = false): boolean {
  // Without force, skip runs already in a terminal state
  if (!force && TERMINAL_STATUSES.has(entry.status)) return false;

  // Signal 1: resultEnvelope already completed
  if (entry.resultEnvelope?.status === 'completed') {
    entry.status = 'completed';
    entry.lastError = undefined;
    if (!entry.reviewOutcome && entry.resultEnvelope.decision) {
      entry.reviewOutcome = entry.resultEnvelope.decision as any;
    }
    return true;
  }

  // Signal 2 & 3: Check for generated result.json files
  // Resolve relative to the run's workspace (not process.cwd()),
  // falling back to cwd if workspace is missing
  const resolveBase = () => {
    if (entry.workspace) {
      return entry.workspace.replace(/^file:\/\//, '');
    }
    return process.cwd();
  };

  const checkResultFile = (subpath: string) => {
    if (!entry.artifactDir) return false;
    const fullPath = path.join(resolveBase(), entry.artifactDir, subpath);
    if (!existsSync(fullPath)) return false;
    try {
      const data = JSON.parse(readFileSync(fullPath, 'utf-8'));
      if (data && data.status === 'completed') {
        entry.status = 'completed';
        entry.lastError = undefined;
        entry.result = data;
        return true;
      }
    } catch {
      // ignore parse errors
    }
    return false;
  };

  if (checkResultFile('result.json')) return true;
  if (checkResultFile('architecture/result.json')) return true;

  return false;
}

function loadFromDisk(): void {
  try {
    // If the Map is already populated, this is an HMR reload, not a cold start.
    // Skip loading from disk to preserve actual running states and avoid fake failures.
    if (runs.size > 0 && process.env.NODE_ENV !== 'production') {
      log.debug('Runs map already populated in Memory (HMR skipped disk load)');
      return;
    }

    if (!existsSync(PERSIST_FILE)) {
      // Fallback: try legacy path for backward compatibility
      const legacyFile = path.join(process.cwd(), 'data', 'agent_runs.json');
      if (existsSync(legacyFile)) {
        log.info('Loading runs from legacy path, will save to new path on next write');
        const raw = readFileSync(legacyFile, 'utf-8');
        const entries: AgentRunState[] = JSON.parse(raw);
        for (const entry of entries) { runs.set(entry.runId, entry); }
        saveToDisk();  // migrate to new path
        return;
      }
      return;
    }
    const raw = readFileSync(PERSIST_FILE, 'utf-8');
    const entries: AgentRunState[] = JSON.parse(raw);
    let recovered = 0;
    let autoRecovered = 0;
    for (const entry of entries) {
      // In-progress runs that survived a true process restart.
      // Try to recover from completed artifacts, otherwise mark failed.
      if (!TERMINAL_STATUSES.has(entry.status)) {
        if (recoverInterruptedRun(entry)) {
          autoRecovered++;
        } else {
          entry.status = 'failed';
          entry.lastError = 'Process restarted while run was in progress';
          entry.finishedAt = new Date().toISOString();
        }
        recovered++;
      }
      runs.set(entry.runId, entry);
    }
    log.info({ total: entries.length, recovered, autoRecovered }, 'Runs loaded from disk');

    // Post-load: sync any auto-recovered runs to their project pipeline
    for (const entry of entries) {
      if (entry.status === 'completed' && entry.projectId && entry.pipelineStageIndex !== undefined) {
        syncRunStatusToProject(entry);
      }
    }
  } catch (err: any) {
    log.warn({ err: err.message }, 'Failed to load runs from disk');
  }
}

// Load on module init (only takes effect on true cold start)
loadFromDisk();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createRun(input: {
  groupId: string;
  workspace: string;
  prompt: string;
  model?: string;
  parentConversationId?: string;
  // V2 fields
  templateId?: string;
  taskEnvelope?: TaskEnvelope;
  sourceRunIds?: string[];
  projectId?: string;
  hubProjectId?: string;
  // V3.5: Pipeline tracking
  pipelineId?: string;
  pipelineStageIndex?: number;
}): AgentRunState {
  const run: AgentRunState = {
    runId: randomUUID(),
    projectId: input.projectId,
    hubProjectId: input.hubProjectId,
    groupId: input.groupId,
    workspace: input.workspace,
    prompt: input.prompt,
    model: input.model,
    parentConversationId: input.parentConversationId,
    status: 'queued',
    createdAt: new Date().toISOString(),
    // V2 fields
    templateId: input.templateId,
    taskEnvelope: input.taskEnvelope,
    sourceRunIds: input.sourceRunIds,
    // V3.5: Pipeline tracking
    pipelineId: input.pipelineId,
    pipelineStageIndex: input.pipelineStageIndex,
  };
  // Runtime will backfill runId into taskEnvelope after creation
  if (run.taskEnvelope) {
    run.taskEnvelope.runId = run.runId;
  }
  runs.set(run.runId, run);
  saveToDisk();
  log.info({ runId: run.runId.slice(0, 8), groupId: run.groupId, templateId: run.templateId }, 'Run created');
  return run;
}

export function updateRun(
  runId: string,
  updates: Partial<Omit<AgentRunState, 'runId' | 'groupId' | 'workspace' | 'prompt' | 'createdAt'>>,
): AgentRunState | null {
  const run = runs.get(runId);
  if (!run) return null;

  const prevStatus = run.status;
  Object.assign(run, updates);

  // Auto-set finishedAt for terminal statuses
  if (updates.status && TERMINAL_STATUSES.has(updates.status) && !run.finishedAt) {
    run.finishedAt = new Date().toISOString();
  }

  // V3.5 Fix: Clear finishedAt when recovering from terminal to non-terminal
  if (updates.status && !TERMINAL_STATUSES.has(updates.status) && run.finishedAt) {
    run.finishedAt = undefined;
  }

  saveToDisk();
  log.debug({ runId: runId.slice(0, 8), status: run.status }, 'Run updated');

  // Pipeline state auto-sync: when a run transitions to terminal status,
  // propagate the change to the Project's pipelineState
  if (updates.status && updates.status !== prevStatus && run.projectId && run.pipelineStageIndex !== undefined) {
    syncRunStatusToProject(run);
  }

  return run;
}

/**
 * Sync a run's terminal status to the Project's pipeline stage.
 * Called automatically by updateRun when status transitions.
 */
function syncRunStatusToProject(run: AgentRunState): void {
  // Lazy import to avoid circular dependency
  const { updatePipelineStage, getProject } = require('./project-registry');
  const stageIndex = run.pipelineStageIndex!;

  // Cancel is handled explicitly by the cancel flow to preserve operator intent.
  if (run.status === 'cancelled') {
    return;
  }

  const project = getProject(run.projectId!);
  const stage = project?.pipelineState?.stages[stageIndex];
  if (stage?.status === 'completed' && (run.status === 'running' || run.status === 'starting')) {
    log.warn({ runId: run.runId.slice(0, 8), stageIndex }, 'Refusing to overwrite completed stage with running');
    return;
  }

  if (run.status === 'running' || run.status === 'starting') {
    // V3.5 Fix 8: attempts is now managed by trackStageDispatch; only sync status here
    updatePipelineStage(run.projectId!, stageIndex, {
      status: 'running',
      runId: run.runId,
    });
  } else if (run.status === 'completed') {
    updatePipelineStage(run.projectId!, stageIndex, {
      status: 'completed',
      runId: run.runId,
      completedAt: run.finishedAt || new Date().toISOString(),
    });
  } else if (run.status === 'blocked') {
    updatePipelineStage(run.projectId!, stageIndex, {
      status: 'blocked',
      runId: run.runId,
      lastError: run.lastError,
    });
  } else if (run.status === 'failed' || run.status === 'timeout') {
    updatePipelineStage(run.projectId!, stageIndex, {
      status: 'failed',
      runId: run.runId,
      lastError: run.lastError,
    });
  }
}

export function getRun(runId: string): AgentRunState | null {
  return runs.get(runId) ?? null;
}

export function listRuns(filter?: { status?: RunStatus; groupId?: string; reviewOutcome?: string; projectId?: string }): AgentRunState[] {
  let all = Array.from(runs.values());
  if (filter?.status) {
    all = all.filter(r => r.status === filter.status);
  }
  if (filter?.groupId) {
    all = all.filter(r => r.groupId === filter.groupId);
  }
  if (filter?.reviewOutcome) {
    all = all.filter(r => r.reviewOutcome === filter.reviewOutcome);
  }
  if (filter?.projectId) {
    all = all.filter(r => r.projectId === filter.projectId);
  }
  // Return newest first
  return all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/**
 * Returns all child conversation IDs from all runs.
 * Includes IDs from multi-role runs' role progress entries.
 * Used by the conversation filter to hide child conversations.
 */
export function getChildConversationIds(): Set<string> {
  const ids = new Set<string>();
  for (const run of runs.values()) {
    if (run.childConversationId) {
      ids.add(run.childConversationId);
    }
    // V1.5+: multi-role runs have child IDs in role progress
    if (run.roles) {
      for (const role of run.roles) {
        if (role.childConversationId) {
          ids.add(role.childConversationId);
        }
      }
    }
  }
  return ids;
}
