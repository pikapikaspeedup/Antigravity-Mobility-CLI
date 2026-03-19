import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

export const dynamic = 'force-dynamic';

const ANTIGRAVITY_CLI = '/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity';

/**
 * POST /api/workspaces/launch — Open a workspace in Antigravity (triggers language_server start)
 */
export async function POST(req: Request) {
  const { workspace } = await req.json();
  if (!workspace) {
    return NextResponse.json({ error: 'Missing workspace path' }, { status: 400 });
  }

  // Remove file:// prefix if present
  const wsPath = workspace.replace(/^file:\/\//, '');

  console.log(`🚀 [Launch] Opening workspace: "${wsPath}"`);

  try {
    execSync(`"${ANTIGRAVITY_CLI}" --new-window "${wsPath}"`, {
      timeout: 5000,
      stdio: 'ignore',
    });
    console.log(`🚀 [Launch] Antigravity CLI executed for "${wsPath}"`);
    return NextResponse.json({ ok: true, launched: wsPath });
  } catch (e: any) {
    console.error(`❌ [Launch] Failed:`, e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
