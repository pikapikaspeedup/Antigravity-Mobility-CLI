import type {
  Conversation, UserInfo, Server, Skill, Workflow, Rule,
  McpConfig, StepsData, ModelsResponse, WorkspacesResponse, AnalyticsData, HubProject,
  KnowledgeItem, KnowledgeDetail, AgentRun, Project,
  ResumeProjectOptions, ResumeProjectResponse, TemplateSummaryFE,
} from './types';

const API = typeof window !== 'undefined' ? window.location.origin : '';

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${url}`, init);
  const data = await res.json().catch(() => ({} as T));
  if (!res.ok) {
    const err = data as { error?: string; message?: string };
    throw new Error(err.error || err.message || `${res.status} ${res.statusText}`);
  }
  return data as T;
}

export const api = {
  me: () => fetchJson<UserInfo>('/api/me'),
  models: () => fetchJson<ModelsResponse>('/api/models'),
  servers: () => fetchJson<Server[]>('/api/servers'),
  workspaces: () => fetchJson<WorkspacesResponse>('/api/workspaces'),
  hubProjects: () => fetchJson<HubProject[]>('/api/hub-projects'),
  createHubProject: (folderPath: string, name?: string) =>
    fetchJson<HubProject & { reused?: boolean; error?: string }>('/api/hub-projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath, name }),
    }),
  conversations: () => fetchJson<Conversation[]>('/api/conversations'),
  conversationSteps: (id: string) => fetchJson<StepsData>(`/api/conversations/${id}/steps`),
  skills: () => fetchJson<Skill[]>('/api/skills'),
  workflows: () => fetchJson<Workflow[]>('/api/workflows'),
  rules: () => fetchJson<Rule[]>('/api/rules'),
  mcp: () => fetchJson<McpConfig>('/api/mcp'),
  analytics: () => fetchJson<AnalyticsData>('/api/analytics'),
  conversationFiles: (id: string, q: string) => fetchJson<{ files: unknown[] }>(`/api/conversations/${id}/files?q=${encodeURIComponent(q)}`),

  createConversation: (projectId?: string) =>
    fetchJson<{ cascadeId?: string; error?: string }>('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(projectId ? { projectId } : {}),
    }),

  sendMessage: (id: string, text: string, model?: string, agenticMode: boolean = true, attachments?: unknown) =>
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
    fetchJson<unknown>(`/api/conversations/${id}/revert-preview?stepIndex=${stepIndex}${model ? `&model=${encodeURIComponent(model)}` : ''}`),

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

  // Agent Runs & Projects
  projects: () => fetchJson<Project[]>('/api/projects'),
  agentGroups: () => fetchJson<unknown[]>('/api/agent-groups'),
  agentRuns: (status?: string) => fetchJson<AgentRun[]>(`/api/agent-runs${status ? `?status=${status}` : ''}`),
  agentRunsByFilter: (filter: { groupId?: string; status?: string; reviewOutcome?: string }) => {
    const params = new URLSearchParams();
    if (filter.groupId) params.set('groupId', filter.groupId);
    if (filter.status) params.set('status', filter.status);
    if (filter.reviewOutcome) params.set('reviewOutcome', filter.reviewOutcome);
    return fetchJson<AgentRun[]>(`/api/agent-runs?${params.toString()}`);
  },
  agentRun: (id: string) => fetchJson<AgentRun>(`/api/agent-runs/${id}`),
  dispatchRun: (input: {
    groupId?: string;
    templateId?: string;
    projectId?: string;
    hubProjectId?: string;
    workspace?: string;
    prompt?: string;
    model?: string;
    taskEnvelope?: import('./types').TaskEnvelopeFE;
    sourceRunIds?: string[];
  }) =>
    fetchJson<{ runId: string; status: string }>('/api/agent-runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  cancelRun: (id: string) =>
    fetchJson<{ status: string }>(`/api/agent-runs/${id}`, { method: 'DELETE' }),
  interveneRun: (id: string, data: { action: 'nudge' | 'retry' | 'restart_role' | 'cancel' | 'evaluate', prompt?: string, roleId?: string }) =>
    fetchJson<{ status: string; action: string; runId: string }>(`/api/agent-runs/${id}/intervene`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),

  // Pipeline templates
  pipelines: () => fetchJson<TemplateSummaryFE[]>('/api/pipelines'),

  // Project Management
  createProject: (data: { name: string; goal: string; templateId?: string; workspace?: string }) =>
    fetchJson<Project>('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),

  updateProject: (id: string, data: Partial<Project>) =>
    fetchJson<Project>(`/api/projects/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),

  deleteProject: (id: string) =>
    fetchJson<{ success: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),

  // Resume a failed pipeline stage
  resumeProject: (projectId: string, options: ResumeProjectOptions) =>
    fetchJson<ResumeProjectResponse>(`/api/projects/${projectId}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
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
