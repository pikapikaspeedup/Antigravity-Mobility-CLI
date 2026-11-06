import { execSync } from 'child_process';
import { homedir } from 'os';
import path from 'path';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { GATEWAY_HOME, CONVS_FILE } from '../agents/gateway-home';

const STATE_DB_PATH = path.join(
  homedir(),
  'Library/Application Support/Antigravity/User/globalStorage/state.vscdb'
);

const BRAIN_DIR = path.join(homedir(), '.gemini/antigravity/brain');
const LOCAL_CACHE_FILE = CONVS_FILE;

export interface ConversationInfo {
  id: string;
  title: string;
  workspace: string;
  projectId?: string;
  stepCount: number;
  createdAt?: string;
}

// --- Local conversation cache ---
function readLocalCache(): ConversationInfo[] {
  try {
    return JSON.parse(readFileSync(LOCAL_CACHE_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function writeLocalCache(convs: ConversationInfo[]) {
  try {
    mkdirSync(GATEWAY_HOME, { recursive: true });
    writeFileSync(LOCAL_CACHE_FILE, JSON.stringify(convs, null, 2));
  } catch {}
}

export function addLocalConversation(id: string, workspace: string, title: string = 'New conversation', projectId?: string) {
  const cache = readLocalCache();
  if (cache.some(c => c.id === id)) return;
  cache.unshift({ id, title, workspace, projectId, stepCount: 0, createdAt: new Date().toISOString() });
  writeLocalCache(cache);
}

export function updateLocalConversationTitle(id: string, title: string) {
  const cache = readLocalCache();
  const conv = cache.find(c => c.id === id);
  if (conv) {
    conv.title = title;
    writeLocalCache(cache);
  }
}

function queryDb(sql: string): string {
  try {
    return execSync(`sqlite3 "${STATE_DB_PATH}" "${sql}"`, {
      encoding: 'utf-8',
      timeout: 5000
    }).trim();
  } catch {
    return '';
  }
}

export function getApiKey(): string {
  return '';
}

export function getUserInfo(): { name: string; email: string; apiKey: string } {
  return { name: '', email: '', apiKey: '' };
}

export function getWorkspaces(): Array<{ type: 'folder' | 'workspace'; uri: string }> {
  return [];
}

export function getPlaygrounds(): string[] {
  return [];
}

/**
 * Get comprehensive conversation list by merging (priority order):
 * 1. Conversation .pb files (~/.gemini/antigravity/conversations/) — ALWAYS current, primary IDs
 * 2. SQLite trajectorySummaries — for titles + workspace metadata
 * 3. Brain directory scan — for task.md/walkthrough.md titles
 * 4. Local cache — for newly created conversations
 */
export function getConversations(): ConversationInfo[] {
  const convMap = new Map<string, ConversationInfo>();

  // Step 1: Scan .pb conversation files (primary source — always up-to-date)
  const CONV_DIR = path.join(homedir(), '.gemini/antigravity/conversations');
  try {
    // Get all .pb files sorted by modification time (newest first)
    const output = execSync(`ls -1t "${CONV_DIR}" 2>/dev/null`, {
      encoding: 'utf-8', timeout: 5000
    });
    const files = output.trim().split('\n').filter(f => f.endsWith('.pb'));
    for (const file of files) {
      const id = file.replace('.pb', '');
      if (id && id.includes('-') && id.length > 30) {
        convMap.set(id, {
          id,
          title: '', // Will be enriched below
          workspace: '',
          stepCount: 0,
        });
      }
    }
  } catch {}

  // Step 2: Enrich with SQLite 2.0 conversation_summaries.db data (titles + workspace + projectId)
  const protoConvs = getConversationsFromProtobuf();
  for (const pc of protoConvs) {
    const existing = convMap.get(pc.id);
    if (existing) {
      if (pc.title) existing.title = pc.title;
      if (pc.workspace) existing.workspace = pc.workspace;
      if (pc.projectId) existing.projectId = pc.projectId;
      if (pc.stepCount) existing.stepCount = pc.stepCount;
      if (pc.createdAt) existing.createdAt = pc.createdAt;
    } else {
      convMap.set(pc.id, pc);
    }
  }

  // Step 3: Merge local cache (only enrich existing .pb/SQLite conversations; ignore 0-step unpersisted entries)
  const localConvs = readLocalCache();
  for (const lc of localConvs) {
    const existing = convMap.get(lc.id);
    if (existing) {
      if (lc.title && lc.title !== 'New conversation' && !lc.title.startsWith('New: ')) {
        existing.title = lc.title;
      } else if (!existing.title && lc.title) {
        existing.title = lc.title;
      }
      if (lc.workspace) existing.workspace = lc.workspace;
      if (lc.projectId) existing.projectId = lc.projectId;
    } else if (lc.stepCount > 0) {
      convMap.set(lc.id, lc);
    }
  }

  // Step 4: Scan brain directory for titles (task.md / walkthrough.md)
  try {
    const output = execSync(`ls -1t "${BRAIN_DIR}" 2>/dev/null`, {
      encoding: 'utf-8', timeout: 5000
    });
    const dirs = output.trim().split('\n').filter(d =>
      d && d.includes('-') && d.length > 30 && d !== 'tempmediaStorage'
    );

    for (const dir of dirs) {
      const existing = convMap.get(dir);
      if (existing && !existing.title) {
        // Try to get title from brain artifacts
        try {
          const taskMd = execSync(`head -3 "${path.join(BRAIN_DIR, dir, 'task.md')}" 2>/dev/null`, {
            encoding: 'utf-8', timeout: 1000
          }).trim();
          existing.title = taskMd.replace(/^#\s*/, '').split('\n')[0].trim();
        } catch {
          try {
            const wt = execSync(`head -3 "${path.join(BRAIN_DIR, dir, 'walkthrough.md')}" 2>/dev/null`, {
              encoding: 'utf-8', timeout: 1000
            }).trim();
            existing.title = wt.replace(/^#\s*/, '').split('\n')[0].trim();
          } catch {}
        }
      } else if (!existing) {
        // Conversation exists in brain but not in .pb dir
        let title = '';
        try {
          const taskMd = execSync(`head -3 "${path.join(BRAIN_DIR, dir, 'task.md')}" 2>/dev/null`, {
            encoding: 'utf-8', timeout: 1000
          }).trim();
          title = taskMd.replace(/^#\s*/, '').split('\n')[0].trim();
        } catch {
          try {
            const wt = execSync(`head -3 "${path.join(BRAIN_DIR, dir, 'walkthrough.md')}" 2>/dev/null`, {
              encoding: 'utf-8', timeout: 1000
            }).trim();
            title = wt.replace(/^#\s*/, '').split('\n')[0].trim();
          } catch {}
        }
        convMap.set(dir, { id: dir, title: title || '', workspace: '', stepCount: 0 });
      }
    }
  } catch {}

  // Step 5: Generate fallback titles for any without one
  for (const [id, conv] of convMap) {
    if (!conv.title) {
      conv.title = `Conversation ${id.slice(0, 8)}`;
    }
  }

  return Array.from(convMap.values());
}

function getConversationsFromProtobuf(): Array<ConversationInfo> {
  const summariesDb = path.join(homedir(), '.gemini/antigravity/conversation_summaries.db');
  try {
    const sql = `SELECT conversation_id AS id, title, step_count AS stepCount, last_modified_time AS updatedAt, workspace_uris AS workspaceUris, project_id AS projectId FROM conversation_summaries WHERE parent_conversation_id = '' ORDER BY last_modified_time DESC;`;
    const output = execSync(`sqlite3 -json "${summariesDb}" "${sql}" 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    if (output) {
      const rows = JSON.parse(output) as Array<{
        id: string;
        title: string;
        stepCount: number;
        updatedAt: string;
        workspaceUris: string;
        projectId: string;
      }>;
      return rows.map(r => {
        let workspace = '';
        if (r.workspaceUris) {
          try {
            const uris = JSON.parse(r.workspaceUris);
            if (Array.isArray(uris) && uris.length > 0) workspace = uris[0];
          } catch {}
        }
        return {
          id: r.id,
          title: r.title || '',
          workspace,
          projectId: r.projectId && r.projectId !== 'outside-of-project' ? r.projectId : undefined,
          stepCount: r.stepCount || 0,
          createdAt: r.updatedAt,
        };
      });
    }
  } catch {}
  return [];
}
