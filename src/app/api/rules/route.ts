import { NextResponse } from 'next/server';
import { getAllConnections, grpc } from '@/lib/bridge/gateway';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const conns = getAllConnections();
    const ruleMap = new Map<string, any>();
    for (const conn of conns) {
      try {
        const data = await grpc.getAllRules(conn.port, conn.csrf);
        if (data?.rules) {
          for (const rule of data.rules) {
            const key = rule.path || rule.name || JSON.stringify(rule);
            if (!ruleMap.has(key)) {
              ruleMap.set(key, {
                name: rule.name || '',
                description: rule.description || '',
                path: rule.path || '',
                content: rule.content || '',
                scope: rule.scope?.globalScope ? 'global' : 'workspace',
                baseDir: rule.baseDir || '',
              });
            }
          }
        }
      } catch {}
    }
    return NextResponse.json([...ruleMap.values()]);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
