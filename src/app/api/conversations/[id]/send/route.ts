import { NextResponse } from 'next/server';
import { getOwnerConnection, refreshOwnerMap, convOwnerMap, ownerMapAge, grpc } from '@/lib/bridge/gateway';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: cascadeId } = await params;
  const { text, model } = await req.json();

  console.log(`💬 [SendMsg] cascadeId=${cascadeId}, ownerMapHas=${convOwnerMap.has(cascadeId)}, ownerMapAge=${Date.now() - ownerMapAge}ms`);

  if (!convOwnerMap.has(cascadeId) || Date.now() - ownerMapAge > 30_000) {
    await refreshOwnerMap();
    console.log(`💬 [SendMsg] Refreshed ownerMap, now has cascadeId=${convOwnerMap.has(cascadeId)}`);
  }

  const conn = getOwnerConnection(cascadeId);
  if (!conn) return NextResponse.json({ error: 'No server available' }, { status: 503 });
  console.log(`💬 [SendMsg] Routing to port=${conn.port}, model=${model || 'default'}`);
  try {
    const data = await grpc.sendMessage(conn.port, conn.csrf, conn.apiKey, cascadeId, text, model);
    return NextResponse.json({ ok: true, data });
  } catch (e: any) {
    console.error(`❌ [SendMsg] Error:`, e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
