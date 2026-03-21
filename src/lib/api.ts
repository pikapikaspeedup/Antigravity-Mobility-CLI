import type {
  Conversation, UserInfo, Server, Skill, Workflow, Rule,
  McpConfig, StepsData, ModelsResponse, WorkspacesResponse, AnalyticsData,
  KnowledgeItem, KnowledgeDetail,
} from './types';

const API = typeof window !== 'undefined' ? window.location.origin : '';

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${url}`, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export const api = {
  me: () => fetchJson<UserInfo>('/api/me'),
  models: () => fetchJson<ModelsResponse>('/api/models'),
  servers: () => fetchJson<Server[]>('/api/servers'),
  workspaces: () => fetchJson<WorkspacesResponse>('/api/workspaces'),
  conversations: () => fetchJson<Conversation[]>('/api/conversations'),
  conversationSteps: (id: string) => fetchJson<StepsData>(`/api/conversations/${id}/steps`),
  skills: () => fetchJson<Skill[]>('/api/skills'),
  workflows: () => fetchJson<Workflow[]>('/api/workflows'),
  rules: () => fetchJson<Rule[]>('/api/rules'),
  mcp: () => fetchJson<McpConfig>('/api/mcp'),
  analytics: () => fetchJson<AnalyticsData>('/api/analytics'),
  conversationFiles: (id: string, q: string) => fetchJson<{ files: any[] }>(`/api/conversations/${id}/files?q=${encodeURIComponent(q)}`),

  createConversation: (workspace: string) =>
    fetchJson<{ cascadeId?: string; error?: string }>('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace }),
    }),

  sendMessage: (id: string, text: string, model?: string, agenticMode: boolean = true, attachments?: any) =>
    fetchJson<{ ok: boolean }>(`/api/conversations/${id}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model, agenticMode, attachments }),
    }),

  proceed: (id: string, artifactUri: string, model?: string) =>
    fetchJson<{ ok: boolean }>(`/api/conversations/${id}/proceed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artifactUri, model }),
    }),

  cancel: (id: string) =>
    fetchJson<{ ok: boolean }>(`/api/conversations/${id}/cancel`, {
      method: 'POST',
    }),

  revert: (id: string, stepIndex: number, model?: string) =>
    fetchJson<{ ok: boolean }>(`/api/conversations/${id}/revert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stepIndex, model }),
    }),

  getRevertPreview: (id: string, stepIndex: number, model?: string) => 
    fetchJson<any>(`/api/conversations/${id}/revert-preview?stepIndex=${stepIndex}${model ? `&model=${encodeURIComponent(model)}` : ''}`),

  launchWorkspace: (workspace: string) =>
    fetchJson<{ ok: boolean; error?: string }>('/api/workspaces/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace }),
    }),

  closeWorkspace: (workspace: string) =>
    fetchJson<{ ok: boolean; error?: string }>('/api/workspaces/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace }),
    }),

  // Knowledge Items
  knowledge: () => fetchJson<KnowledgeItem[]>('/api/knowledge'),
  knowledgeDetail: (id: string) => fetchJson<KnowledgeDetail>(`/api/knowledge/${encodeURIComponent(id)}`),
  updateKnowledge: (id: string, data: { title?: string; summary?: string }) =>
    fetchJson<{ ok: boolean }>(`/api/knowledge/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  deleteKnowledge: (id: string) =>
    fetchJson<{ ok: boolean }>(`/api/knowledge/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  updateKnowledgeArtifact: (id: string, path: string, content: string) =>
    fetchJson<{ ok: boolean }>(`/api/knowledge/${encodeURIComponent(id)}/artifacts/${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }),
};

// WebSocket connection for live step updates
export interface WsExtra {
  totalLength?: number;
  stepCount?: number;
  lastTaskBoundary?: {
    mode?: string;
    taskName?: string;
    taskStatus?: string;
    taskSummary?: string;
  };
}

export function connectWs(
  onSteps: (cascadeId: string, data: StepsData, isActive: boolean, cascadeStatus: string, extra?: WsExtra) => void,
  onStatus: (connected: boolean) => void,
): WebSocket | null {
  if (typeof window === 'undefined') return null;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      const cascadeStatus = msg.cascadeStatus || '';
      const extra: WsExtra = {
        totalLength: msg.totalLength,
        stepCount: msg.stepCount,
        lastTaskBoundary: msg.lastTaskBoundary,
      };
      if (msg.type === 'steps' && msg.cascadeId && msg.data) {
        onSteps(msg.cascadeId, { ...msg.data, cascadeStatus }, !!msg.isActive, cascadeStatus, extra);
      } else if (msg.type === 'status' && msg.cascadeId) {
        // Status-only update (no new steps, just isActive change)
        onSteps(msg.cascadeId, { steps: [], cascadeStatus }, !!msg.isActive, cascadeStatus, extra);
      }
    } catch { /* ignore */ }
  };

  ws.onopen = () => onStatus(true);
  ws.onclose = () => {
    console.warn('[WS] Connection closed, reconnecting in 3s...');
    onStatus(false);
    // auto-reconnect
    setTimeout(() => connectWs(onSteps, onStatus), 3000);
  };

  return ws;
}
