import { NextResponse } from 'next/server';
import { createProject, listProjects } from '@/lib/agents/project-registry';
import { getRun } from '@/lib/agents/run-registry';

export const dynamic = 'force-dynamic';

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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

function looksLikeCompletionText(text?: string): boolean {
  return !!text && /(?:^|[\s])(?:completed?|done|finished|ready)(?:$|[\s])|完成/.test(text);
}

function deriveRunFailureReason(run: ReturnType<typeof getRun>): string | undefined {
  if (!run) return undefined;
  if (run.lastError) return run.lastError;
  if (run.result?.blockers?.length) return run.result.blockers[0];
  const failedRole = [...(run.roles || [])]
    .reverse()
    .find(role => role.result?.status === 'failed' || role.result?.status === 'blocked');
  if (failedRole?.result?.summary) {
    const summary = summarizeFailureText(failedRole.result.summary);
    if (run.status === 'failed' && failedRole.result.status === 'failed' && looksLikeCompletionText(summary)) {
      return 'Role failed after reporting completion; inspect child conversation error steps.';
    }
    return summary;
  }
  return summarizeFailureText(run.result?.summary);
}

function normalizeProject<T extends ReturnType<typeof listProjects>[number]>(project: T): T {
  const canonicalRunIds = new Set(project.runIds);
  for (const stage of project.pipelineState?.stages || []) {
    if (stage.runId) canonicalRunIds.add(stage.runId);
  }

  const normalizedPipelineState = project.pipelineState
    ? {
        ...project.pipelineState,
        stages: project.pipelineState.stages.map(stage => {
          const shouldDeriveError = stage.status === 'failed' || stage.status === 'blocked' || stage.status === 'cancelled';
          if (stage.lastError || !stage.runId || !shouldDeriveError) return stage;
          const derivedError = deriveRunFailureReason(getRun(stage.runId));
          return derivedError ? { ...stage, lastError: derivedError } : stage;
        }),
      }
    : undefined;

  return {
    ...project,
    runIds: Array.from(canonicalRunIds),
    pipelineState: normalizedPipelineState,
  };
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { name, goal, templateId } = body;

    if (!name || !goal) {
      return NextResponse.json({ error: 'Missing required fields: name, goal' }, { status: 400 });
    }

    const { defaultWorkUri } = await import('@/lib/agents/gateway-home');
    const project = createProject({ name, goal, templateId, workspace: defaultWorkUri() });
    return NextResponse.json(project, { status: 201 });
  } catch (err: unknown) {
    return NextResponse.json({ error: getErrorMessage(err) }, { status: 500 });
  }
}

export async function GET() {
  const projects = listProjects().map(project => normalizeProject(project));
  return NextResponse.json(projects);
}
