import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST() {
  return NextResponse.json({ error: 'Workspaces are not used on Antigravity 2.0' }, { status: 410 });
}
