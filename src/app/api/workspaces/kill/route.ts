import { NextResponse } from 'next/server';
import { discoverLanguageServers } from '@/lib/bridge/gateway';
import { closeAntigravityWindow } from '@/lib/window-control';

export const dynamic = 'force-dynamic';

/**
 * POST /api/workspaces/kill — Actually stop a workspace's language_server process.
 * 
 * ⚠️ WARNING: This kills the language_server process. If the workspace is also
 * open in Agent Manager, Agent Manager will lose connection and show errors.
 * Use POST /api/workspaces/close (hide) if you just want to remove it from the sidebar.
 */
export async function POST(req: Request) {
  const { workspace } = await req.json();
  if (!workspace) {
    return NextResponse.json({ error: 'Missing workspace' }, { status: 400 });
  }

  const servers = discoverLanguageServers();
  const target = servers.find(s =>
    s.workspace === workspace ||
    s.workspace?.includes(workspace) ||
    workspace.includes(s.workspace || '\0')
  );

  if (!target) {
    return NextResponse.json({ error: 'No server found for this workspace' }, { status: 404 });
  }

  console.log(`🛑 [Kill] Trying to elegantly close Antigravity window for workspace="${workspace}"`);

  try {
    const success = await closeAntigravityWindow(workspace);
    if (!success) {
      console.log(`⚠️ Window not found via AppleScript, falling back to process.kill for pid=${target.pid}`);
      process.kill(target.pid, 'SIGTERM');
    }
    return NextResponse.json({ ok: true, killed: { pid: target.pid, port: target.port, windowClosed: success } });
  } catch (e: any) {
    console.error(`❌ [Kill] Failed to clean up ${workspace}:`, e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
