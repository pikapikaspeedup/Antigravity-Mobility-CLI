import { NextResponse } from 'next/server';
import { getAllConnections, grpc } from '@/lib/bridge/gateway';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const conns = getAllConnections();
    const workflowMap = new Map<string, any>();
    for (const conn of conns) {
      try {
        const data = await grpc.getAllWorkflows(conn.port, conn.csrf);
        if (data?.workflows) {
          for (const wf of data.workflows) {
            if (!workflowMap.has(wf.name)) {
              workflowMap.set(wf.name, {
                name: wf.name,
                description: wf.description || '',
                path: wf.path || '',
                content: wf.content || '',
                scope: wf.scope?.globalScope ? 'global' : 'workspace',
                baseDir: wf.baseDir || '',
              });
            }
          }
        }
      } catch {}
    }
    return NextResponse.json([...workflowMap.values()].sort((a, b) => a.name.localeCompare(b.name)));
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
