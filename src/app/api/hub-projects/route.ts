import { NextResponse } from 'next/server';
import {
  buildCreateProjectBody,
  findAgyProjectByFolder,
  getAgyProject,
  listAgyProjects,
  normalizeFolderPath,
} from '@/lib/bridge/agy-projects';
import { getLanguageServer, grpc } from '@/lib/bridge/gateway';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(listAgyProjects());
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const folderPath = typeof body?.folderPath === 'string' ? body.folderPath : '';
  const name = typeof body?.name === 'string' ? body.name : '';

  const abs = normalizeFolderPath(folderPath);
  const existing = abs ? findAgyProjectByFolder(abs) : null;
  if (existing) {
    return NextResponse.json({ ...existing, reused: true });
  }

  const payload = buildCreateProjectBody(folderPath, name);
  if ('error' in payload) {
    return NextResponse.json({ error: payload.error }, { status: 400 });
  }

  const srv = getLanguageServer();
  if (!srv) {
    return NextResponse.json({ error: 'No Antigravity hub running' }, { status: 503 });
  }

  const result = await grpc.createProject(srv.port, srv.csrf, payload);
  if (result?.code) {
    return NextResponse.json({ error: result.message || result.code }, { status: 500 });
  }

  const created = getAgyProject(payload.id) || {
    id: payload.id,
    name: payload.name,
    folders: [{
      uri: `file://${abs}`,
      path: abs,
      allowWrite: true,
      kind: payload.projectResources && (payload.projectResources as any).resources?.[0]?.gitFolder ? 'git' : 'folder',
    }],
  };

  return NextResponse.json({ ...created, reused: false }, { status: 201 });
}
