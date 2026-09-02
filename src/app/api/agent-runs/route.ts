import { NextResponse } from 'next/server';
import { dispatchRun } from '@/lib/agents/group-runtime';
import { listRuns, getRun } from '@/lib/agents/run-registry';
import { getGroup } from '@/lib/agents/group-registry';
import { AssetLoader } from '@/lib/agents/asset-loader';
import type { RunStatus } from '@/lib/agents/group-types';
import { createLogger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

const log = createLogger('AgentRuns');

// POST /api/agent-runs — dispatch a new run
export async function POST(req: Request) {
  try {
    const body = await req.json();

    const { groupId, workspace, prompt, model, parentConversationId, taskEnvelope, sourceRunIds, projectId, hubProjectId, pipelineId, pipelineStageIndex } = body;

    let finalGroupId = groupId;
    let finalPipelineStageIndex = pipelineStageIndex;
    const finalPipelineId = pipelineId || body.templateId; // support both keys interchangeably

    // Auto-resolve template dispatch if groupId is omitted
    if (!finalGroupId && finalPipelineId) {
      const template = AssetLoader.getTemplate(finalPipelineId);
      if (!template) {
        return NextResponse.json({ error: `Template not found: ${finalPipelineId}` }, { status: 400 });
      }
      if (!template.pipeline || template.pipeline.length === 0) {
        return NextResponse.json({ error: `Template ${finalPipelineId} has no pipeline stages` }, { status: 400 });
      }
      
      // Auto-infer stage index if we have a source run
      if (finalPipelineStageIndex === undefined && sourceRunIds?.length) {
        const sourceRun = getRun(sourceRunIds[0]);
        if (sourceRun?.pipelineStageIndex !== undefined) {
          finalPipelineStageIndex = sourceRun.pipelineStageIndex + 1;
        }
      }

      // Fallback to initial stage if no inference was possible
      if (finalPipelineStageIndex === undefined) {
        finalPipelineStageIndex = 0;
      }
      
      // Determine the groupId based on the resolved stage index
      const stageDef = template.pipeline[finalPipelineStageIndex];
      if (!stageDef) {
        return NextResponse.json({ error: `Pipeline stage index ${finalPipelineStageIndex} is out of bounds for template ${finalPipelineId}` }, { status: 400 });
      }
      finalGroupId = stageDef.groupId;
    } else {
      // V3.6: General inference for CLI and manual dispatches where groupId is provided
      if (finalPipelineStageIndex === undefined && finalPipelineId && sourceRunIds?.length) {
        const sourceRun = getRun(sourceRunIds[0]);
        if (sourceRun?.pipelineStageIndex !== undefined) {
          finalPipelineStageIndex = sourceRun.pipelineStageIndex + 1;
        }
      }
    }

    if (!finalGroupId) {
      return NextResponse.json({ error: 'Missing required field: groupId (or pipelineId)' }, { status: 400 });
    }
    const { defaultWorkUri } = await import('@/lib/agents/gateway-home');
    const { getAgyProject, primaryWritePath } = await import('@/lib/bridge/agy-projects');
    const hubProject = hubProjectId ? getAgyProject(hubProjectId) : null;
    if (hubProjectId && !hubProject) {
      return NextResponse.json({ error: `Unknown hub project: ${hubProjectId}` }, { status: 400 });
    }
    const resolvedWorkspace = workspace
      || (hubProject && primaryWritePath(hubProject) ? `file://${primaryWritePath(hubProject)}` : '')
      || defaultWorkUri();

    // V2: Either prompt or taskEnvelope.goal is required
    const goal = taskEnvelope?.goal || prompt;
    if (!goal) {
      return NextResponse.json({ error: 'Either prompt or taskEnvelope.goal is required' }, { status: 400 });
    }

    // V2.5: Groups with sourceContract handle validation in runtime (resolveSourceContext)
    // But we do early 400 checks here so missing params don't surface as 500 from runtime
    const group = getGroup(finalGroupId);
    if (group?.sourceContract) {
      // All contract groups require sourceRunIds
      if (!sourceRunIds || sourceRunIds.length === 0) {
        return NextResponse.json(
          { error: `Group ${finalGroupId} requires sourceRunIds per its source contract` },
          { status: 400 },
        );
      }
      // Non-autoBuild contracts also require caller-provided inputArtifacts
      if (!group.sourceContract.autoBuildInputArtifactsFromSources) {
        if (!taskEnvelope?.inputArtifacts?.length) {
          return NextResponse.json(
            { error: `Group ${finalGroupId} requires inputArtifacts (source contract does not auto-build)` },
            { status: 400 },
          );
        }
      }
    } else if (group?.capabilities?.requiresInputArtifacts) {
      if (!taskEnvelope?.inputArtifacts?.length) {
        return NextResponse.json(
          { error: `Group ${finalGroupId} requires inputArtifacts from an approved source run` },
          { status: 400 },
        );
      }
    }

    log.info({ groupId: finalGroupId, goalLength: goal.length, hasEnvelope: !!taskEnvelope }, 'Dispatching run');

    const result = await dispatchRun({
      groupId: finalGroupId,
      workspace: resolvedWorkspace,
      hubProjectId: hubProject?.id,
      prompt: goal,
      model,
      parentConversationId,
      taskEnvelope,
      sourceRunIds,
      projectId,
      pipelineId: finalPipelineId,
      pipelineStageIndex: finalPipelineStageIndex,
    });

    if (projectId) {
      const { addRunToProject, initializePipelineState, trackStageDispatch } = await import('@/lib/agents/project-registry');
      addRunToProject(projectId, result.runId);

      // Initialize pipeline state on the project if this is a template dispatch
      if (finalPipelineId) {
        initializePipelineState(projectId, finalPipelineId);
        // V3.5 Fix 8: Track initial dispatch via unified helper
        if (finalPipelineStageIndex !== undefined) {
          trackStageDispatch(projectId, finalPipelineStageIndex, result.runId);
        }
      }
    }

    return NextResponse.json({ runId: result.runId, status: 'starting' }, { status: 201 });
  } catch (err: any) {
    log.error({ err: err.message }, 'Dispatch failed');
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// GET /api/agent-runs — list runs with optional filters
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const statusFilter = searchParams.get('status') as RunStatus | null;
  const groupIdFilter = searchParams.get('groupId');
  const reviewOutcomeFilter = searchParams.get('reviewOutcome');
  const projectIdFilter = searchParams.get('projectId');

  const filter: { status?: RunStatus; groupId?: string; reviewOutcome?: string; projectId?: string } = {};
  if (statusFilter) filter.status = statusFilter;
  if (groupIdFilter) filter.groupId = groupIdFilter;
  if (reviewOutcomeFilter) filter.reviewOutcome = reviewOutcomeFilter;
  if (projectIdFilter) filter.projectId = projectIdFilter;

  const runs = listRuns(Object.keys(filter).length > 0 ? filter : undefined);
  return NextResponse.json(runs);
}
