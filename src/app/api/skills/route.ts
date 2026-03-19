import { NextResponse } from 'next/server';
import { getAllConnections, grpc } from '@/lib/bridge/gateway';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const conns = getAllConnections();
    const skillMap = new Map<string, any>();
    for (const conn of conns) {
      try {
        const data = await grpc.getAllSkills(conn.port, conn.csrf);
        if (data?.skills) {
          for (const skill of data.skills) {
            if (!skillMap.has(skill.name)) {
              skillMap.set(skill.name, {
                name: skill.name,
                description: skill.description || '',
                path: skill.path || '',
                baseDir: skill.baseDir || '',
                scope: skill.scope?.globalScope ? 'global' : 'workspace',
              });
            }
          }
        }
      } catch {}
    }
    return NextResponse.json([...skillMap.values()].sort((a, b) => a.name.localeCompare(b.name)));
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
