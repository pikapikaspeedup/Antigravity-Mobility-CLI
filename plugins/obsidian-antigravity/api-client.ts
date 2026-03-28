/**
 * Antigravity Gateway API Client
 * Communicates with the local Gateway server via HTTP REST + WebSocket.
 *
 * Features:
 *  - Structured logging via logger module
 *  - WebSocket connection state management with max-retry limit
 *  - Safe JSON parsing for all responses
 *  - Connection status callbacks for UI layer
 */

import { requestUrl, RequestUrlParam } from 'obsidian';
import { logger } from './logger';

const LOG_SRC = 'ApiClient';

export interface Conversation {
  id: string;
  title: string;
  workspace: string;
  mtime: number;
  steps: number;
}

export interface Step {
  type: string;
  status?: string;
  userInput?: { items?: Array<{ text?: string }>; media?: Array<{ mimeType?: string; inlineData?: string; uri?: string }> };
  plannerResponse?: { response?: string; modifiedResponse?: string };
  codeAction?: { actionSpec?: { createFile?: any; editFile?: any; deleteFile?: any } };
  errorMessage?: { message?: string };
  taskBoundary?: { taskName?: string; mode?: string; taskStatus?: string; taskSummary?: string };
  notifyUser?: {
    notificationContent?: string;
    blockedOnUser?: boolean;
    isBlocking?: boolean;
    reviewAbsoluteUris?: string[];
    pathsToReview?: string[];
    shouldAutoProceed?: boolean;
  };
  runCommand?: { command?: string; commandLine?: string; safeToAutoRun?: boolean };
  viewFile?: { absoluteUri?: string };
  grepSearch?: { query?: string; searchPattern?: string };
  searchWeb?: { query?: string; summary?: string };
  listDirectory?: { path?: string };
  find?: { pattern?: string; searchDirectory?: string };
  commandStatus?: any;
  sendCommandInput?: any;
  browserSubagent?: { taskName?: string; task?: string };
  readUrlContent?: { url?: string; summary?: string };
  ephemeralMessage?: any;
}

export interface StepsData {
  steps: Step[];
  cascadeStatus?: string;
}

export interface LanguageServer {
  port: number;
  workspace: string;
}

export interface ModelConfig {
  label: string;
  modelOrAlias?: { model?: string };
  quotaInfo?: { remainingFraction?: number };
  isRecommended?: boolean;
}

export interface ModelsResponse {
  clientModelConfigs?: ModelConfig[];
}

export interface SkillItem {
  name: string;
  description: string;
}

export interface WorkflowItem {
  name: string;
  description: string;
}

export interface FileItem {
  name: string;
  relativePath: string;
  absolutePath?: string;
}

// ── Connection state ──

export type WsConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export type WsStateListener = (state: WsConnectionState, detail?: string) => void;

const WS_MAX_RETRIES = 10;
const WS_BASE_RETRY_MS = 1000;
const WS_MAX_RETRY_MS = 30_000;

export class GatewayClient {
  private baseUrl: string;
  private ws: WebSocket | null = null;
  private wsListeners = new Map<string, (data: any) => void>();
  private wsState: WsConnectionState = 'disconnected';
  private wsStateListeners: WsStateListener[] = [];
  private wsRetryCount = 0;
  private wsRetryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    logger.info(LOG_SRC, 'Client initialized', { baseUrl: this.baseUrl });
  }

  setBaseUrl(url: string) {
    const prev = this.baseUrl;
    this.baseUrl = url.replace(/\/$/, '');
    logger.info(LOG_SRC, 'Base URL changed', { from: prev, to: this.baseUrl });
    this.disconnectWs();
  }

  // ── Connection State ──

  getWsState(): WsConnectionState {
    return this.wsState;
  }

  onWsStateChange(listener: WsStateListener) {
    this.wsStateListeners.push(listener);
  }

  removeWsStateListener(listener: WsStateListener) {
    this.wsStateListeners = this.wsStateListeners.filter(l => l !== listener);
  }

  private setWsState(state: WsConnectionState, detail?: string) {
    if (this.wsState === state) return;
    const prev = this.wsState;
    this.wsState = state;
    logger.info(LOG_SRC, `WS state: ${prev} → ${state}`, detail ? { detail } : undefined);
    for (const l of this.wsStateListeners) {
      try { l(state, detail); } catch (e) { logger.error(LOG_SRC, 'WS state listener error', e); }
    }
  }

  // ── REST API ──

  private async safeRequest(params: RequestUrlParam, label: string): Promise<any> {
    logger.debug(LOG_SRC, `→ ${params.method || 'GET'} ${label}`);
    try {
      const resp = await requestUrl(params);
      let json: any;
      try {
        json = resp.json;
      } catch {
        logger.warn(LOG_SRC, `Response for ${label} is not valid JSON`, { status: resp.status });
        json = null;
      }
      logger.debug(LOG_SRC, `← ${label} OK`, { status: resp.status });
      return json;
    } catch (err: any) {
      logger.error(LOG_SRC, `← ${label} FAILED`, { message: err?.message, status: err?.status });
      throw err;
    }
  }

  async getConversations(workspace?: string): Promise<Conversation[]> {
    const params = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
    const json = await this.safeRequest(
      { url: `${this.baseUrl}/api/conversations${params}` },
      'getConversations',
    );
    return Array.isArray(json) ? json : [];
  }

  async createConversation(workspace: string): Promise<{ cascadeId?: string; error?: string }> {
    const json = await this.safeRequest(
      {
        url: `${this.baseUrl}/api/conversations`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace }),
      },
      'createConversation',
    );
    return json || {};
  }

  async getSteps(cascadeId: string): Promise<StepsData> {
    const json = await this.safeRequest(
      { url: `${this.baseUrl}/api/conversations/${cascadeId}/steps` },
      `getSteps(${cascadeId.slice(0, 8)})`,
    );
    return json || { steps: [] };
  }

  async sendMessage(cascadeId: string, text: string, agenticMode = true, model?: string, attachments?: { media?: { mimeType: string; inlineData: string }[] }): Promise<any> {
    return this.safeRequest(
      {
        url: `${this.baseUrl}/api/conversations/${cascadeId}/send`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, agenticMode, model, attachments }),
      },
      'sendMessage',
    );
  }

  async cancelGeneration(cascadeId: string): Promise<any> {
    return this.safeRequest(
      { url: `${this.baseUrl}/api/conversations/${cascadeId}/cancel`, method: 'POST' },
      'cancelGeneration',
    );
  }

  async getServers(): Promise<LanguageServer[]> {
    const json = await this.safeRequest(
      { url: `${this.baseUrl}/api/servers` },
      'getServers',
    );
    return Array.isArray(json) ? json : [];
  }

  async getModels(): Promise<ModelConfig[]> {
    const json = await this.safeRequest(
      { url: `${this.baseUrl}/api/models` },
      'getModels',
    );
    const data: ModelsResponse = json || {};
    return data.clientModelConfigs || [];
  }

  /**
   * Quick health check — resolves true if gateway is reachable, false otherwise.
   */
  async ping(): Promise<boolean> {
    try {
      await this.getServers();
      return true;
    } catch {
      return false;
    }
  }

  // ── WebSocket ──

  connectWs() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    // Clear any pending retry timer
    if (this.wsRetryTimer) {
      clearTimeout(this.wsRetryTimer);
      this.wsRetryTimer = null;
    }

    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/ws';
    this.setWsState('connecting', wsUrl);

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err: any) {
      logger.error(LOG_SRC, 'WebSocket constructor failed', err?.message);
      this.setWsState('disconnected', 'constructor failed');
      this.scheduleWsRetry();
      return;
    }

    this.ws.onopen = () => {
      logger.info(LOG_SRC, 'WebSocket connected');
      this.wsRetryCount = 0; // reset on successful connect
      this.setWsState('connected');

      // Re-subscribe all active listeners
      for (const cascadeId of this.wsListeners.keys()) {
        this.subscribe(cascadeId);
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string);
        const cascadeId = data.cascadeId;
        if (cascadeId && this.wsListeners.has(cascadeId)) {
          this.wsListeners.get(cascadeId)!(data);
        }
      } catch (err: any) {
        logger.warn(LOG_SRC, 'WS message parse error', err?.message);
      }
    };

    this.ws.onerror = (ev) => {
      logger.error(LOG_SRC, 'WebSocket error', (ev as any)?.message || 'unknown');
    };

    this.ws.onclose = (ev) => {
      logger.info(LOG_SRC, 'WebSocket closed', { code: ev.code, reason: ev.reason });
      this.ws = null;
      this.setWsState('disconnected', `code=${ev.code}`);
      this.scheduleWsRetry();
    };
  }

  private scheduleWsRetry() {
    // Only retry if there are active listeners
    if (this.wsListeners.size === 0) return;

    this.wsRetryCount++;
    if (this.wsRetryCount > WS_MAX_RETRIES) {
      logger.warn(LOG_SRC, `WS max retries (${WS_MAX_RETRIES}) exceeded, stopping auto-reconnect`);
      this.setWsState('disconnected', 'max retries exceeded');
      return;
    }

    // Exponential backoff with jitter: base * 2^(attempt-1) + random jitter
    const backoff = Math.min(WS_BASE_RETRY_MS * Math.pow(2, this.wsRetryCount - 1), WS_MAX_RETRY_MS);
    const jitter = Math.round(Math.random() * backoff * 0.3);
    const delayMs = backoff + jitter;

    logger.info(LOG_SRC, `WS retry ${this.wsRetryCount}/${WS_MAX_RETRIES} in ${delayMs}ms`);
    this.setWsState('reconnecting', `attempt ${this.wsRetryCount}/${WS_MAX_RETRIES}`);

    this.wsRetryTimer = setTimeout(() => {
      this.wsRetryTimer = null;
      this.connectWs();
    }, delayMs);
  }

  /** Reset retry counter and attempt reconnect, typically called by user action. */
  forceReconnectWs() {
    logger.info(LOG_SRC, 'Force reconnect requested');
    this.wsRetryCount = 0;
    this.disconnectWs(/* keepListeners */ true);
    this.connectWs();
  }

  disconnectWs(keepListeners = false) {
    if (this.wsRetryTimer) {
      clearTimeout(this.wsRetryTimer);
      this.wsRetryTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null; // prevent auto-retry on intentional close
      this.ws.close();
      this.ws = null;
    }
    if (!keepListeners) {
      this.wsListeners.clear();
    }
    this.setWsState('disconnected', 'manual');
  }

  subscribe(cascadeId: string, listener?: (data: any) => void) {
    if (listener) {
      this.wsListeners.set(cascadeId, listener);
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe', cascadeId }));
      logger.debug(LOG_SRC, `Subscribed to ${cascadeId.slice(0, 8)}`);
    }
  }

  unsubscribe(cascadeId: string) {
    this.wsListeners.delete(cascadeId);
    logger.debug(LOG_SRC, `Unsubscribed from ${cascadeId.slice(0, 8)}`);
  }

  // ── Skills / Workflows / File Search ──

  async getSkills(): Promise<SkillItem[]> {
    const json = await this.safeRequest(
      { url: `${this.baseUrl}/api/skills` },
      'getSkills',
    );
    return Array.isArray(json) ? json : [];
  }

  async getWorkflows(): Promise<WorkflowItem[]> {
    const json = await this.safeRequest(
      { url: `${this.baseUrl}/api/workflows` },
      'getWorkflows',
    );
    return Array.isArray(json) ? json : [];
  }

  async getConversationFiles(cascadeId: string, query: string): Promise<FileItem[]> {
    const json = await this.safeRequest(
      { url: `${this.baseUrl}/api/conversations/${cascadeId}/files?q=${encodeURIComponent(query)}` },
      `getFiles(${query.slice(0, 20)})`,
    );
    return json?.files || [];
  }

  async proceedArtifact(cascadeId: string, artifactUri: string, model?: string): Promise<any> {
    return this.safeRequest(
      {
        url: `${this.baseUrl}/api/conversations/${cascadeId}/proceed`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artifactUri, model }),
      },
      'proceedArtifact',
    );
  }
}
