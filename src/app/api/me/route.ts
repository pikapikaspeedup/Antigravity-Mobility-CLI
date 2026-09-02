import { NextResponse } from 'next/server';
import { getUserInfo, getDefaultConnection, grpc } from '@/lib/bridge/gateway';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = getUserInfo();
  const conn = getDefaultConnection();
  let credits = null;
  let liveName = '';
  let liveEmail = '';
  if (conn) {
    try {
      credits = await grpc.getModelConfigs(conn.port, conn.csrf, conn.apiKey);
    } catch {}
    try {
      const status = await grpc.getUserStatus(conn.port, conn.csrf, conn.apiKey);
      liveName = status?.userStatus?.name || '';
      liveEmail = status?.userStatus?.email || '';
    } catch {}
  }
  const name = liveName || user.name;
  const email = liveEmail || user.email;
  return NextResponse.json({
    name,
    email,
    apiKey: undefined,
    hasApiKey: !!(liveEmail || conn),
    credits,
  });
}
