import { NextResponse } from 'next/server';
import { createLogger } from '@/lib/logger';
import path from 'path';
import { readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import {
  getAllConnections, getConversations, addLocalConversation,
  refreshOwnerMap, convOwnerMap, preRegisterOwner, getApiKey,
  getLanguageServer, grpc,
} from '@/lib/bridge/gateway';
import { getChildConversationIds } from '@/lib/agents/run-registry';
import { findAgyProjectByFolder, getAgyProject, projectFolderUris } from '@/lib/bridge/agy-projects';

export const dynamic = 'force-dynamic';

const log = createLogger('NewConv');

const CONVERSATIONS_DIR = path.join(homedir(), '.gemini/antigravity/conversations');

interface ConvCache { id: string; title: string; workspace: string; projectId?: string; projectName?: string; mtime: number; steps: number; }
let convCache: ConvCache[] = [];

// GET /api/conversations — list conversations
export async function GET() {
  try {
    const files = readdirSync(CONVERSATIONS_DIR)
      .filter(f => f.endsWith('.pb'))
      .map(f => {
        const id = f.replace('.pb', '');
        const stat = statSync(path.join(CONVERSATIONS_DIR, f));
        return { id, mtime: stat.mtimeMs, size: stat.size };
      })
      .sort((a, b) => b.mtime - a.mtime);

    await refreshOwnerMap();

    const sqliteConvs = getConversations();
    const sqliteMap = new Map<string, any>();
    sqliteConvs.forEach((c: any) => sqliteMap.set(c.id, c));

    const oldCacheMap = new Map<string, ConvCache>();
    convCache.forEach(c => oldCacheMap.set(c.id, c));

    const conns = getAllConnections();
    const serverTrajectories = new Map<string, Map<string, any>>();
    for (const conn of conns) {
      try {
        const data = await grpc.getAllCascadeTrajectories(conn.port, conn.csrf);
        const summaries = data?.trajectorySummaries || {};
        serverTrajectories.set(String(conn.port), new Map(Object.entries(summaries)));
      } catch { }
    }

    // Get hidden child conversation IDs from run registry
    const hiddenChildIds = getChildConversationIds();

    const results: ConvCache[] = [];

    for (const file of files) {
      // Filter out hidden child conversations
      if (hiddenChildIds.has(file.id)) continue;

      let title = '';
      let workspace = '';
      let projectId = '';
      let steps = 0;

      const owner = convOwnerMap.get(file.id);
      if (owner) {
        const ownerTraj = serverTrajectories.get(String(owner.port));
        const live = ownerTraj?.get(file.id);
        if (live) {
          title = live.summary || '';
          if (live.workspaces?.length > 0) {
            workspace = live.workspaces[0].workspaceFolderAbsoluteUri || '';
          }
          projectId = live.trajectoryMetadata?.projectId || '';
          steps = live.stepCount || 0;
        }
      }

      if (!title) {
        const lc = oldCacheMap.get(file.id);
        if (lc?.title) {
          title = lc.title;
          workspace = workspace || lc.workspace;
          projectId = projectId || lc.projectId || '';
          steps = Math.max(steps, lc.steps);
        }
      }

      const sqliteEntry = sqliteMap.get(file.id);
      if (!title && sqliteEntry?.title && sqliteEntry.title !== 'Untitled') {
        title = sqliteEntry.title; workspace = workspace || sqliteEntry.workspace || '';
        steps = Math.max(steps, sqliteEntry.steps || 0);
      }

      workspace = workspace || sqliteEntry?.workspace || '';
      projectId = projectId || sqliteEntry?.projectId || '';
      const matched = projectId ? getAgyProject(projectId) : (workspace ? findAgyProjectByFolder(workspace) : null);
      results.push({
        id: file.id,
        title: title || `Conversation ${file.id.slice(0, 8)}`,
        workspace,
        projectId: matched?.id || projectId || undefined,
        projectName: matched?.name,
        mtime: file.mtime,
        steps,
      });
    }

    const seen = new Set(results.map(c => c.id));
    for (const local of sqliteConvs) {
      if (seen.has(local.id) || hiddenChildIds.has(local.id)) continue;
      const matched = local.projectId ? getAgyProject(local.projectId) : (local.workspace ? findAgyProjectByFolder(local.workspace) : null);
      results.unshift({
        id: local.id,
        title: local.title || `Conversation ${local.id.slice(0, 8)}`,
        workspace: local.workspace || '',
        projectId: matched?.id || local.projectId,
        projectName: matched?.name,
        mtime: local.createdAt ? Date.parse(local.createdAt) : Date.now(),
        steps: local.stepCount || 0,
      });
    }

    convCache = results;
    return NextResponse.json(results);
  } catch (e: any) {
    const conversations = getConversations();
    return NextResponse.json(conversations);
  }
}

// POST /api/conversations — create a conversation bound to a 2.0 project
export async function POST(req: Request) {
  const srv = getLanguageServer();
  if (!srv) {
    return NextResponse.json({ error: 'No Antigravity hub running' }, { status: 503 });
  }

  let projectId = '';
  try {
    const body = await req.json();
    if (body?.projectId) projectId = String(body.projectId);
  } catch { /* empty body */ }

  const project = projectId ? getAgyProject(projectId) : null;
  if (projectId && !project) {
    return NextResponse.json({ error: `Unknown project: ${projectId}` }, { status: 400 });
  }

  const folderUris = project ? projectFolderUris(project) : [];
  const apiKey = getApiKey();
  log.info({ port: srv.port, pid: srv.pid, projectId: project?.id, folders: folderUris.length }, 'New conversation on hub');

  try {
    for (const uri of folderUris) {
      await grpc.addTrackedWorkspace(srv.port, srv.csrf, uri.replace(/^file:\/\//, '')).catch(() => {});
    }

    const data = await grpc.startCascade(srv.port, srv.csrf, apiKey, {
      projectId: project?.id,
      workspaceUris: folderUris,
    });
    if (data.cascadeId) {
      addLocalConversation(
        data.cascadeId,
        folderUris[0] || '',
        project ? `New: ${project.name}` : 'New conversation',
        project?.id,
      );
      await grpc.updateConversationAnnotations(srv.port, srv.csrf, apiKey, data.cascadeId, {
        lastUserViewTime: new Date().toISOString(),
      }).catch(() => {});
      preRegisterOwner(data.cascadeId, {
        port: srv.port,
        csrf: srv.csrf,
        apiKey,
        stepCount: 0,
      });
    }
    log.info({ cascadeId: data.cascadeId, projectId: project?.id }, 'Conversation created successfully');
    return NextResponse.json(data);
  } catch (e: any) {
    log.error({ err: e.message }, 'Conversation creation failed');
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
