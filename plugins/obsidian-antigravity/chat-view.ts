/**
 * Antigravity Chat View — Right sidebar panel for Obsidian.
 *
 * Renders a chat interface that talks to the Gateway server.
 * Features: conversation list, message display, input box, real-time streaming,
 *           disconnect banner, heartbeat health check, structured logging.
 */

import { ItemView, WorkspaceLeaf, MarkdownRenderer, setIcon, Menu, Notice } from 'obsidian';
import type AntigravityPlugin from './main';
import type { Conversation, Step, StepsData, ModelConfig, WsConnectionState, SkillItem, WorkflowItem } from './api-client';
import type { PinItem, PromptTemplate } from './settings';
import { logger } from './logger';

const LOG_SRC = 'ChatView';

export const VIEW_TYPE_CHAT = 'antigravity-chat';

const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds

interface AutocompleteItem {
  type: 'skill' | 'workflow' | 'file';
  name: string;
  description: string;
  prefix: string; // text inserted into input
  icon: string;   // Obsidian icon name
}

export class ChatView extends ItemView {
  plugin: AntigravityPlugin;
  private currentCascadeId: string | null = null;
  private steps: Step[] = [];
  private isStreaming = false;
  private agenticMode = true; // true = Planning, false = Fast
  private currentModel = 'MODEL_AUTO';

  // Load persisted preferences
  private loadPreferences() {
    this.agenticMode = this.plugin.settings.lastAgenticMode;
    this.currentModel = this.plugin.settings.lastModel || 'MODEL_AUTO';
  }

  private async savePreferences() {
    this.plugin.settings.lastAgenticMode = this.agenticMode;
    this.plugin.settings.lastModel = this.currentModel;
    await this.plugin.saveSettings();
  }
  private models: ModelConfig[] = [];

  // Autocomplete state
  private skills: SkillItem[] = [];
  private workflows: WorkflowItem[] = [];
  private autocompleteEl: HTMLElement | null = null;
  private autocompleteItems: AutocompleteItem[] = [];
  private autocompleteIdx = 0;
  private autocompleteTrigger: '@' | '/' | null = null;
  private fileSearchTimer: ReturnType<typeof setTimeout> | null = null;

  // DOM refs
  private headerEl!: HTMLElement;
  private disconnectBannerEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private inputContainerEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtnEl!: HTMLButtonElement;
  private conversationListEl!: HTMLElement;
  private showingConversationList = true;
  private gatewayConnected = false;
  private isCheckingGateway = false;

  // Model dropdown cleanup tracking
  private activeDropdown: HTMLElement | null = null;
  private activeDropdownCloseHandler: ((ev: MouseEvent) => void) | null = null;

  // Incremental rendering tracking
  private renderedStepCount = 0;

  // Anti-double-send guard
  private isSending = false;
  private pastedImages: { id: string; dataUrl: string; mimeType: string }[] = [];
  private imagePreviewEl!: HTMLElement;

  // Streaming phase tracking
  private streamingPhase: string | null = null;

  // Context tags for Smart Context UI
  private contextTags: string[] = [];
  private dismissedContextTags = new Set<string>(); // Tags user explicitly removed — prevent re-adding on focus
  private contextBarEl: HTMLElement | null = null;
  private editorSelection: string = '';
  private selectionBarEl: HTMLElement | null = null;
  private selectionEventRef: any = null;
  private selectionCheckTimer: ReturnType<typeof setInterval> | null = null;

  // Pin panel
  private pinBarEl: HTMLElement | null = null;

  // Prompt template picker
  private promptPickerEl: HTMLElement | null = null;

  // Heartbeat
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // WS state listener reference (for cleanup)
  private wsStateListener: ((state: WsConnectionState, detail?: string) => void) | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: AntigravityPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CHAT;
  }

  getDisplayText(): string {
    return 'Google Antigravity';
  }

  getIcon(): string {
    return 'bot';
  }

  async onOpen() {
    logger.info(LOG_SRC, 'Chat view opened');
    this.loadPreferences();
    const container = this.contentEl;
    container.empty();
    container.addClass('antigravity-chat-root');

    // Header
    this.headerEl = container.createDiv({ cls: 'ag-header' });
    this.renderHeader();

    // Disconnect banner (hidden by default)
    this.disconnectBannerEl = container.createDiv({ cls: 'ag-disconnect-banner' });
    this.disconnectBannerEl.hide();

    // Conversation List (initial view)
    this.conversationListEl = container.createDiv({ cls: 'ag-conversation-list' });

    // Messages area
    this.messagesEl = container.createDiv({ cls: 'ag-messages' });
    this.messagesEl.hide();

    // Input area
    this.inputContainerEl = container.createDiv({ cls: 'ag-input-container' });
    this.inputContainerEl.hide();
    this.renderInput();

    // Listen to WebSocket state changes
    this.wsStateListener = (state, detail) => this.onWsStateChange(state, detail);
    this.plugin.client.onWsStateChange(this.wsStateListener);

    // Check gateway, then load data
    await this.checkGateway();

    // Listen to editor selection changes
    this.selectionEventRef = this.app.workspace.on('active-leaf-change', () => {
      this.updateEditorSelection();
    });
    // Periodic selection check (editor selection events aren't exposed directly)
    this.selectionCheckTimer = setInterval(() => this.updateEditorSelection(), 500);

    // Start heartbeat
    this.startHeartbeat();
  }

  async onClose() {
    logger.info(LOG_SRC, 'Chat view closed');
    if (this.currentCascadeId) {
      this.plugin.client.unsubscribe(this.currentCascadeId);
    }
    // Remove WS state listener
    if (this.wsStateListener) {
      this.plugin.client.removeWsStateListener(this.wsStateListener);
      this.wsStateListener = null;
    }
    this.stopHeartbeat();
    // Clean up pending timers
    if (this.fileSearchTimer) {
      clearTimeout(this.fileSearchTimer);
      this.fileSearchTimer = null;
    }
    // Clean up any model dropdown attached to document.body
    this.cleanupModelDropdown();
    // Clean up selection listener
    if (this.selectionEventRef) {
      this.app.workspace.offref(this.selectionEventRef);
      this.selectionEventRef = null;
    }
    if (this.selectionCheckTimer) {
      clearInterval(this.selectionCheckTimer);
      this.selectionCheckTimer = null;
    }
  }

  // ── Heartbeat ──

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.heartbeatCheck(), HEARTBEAT_INTERVAL_MS);
    logger.debug(LOG_SRC, 'Heartbeat started', { intervalMs: HEARTBEAT_INTERVAL_MS });
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async heartbeatCheck() {
    const reachable = await this.plugin.client.ping();
    const wasConnected = this.gatewayConnected;
    this.gatewayConnected = reachable;

    if (wasConnected && !reachable) {
      logger.warn(LOG_SRC, 'Heartbeat: Gateway became unreachable');
      this.renderHeader();
      this.showDisconnectBanner('Gateway connection lost. Retrying...');
    } else if (!wasConnected && reachable) {
      logger.info(LOG_SRC, 'Heartbeat: Gateway recovered');
      this.renderHeader();
      this.hideDisconnectBanner();
      // Reload data after recovery
      if (this.showingConversationList) {
        this.loadConversations();
      }
    }
  }

  // ── WebSocket state handling ──

  private onWsStateChange(state: WsConnectionState, detail?: string) {
    logger.debug(LOG_SRC, `WS state changed: ${state}`, detail);

    switch (state) {
      case 'connected':
        this.hideDisconnectBanner();
        break;
      case 'reconnecting':
        this.showDisconnectBanner(`Reconnecting to server... (${detail || ''})`);
        break;
      case 'disconnected':
        if (detail === 'max retries exceeded') {
          this.showDisconnectBanner(
            'Connection lost. Auto-reconnect failed.',
            true, // show manual reconnect button
          );
        }
        break;
    }
  }

  // ── Disconnect Banner ──

  private showDisconnectBanner(message: string, showReconnectBtn = false) {
    this.disconnectBannerEl.empty();

    const iconEl = this.disconnectBannerEl.createSpan({ cls: 'ag-banner-icon' });
    setIcon(iconEl, 'wifi-off');

    this.disconnectBannerEl.createSpan({ text: message, cls: 'ag-banner-text' });

    if (showReconnectBtn) {
      const reconnectBtn = this.disconnectBannerEl.createEl('button', {
        text: 'Reconnect',
        cls: 'ag-banner-btn',
      });
      reconnectBtn.addEventListener('click', () => {
        this.plugin.client.forceReconnectWs();
        this.checkGateway();
      });
    }

    const dismissBtn = this.disconnectBannerEl.createEl('button', { cls: 'ag-banner-dismiss' });
    setIcon(dismissBtn, 'x');
    dismissBtn.addEventListener('click', () => this.hideDisconnectBanner());

    this.disconnectBannerEl.show();
  }

  private hideDisconnectBanner() {
    this.disconnectBannerEl.hide();
  }

  // ── Gateway Check ──

  private async checkGateway() {
    if (this.isCheckingGateway) return;
    this.isCheckingGateway = true;
    logger.info(LOG_SRC, 'Checking gateway connectivity...');

    try {
      await this.plugin.client.getServers();
      this.gatewayConnected = true;
      logger.info(LOG_SRC, 'Gateway connected');
      this.renderHeader();
      this.hideDisconnectBanner();
      await Promise.all([this.loadConversations(), this.loadModels()]);
    } catch (err: any) {
      this.gatewayConnected = false;
      logger.error(LOG_SRC, 'Gateway unreachable', { message: err?.message });
      this.renderHeader();
      this.showGatewayError();
    } finally {
      this.isCheckingGateway = false;
    }
  }

  private showGatewayError() {
    this.conversationListEl.empty();
    const errorDiv = this.conversationListEl.createDiv({ cls: 'ag-gateway-error' });
    const iconEl = errorDiv.createDiv({ cls: 'ag-gateway-error-icon' });
    setIcon(iconEl, 'wifi-off');
    errorDiv.createDiv({ text: 'Cannot connect to Gateway', cls: 'ag-gateway-error-title' });
    errorDiv.createDiv({
      text: `Make sure Antigravity Gateway is running at:`,
      cls: 'ag-gateway-error-desc',
    });
    errorDiv.createDiv({
      text: this.plugin.settings.gatewayUrl,
      cls: 'ag-gateway-error-url',
    });

    // Troubleshooting tips
    const tipsEl = errorDiv.createDiv({ cls: 'ag-gateway-error-tips' });
    tipsEl.createDiv({ text: 'Troubleshooting:', cls: 'ag-gateway-error-tips-title' });
    const tipsList = tipsEl.createEl('ul');
    tipsList.createEl('li', { text: 'Check if the Gateway server is started' });
    tipsList.createEl('li', { text: 'Verify the URL in plugin Settings' });
    tipsList.createEl('li', { text: 'Check firewall / network settings' });

    // Retry button
    const actionsEl = errorDiv.createDiv({ cls: 'ag-gateway-error-actions' });
    const retryBtn = actionsEl.createEl('button', { text: 'Retry Connection', cls: 'ag-retry-btn' });
    retryBtn.addEventListener('click', () => {
      retryBtn.disabled = true;
      retryBtn.textContent = 'Connecting...';
      retryBtn.addClass('ag-retry-loading');
      this.checkGateway().finally(() => {
        retryBtn.disabled = false;
        retryBtn.textContent = 'Retry Connection';
        retryBtn.removeClass('ag-retry-loading');
      });
    });

    // Settings link
    const settingsBtn = actionsEl.createEl('button', { text: 'Open Settings', cls: 'ag-settings-btn' });
    settingsBtn.addEventListener('click', () => {
      // Open Obsidian settings for this plugin
      (this.app as any).setting?.open?.();
      (this.app as any).setting?.openTabById?.('obsidian-antigravity');
    });
  }

  private async loadModels() {
    try {
      this.models = await this.plugin.client.getModels();
      logger.debug(LOG_SRC, `Loaded ${this.models.length} models`);

      // Validate persisted model still exists
      if (this.currentModel !== 'MODEL_AUTO' && this.models.length > 0) {
        const exists = this.models.some(m => m.modelOrAlias?.model === this.currentModel);
        if (!exists) {
          logger.info(LOG_SRC, `Saved model ${this.currentModel} no longer available, resetting to AUTO`);
          this.currentModel = 'MODEL_AUTO';
        }
      }

      // Auto-select preferred model (Gemini Flash) if current is Auto
      if (this.currentModel === 'MODEL_AUTO' && this.models.length > 0) {
        const flashModel = this.models.find(m => {
          const id = m.modelOrAlias?.model || '';
          const label = m.label || '';
          return /flash/i.test(id) || /flash/i.test(label);
        });
        if (flashModel?.modelOrAlias?.model) {
          this.currentModel = flashModel.modelOrAlias.model;
          logger.info(LOG_SRC, `Auto-selected model: ${this.currentModel}`);
          // Re-render toolbar to show new model
          const toolbar = this.inputContainerEl?.querySelector('.ag-toolbar');
          if (toolbar) this.renderToolbar(toolbar as HTMLElement);
        }
      }
    } catch (err: any) {
      logger.warn(LOG_SRC, 'Failed to load models', { message: err?.message });
    }
  }

  // ── Header ──

  private renderHeader() {
    this.headerEl.empty();

    const titleRow = this.headerEl.createDiv({ cls: 'ag-header-row' });

    // Back button (when in conversation)
    if (!this.showingConversationList) {
      const backBtn = titleRow.createEl('button', { cls: 'ag-icon-btn', attr: { 'aria-label': 'Back to conversations' } });
      setIcon(backBtn, 'arrow-left');
      backBtn.addEventListener('click', () => this.showConversationList());
    }

    titleRow.createSpan({ text: this.showingConversationList ? 'Google Antigravity' : 'Chat', cls: 'ag-title' });

    // Connection status dot
    const statusDot = titleRow.createSpan({
      cls: `ag-status-dot ${this.gatewayConnected ? 'ag-dot-connected' : 'ag-dot-disconnected'}`,
      attr: { 'aria-label': this.gatewayConnected ? 'Connected' : 'Disconnected' },
    });
    statusDot.title = this.gatewayConnected
      ? `Connected to ${this.plugin.settings.gatewayUrl}`
      : 'Gateway not reachable — click to retry';
    if (!this.gatewayConnected) {
      statusDot.addClass('ag-dot-clickable');
      statusDot.addEventListener('click', () => this.checkGateway());
    }

    // Dashboard button
    const dashBtn = titleRow.createEl('button', { cls: 'ag-icon-btn', attr: { 'aria-label': 'Vault Dashboard' } });
    setIcon(dashBtn, 'bar-chart-2');
    dashBtn.title = 'Vault Knowledge Dashboard';
    dashBtn.addEventListener('click', () => {
      (this.app as any).commands?.executeCommandById?.('obsidian-antigravity:vault-dashboard');
    });

    // New conversation button
    const newBtn = titleRow.createEl('button', { cls: 'ag-icon-btn', attr: { 'aria-label': 'New conversation' } });
    setIcon(newBtn, 'plus');
    newBtn.addEventListener('click', () => this.createNewConversation());
  }

  // ── Workspace Resolution ──

  private async getWorkspaceUri(): Promise<string> {
    // 1. Explicit setting
    if (this.plugin.settings.workspaceUri) {
      return this.plugin.settings.workspaceUri;
    }

    // 2. Auto-detect: check if vault path matches any connected workspace
    const vaultPath = (this.app.vault.adapter as any).basePath as string;
    try {
      const servers = await this.plugin.client.getServers();
      for (const s of servers) {
        const ws = s.workspace || '';
        const wsPath = ws.replace('file://', '');
        if (vaultPath.startsWith(wsPath) || wsPath.startsWith(vaultPath)) {
          return ws;
        }
      }
    } catch {
      logger.debug(LOG_SRC, 'Could not auto-detect workspace (gateway unreachable)');
    }

    // 3. Fallback: use vault path as file URI
    return `file://${vaultPath}`;
  }

  // ── Conversation List ──

  private async loadConversations() {
    this.conversationListEl.empty();

    try {
      const workspace = await this.getWorkspaceUri();
      const conversations = await this.plugin.client.getConversations(workspace);
      logger.info(LOG_SRC, `Loaded ${conversations.length} conversations`);

      if (conversations.length === 0) {
        this.conversationListEl.createDiv({ text: 'No conversations yet. Click + to start.', cls: 'ag-empty' });
        return;
      }

      // Sort by mtime descending
      conversations.sort((a: Conversation, b: Conversation) => b.mtime - a.mtime);

      for (const conv of conversations) {
        const item = this.conversationListEl.createDiv({ cls: 'ag-conv-item' });
        const title = item.createDiv({ cls: 'ag-conv-title', text: conv.title || 'Untitled' });
        const meta = item.createDiv({ cls: 'ag-conv-meta' });
        meta.createSpan({ text: `${conv.steps} steps` });
        meta.createSpan({ text: ' · ' });
        meta.createSpan({ text: this.formatTime(conv.mtime) });

        item.addEventListener('click', () => this.openConversation(conv.id));
      }
    } catch (err: any) {
      logger.error(LOG_SRC, 'Failed to load conversations', { message: err?.message });
      this.gatewayConnected = false;
      this.renderHeader();
      this.showGatewayError();
    }
  }

  private showConversationList() {
    if (this.currentCascadeId) {
      this.plugin.client.unsubscribe(this.currentCascadeId);
    }
    this.currentCascadeId = null;
    this.steps = [];
    this.renderedStepCount = 0;
    this.showingConversationList = true;
    this.renderHeader();
    this.conversationListEl.show();
    this.messagesEl.hide();
    this.inputContainerEl.hide();
    this.hideDisconnectBanner();
    this.loadConversations();
  }

  // ── Open Conversation ──

  private async openConversation(cascadeId: string) {
    logger.info(LOG_SRC, `Opening conversation ${cascadeId.slice(0, 8)}`);
    this.currentCascadeId = cascadeId;
    this.showingConversationList = false;
    this.contextTags = [];
    this.dismissedContextTags.clear();
    this.renderContextBar();
    this.renderHeader();
    this.conversationListEl.hide();
    this.messagesEl.show();
    this.inputContainerEl.show();
    this.messagesEl.empty();

    // Load existing steps
    try {
      const data = await this.plugin.client.getSteps(cascadeId);
      this.steps = data.steps || [];
      this.isStreaming = data.cascadeStatus === 'running';
      this.renderMessages(true);
    } catch (err: any) {
      logger.warn(LOG_SRC, 'Failed to load steps', { message: err?.message });
      this.steps = [];
      this.renderMessages(true);
    }

    // Subscribe to real-time updates
    this.plugin.client.connectWs();
    this.plugin.client.subscribe(cascadeId, (data: any) => {
      if (data.type === 'steps' && data.data?.steps) {
        const newSteps = data.data.steps;
        // Monotonic guard: only accept updates with >= step count (prevent delta regression)
        if (newSteps.length >= this.steps.length) {
          const prevLength = this.steps.length;
          this.steps = newSteps;
          this.isStreaming = data.cascadeStatus === 'running';

          // Extract streaming phase from task boundary or last step type
          this.streamingPhase = this.detectStreamingPhase(newSteps, data);

          // If the optimistic step was replaced by server data, force full re-render
          // to avoid duplicate user messages
          if (newSteps.length === prevLength && prevLength > 0) {
            // Same count — just update last step text in-place if PLANNER_RESPONSE
            this.renderMessages();
          } else {
            // Step count changed — server state diverged from optimistic render, full re-render
            this.renderMessages(true);
          }
        } else {
          logger.debug(LOG_SRC, `Ignoring stale steps update: ${newSteps.length} < ${this.steps.length}`);
        }
      } else if (data.type === 'status') {
        this.isStreaming = data.cascadeStatus === 'running';
        if (!this.isStreaming) this.streamingPhase = null;
        this.updateStreamingIndicator();
      }
    });

    // Load skills/workflows for autocomplete (non-blocking)
    this.loadSkillsAndWorkflows();
  }

  private async loadSkillsAndWorkflows() {
    try {
      const [skills, workflows] = await Promise.all([
        this.plugin.client.getSkills(),
        this.plugin.client.getWorkflows(),
      ]);
      this.skills = skills;
      this.workflows = workflows;
      logger.debug(LOG_SRC, `Loaded ${skills.length} skills, ${workflows.length} workflows`);
    } catch (err: any) {
      logger.warn(LOG_SRC, 'Failed to load skills/workflows', { message: err?.message });
    }
  }

  // ── Create Conversation ──

  private async createNewConversation() {
    logger.info(LOG_SRC, 'Creating new conversation...');
    try {
      const workspace = await this.getWorkspaceUri();
      const result = await this.plugin.client.createConversation(workspace);
      if (result.cascadeId) {
        logger.info(LOG_SRC, `Conversation created: ${result.cascadeId.slice(0, 8)}`);
        await this.openConversation(result.cascadeId);
      } else if (result.error) {
        logger.error(LOG_SRC, 'Create conversation returned error', { error: result.error });
        const container = this.showingConversationList ? this.conversationListEl : this.messagesEl;
        container.querySelectorAll('.ag-error').forEach(el => el.remove());
        const errEl = container.createDiv({ cls: 'ag-error' });
        errEl.createSpan({ text: `Error: ${result.error}` });
      }
    } catch (err: any) {
      logger.error(LOG_SRC, 'Create conversation failed', { message: err?.message });
      this.gatewayConnected = false;
      this.renderHeader();
      if (this.showingConversationList) {
        this.showGatewayError();
      } else {
        this.messagesEl.querySelectorAll('.ag-error').forEach(el => el.remove());
        const errEl = this.messagesEl.createDiv({ cls: 'ag-error' });
        errEl.createSpan({ text: 'Gateway unreachable. ' });
        const retryLink = errEl.createEl('a', { text: 'Retry', cls: 'ag-error-link' });
        retryLink.addEventListener('click', (e) => {
          e.preventDefault();
          this.checkGateway();
        });
      }
    }
  }

  // ── Messages Rendering ──

  /**
   * Render messages with incremental appending.
   * @param forceFullRender - if true, clears and re-renders everything (used on initial load / conversation switch)
   */
  private renderMessages(forceFullRender = false) {
    if (forceFullRender) {
      this.messagesEl.empty();
      this.renderedStepCount = 0;
    }

    if (this.steps.length === 0 && !this.isStreaming) {
      this.messagesEl.empty();
      this.renderedStepCount = 0;
      this.renderEmptyState();
      return;
    }

    // Remove empty placeholder if present
    const emptyEl = this.messagesEl.querySelector('.ag-empty');
    if (emptyEl) emptyEl.remove();

    // If steps were truncated/replaced (e.g. server sent fewer steps), do a full re-render
    if (this.steps.length < this.renderedStepCount) {
      this.messagesEl.empty();
      this.renderedStepCount = 0;
    }

    // If step count unchanged but streaming, re-render the last step ONLY if it's a PLANNER_RESPONSE
    // (text content may still be growing). Other step types are stable once rendered.
    if (this.isStreaming && this.steps.length === this.renderedStepCount && this.steps.length > 0) {
      const lastStep = this.steps[this.steps.length - 1];
      const lastStepType = (lastStep?.type || '').replace('CORTEX_STEP_TYPE_', '');
      if (lastStepType === 'PLANNER_RESPONSE') {
        // Find and remove the last ag-msg-assistant element specifically
        const assistantMsgs = this.messagesEl.querySelectorAll('.ag-msg-assistant');
        const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
        if (lastAssistant) lastAssistant.remove();
        this.renderedStepCount--;
      }
    }

    // Only render new steps
    for (let i = this.renderedStepCount; i < this.steps.length; i++) {
      const step = this.steps[i];
      this.renderStep(step);
    }
    this.renderedStepCount = this.steps.length;

    this.updateStreamingIndicator();

    // Scroll to bottom
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private renderStep(step: Step) {
    if (!step || !step.type) return;
    const type = step.type.replace('CORTEX_STEP_TYPE_', '');

    switch (type) {
      case 'USER_INPUT':
        this.renderUserMessage(step);
        break;
      case 'PLANNER_RESPONSE':
        this.renderAssistantMessage(step);
        break;
      case 'CODE_ACTION':
        this.renderCodeAction(step);
        break;
      case 'RUN_COMMAND':
        this.renderToolStep(step, 'terminal', step.runCommand?.command || step.runCommand?.commandLine || '');
        break;
      case 'VIEW_FILE':
        this.renderToolStep(step, 'eye', `View ${(step.viewFile?.absoluteUri || '').split('/').pop() || 'file'}`);
        break;
      case 'GREP_SEARCH':
        this.renderToolStep(step, 'search', `Search: ${step.grepSearch?.query || step.grepSearch?.searchPattern || '...'}`);
        break;
      case 'SEARCH_WEB':
        this.renderSearchWeb(step);
        break;
      case 'LIST_DIRECTORY':
        this.renderToolStep(step, 'folder-open', `List ${(step.listDirectory?.path || '').split('/').pop() || '...'}`);
        break;
      case 'FIND':
        this.renderToolStep(step, 'file-search', `Find ${step.find?.pattern || '...'}`);
        break;
      case 'COMMAND_STATUS':
        this.renderToolStep(step, 'terminal', 'Command output');
        break;
      case 'SEND_COMMAND_INPUT':
        this.renderToolStep(step, 'keyboard', 'Send input');
        break;
      case 'BROWSER_SUBAGENT':
        this.renderToolStep(step, 'monitor', step.browserSubagent?.taskName || step.browserSubagent?.task?.slice(0, 40) || 'Browser task');
        break;
      case 'READ_URL_CONTENT':
        this.renderToolStep(step, 'link', `Read URL`);
        break;
      case 'NOTIFY_USER':
        this.renderNotifyUser(step);
        break;
      case 'ERROR_MESSAGE':
        this.renderError(step);
        break;
      case 'TASK_BOUNDARY':
        this.renderTaskBoundary(step);
        break;
    }
  }

  private renderUserMessage(step: Step) {
    const bubble = this.messagesEl.createDiv({ cls: 'ag-msg ag-msg-user' });
    const items = step.userInput?.items || [];
    const text = items.map(i => i.text || '').filter(Boolean).join('\n');

    // Render attached images
    const media = step.userInput?.media || [];
    if (media.length > 0) {
      const mediaRow = bubble.createDiv({ cls: 'ag-msg-media' });
      for (const m of media) {
        const src = m.inlineData
          ? `data:${m.mimeType || 'image/png'};base64,${m.inlineData}`
          : (m.uri || '');
        if (src) {
          const img = mediaRow.createEl('img', {
            cls: 'ag-msg-image',
            attr: { src },
          });
          img.style.cssText = 'max-width: 200px; max-height: 200px; border-radius: 8px; object-fit: cover; cursor: pointer;';
          img.addEventListener('click', () => window.open(src, '_blank'));
        }
      }
    }

    // Display user message with absolute paths shortened to vault-relative
    const displayText = this.shortenPaths(text || (media.length > 0 ? '' : '(empty)'));
    bubble.createDiv({ text: displayText, cls: 'ag-msg-text' });
  }

  /** Replace @[/absolute/vault/path/file.md] with @[file.md] in display text */
  private shortenPaths(text: string): string {
    const vaultBase = (this.app.vault.adapter as any).basePath as string;
    if (!vaultBase) return text;
    // Replace @[vaultBase/relative/path] → @[relative/path]
    return text.replace(/@\[([^\]]+)\]/g, (_match, fullPath: string) => {
      if (fullPath.startsWith(vaultBase)) {
        const rel = fullPath.slice(vaultBase.length).replace(/^\//, '');
        return `@[${rel}]`;
      }
      return _match;
    });
  }

  private renderAssistantMessage(step: Step) {
    const pr = step.plannerResponse || {};
    const text = pr.modifiedResponse || pr.response || '';
    if (!text) return;

    const bubble = this.messagesEl.createDiv({ cls: 'ag-msg ag-msg-assistant' });
    const contentEl = bubble.createDiv({ cls: 'ag-msg-text' });

    // Render as markdown
    MarkdownRenderer.render(this.app, text, contentEl, '', this.plugin);

    // Enhance code blocks: add language label + copy button
    this.enhanceCodeBlocks(contentEl);

    // Auto-link vault note names in AI responses
    this.autoWikiLink(contentEl);

    // Copy button
    const copyBtn = bubble.createDiv({ cls: 'ag-copy-btn', attr: { 'aria-label': 'Copy' } });
    setIcon(copyBtn, 'copy');
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(text);
      copyBtn.empty();
      setIcon(copyBtn, 'check');
      setTimeout(() => { copyBtn.empty(); setIcon(copyBtn, 'copy'); }, 1500);
    });

    // Context menu (right-click)
    bubble.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const menu = new Menu();
      menu.addItem((item) =>
        item.setTitle('Copy as Markdown').setIcon('copy').onClick(() => {
          navigator.clipboard.writeText(text);
        }),
      );
      menu.addItem((item) =>
        item.setTitle('Copy as Plain Text').setIcon('file-text').onClick(() => {
          navigator.clipboard.writeText(contentEl.textContent || text);
        }),
      );
      menu.addSeparator();
      menu.addItem((item) =>
        item.setTitle('Insert into Active Note').setIcon('file-input').onClick(async () => {
          const activeLeaf = this.app.workspace.getMostRecentLeaf();
          const editor = activeLeaf?.view && 'editor' in activeLeaf.view
            ? (activeLeaf.view as any).editor
            : null;
          if (editor) {
            // Insert at cursor position
            editor.replaceSelection(text);
            logger.info(LOG_SRC, 'Inserted response at cursor');
            new Notice('Inserted into note');
          } else {
            // Fallback: append to active file
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile) {
              const content = await this.app.vault.read(activeFile);
              await this.app.vault.modify(activeFile, content + '\n\n' + text);
              logger.info(LOG_SRC, `Appended response to ${activeFile.path}`);
            } else {
              logger.warn(LOG_SRC, 'No active editor or file to insert into');
            }
          }
        }),
      );
      menu.addItem((item) =>
        item.setTitle('Create Note from Response').setIcon('file-plus').onClick(async () => {
          const fileName = `AI Response ${new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-')}.md`;
          await this.app.vault.create(fileName, text);
          await this.app.workspace.openLinkText(fileName, '', false);
          logger.info(LOG_SRC, `Created note: ${fileName}`);
        }),
      );
      menu.showAtMouseEvent(e);
    });
  }

  private renderCodeAction(step: Step) {
    const spec = step.codeAction?.actionSpec || {};
    const fileSpec = spec.createFile || spec.editFile || spec.deleteFile;
    if (!fileSpec) return;

    const action = spec.createFile ? 'Created' : spec.deleteFile ? 'Deleted' : 'Edited';
    const rawPath = fileSpec.absoluteUri || fileSpec.path?.absoluteUri || fileSpec.path || '';
    const uri = typeof rawPath === 'string' ? rawPath : '';
    let decoded = uri;
    try { decoded = decodeURIComponent(uri); } catch {}
    const fileName = decoded.split('/').pop() || (step.codeAction as any)?.description?.slice(0, 40) || '?';
    const icon = spec.createFile ? 'file-plus' : spec.deleteFile ? 'file-minus' : 'file-edit';
    const cls = spec.createFile ? 'ag-step-create' : spec.deleteFile ? 'ag-step-delete' : 'ag-step-edit';

    const el = this.messagesEl.createDiv({ cls: `ag-step ag-step-clickable ${cls}` });
    this.renderStepStatus(step, el);
    const iconSpan = el.createSpan({ cls: 'ag-step-icon' });
    setIcon(iconSpan, icon);
    el.createSpan({ text: `${action} ${fileName}`, cls: 'ag-step-text' });

    if (uri) {
      el.addEventListener('click', () => {
        const filePath = uri.startsWith('file://') ? uri.replace(/^file:\/\//, '') : uri;
        const vaultPath = (this.app.vault.adapter as any).basePath || '';
        const relativePath = filePath.startsWith(vaultPath)
          ? filePath.slice(vaultPath.length).replace(/^\//, '')
          : filePath.startsWith('/')
            ? filePath.split('/').pop() || fileName
            : filePath || fileName;
        this.app.workspace.openLinkText(relativePath, '', false);
      });
    }
  }

  private renderToolStep(step: Step, icon: string, text: string) {
    const el = this.messagesEl.createDiv({ cls: 'ag-step ag-step-tool' });
    this.renderStepStatus(step, el);
    const iconSpan = el.createSpan({ cls: 'ag-step-icon' });
    setIcon(iconSpan, icon);
    el.createSpan({ text: text.slice(0, 80), cls: 'ag-step-text' });
  }

  private renderSearchWeb(step: Step) {
    const sw = step.searchWeb || {};
    const query = sw.query || '...';
    const summary = sw.summary || '';

    const el = this.messagesEl.createDiv({ cls: 'ag-step ag-step-search' });
    this.renderStepStatus(step, el);
    const iconSpan = el.createSpan({ cls: 'ag-step-icon' });
    setIcon(iconSpan, 'globe');

    const contentDiv = el.createDiv({ cls: 'ag-search-content' });
    contentDiv.createDiv({ text: query, cls: 'ag-search-query' });
    const searchIcon = el.querySelector('.ag-search-query');
    if (searchIcon) {
      const iconEl = document.createElement('span');
      iconEl.className = 'ag-search-icon';
      setIcon(iconEl, 'search');
      searchIcon.prepend(iconEl, ' ');
    }
    if (summary) {
      contentDiv.createDiv({ text: summary.slice(0, 200), cls: 'ag-search-summary' });
    }
  }

  private renderNotifyUser(step: Step) {
    const nu = step.notifyUser;
    if (!nu) return;
    const content = nu.notificationContent || '';
    const blocked = nu.blockedOnUser ?? nu.isBlocking ?? false;
    const reviewPaths = nu.pathsToReview || nu.reviewAbsoluteUris || [];
    const autoProc = nu.shouldAutoProceed ?? false;

    const el = this.messagesEl.createDiv({ cls: `ag-msg ag-msg-notify ${blocked ? 'ag-msg-blocked' : ''}` });

    // Notification content
    if (content) {
      const contentEl = el.createDiv({ cls: 'ag-msg-text' });
      MarkdownRenderer.render(this.app, content, contentEl, '', this.plugin);
    }

    // Review paths (artifact files to review)
    if (reviewPaths.length > 0) {
      const reviewEl = el.createDiv({ cls: 'ag-review-paths' });
      reviewEl.createDiv({ text: 'Files to review:', cls: 'ag-review-label' });
      for (const uri of reviewPaths) {
        const decoded = decodeURIComponent(uri);
        const fileName = decoded.split('/').pop() || decoded;
        const pathEl = reviewEl.createDiv({ cls: 'ag-review-path' });
        const iconSpan = pathEl.createSpan({ cls: 'ag-review-path-icon' });
        setIcon(iconSpan, 'file-text');
        pathEl.createSpan({ text: fileName, cls: 'ag-review-path-name' });

        // Expand/collapse content preview
        let previewEl: HTMLElement | null = null;
        let expanded = false;
        let fileContent = ''; // cache the read content

        pathEl.addEventListener('click', () => {
          const filePath = decoded.replace(/^file:\/\//, '');
          const vaultPath = (this.app.vault.adapter as any).basePath || '';

          if (filePath.startsWith(vaultPath)) {
            // File inside vault → open in Obsidian
            const relativePath = filePath.slice(vaultPath.length).replace(/^\//, '');
            this.app.workspace.openLinkText(relativePath, '', false);
          } else {
            // File outside vault → read and show inline
            if (expanded && previewEl) {
              previewEl.remove();
              previewEl = null;
              expanded = false;
              return;
            }
            try {
              const fs = require('fs');
              fileContent = fs.readFileSync(filePath, 'utf-8') as string;
              previewEl = reviewEl.createDiv({ cls: 'ag-review-preview' });

              // Action buttons for artifact content
              const actionsBar = previewEl.createDiv({ cls: 'ag-artifact-actions' });

              const copyBtn = actionsBar.createEl('button', { cls: 'ag-artifact-action-btn' });
              setIcon(copyBtn, 'copy');
              copyBtn.createSpan({ text: ' Copy' });
              copyBtn.addEventListener('click', async (ev) => {
                ev.stopPropagation();
                await navigator.clipboard.writeText(fileContent);
                copyBtn.textContent = '✓ Copied';
                setTimeout(() => { copyBtn.empty(); setIcon(copyBtn, 'copy'); copyBtn.createSpan({ text: ' Copy' }); }, 1500);
              });

              const appendBtn = actionsBar.createEl('button', { cls: 'ag-artifact-action-btn' });
              setIcon(appendBtn, 'file-plus');
              appendBtn.createSpan({ text: ' Append to Note' });
              appendBtn.addEventListener('click', async (ev) => {
                ev.stopPropagation();
                const activeFile = this.app.workspace.getActiveFile();
                if (!activeFile) {
                  new Notice('No active note open');
                  return;
                }
                await this.app.vault.append(activeFile, '\n\n' + fileContent);
                new Notice(`✓ Appended to ${activeFile.name}`);
                appendBtn.empty(); setIcon(appendBtn, 'check'); appendBtn.createSpan({ text: ' Appended' });
                setTimeout(() => { appendBtn.empty(); setIcon(appendBtn, 'file-plus'); appendBtn.createSpan({ text: ' Append to Note' }); }, 2000);
              });

              const insertBtn = actionsBar.createEl('button', { cls: 'ag-artifact-action-btn' });
              setIcon(insertBtn, 'pin');
              insertBtn.createSpan({ text: ' Insert at Cursor' });
              insertBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const editor = this.app.workspace.activeEditor?.editor;
                if (!editor) {
                  new Notice('No active editor');
                  return;
                }
                const cursor = editor.getCursor();
                editor.replaceRange('\n' + fileContent + '\n', cursor);
                new Notice('✓ Inserted at cursor');
                insertBtn.textContent = '✓ Inserted';
                setTimeout(() => { insertBtn.empty(); setIcon(insertBtn, 'pin'); insertBtn.createSpan({ text: ' Insert at Cursor' }); }, 2000);
              });

              const previewContent = previewEl.createDiv({ cls: 'ag-msg-text' });
              MarkdownRenderer.render(this.app, fileContent.slice(0, 5000), previewContent, '', this.plugin);
              if (fileContent.length > 5000) {
                previewEl.createDiv({ text: `... (${fileContent.length} chars total)`, cls: 'ag-review-truncated' });
              }
              expanded = true;
            } catch (err: any) {
              logger.warn(LOG_SRC, 'Cannot read artifact file', { path: filePath, error: err?.message });
              new Notice(`Cannot open: ${fileName}`);
            }
          }
        });
      }
    }

    // Proceed button (when blocked and not auto-proceeding)
    if (blocked && !autoProc) {
      // Check if there's a follow-up step (already proceeded)
      const stepIdx = this.steps.indexOf(step);
      const hasFollowup = stepIdx >= 0 && stepIdx < this.steps.length - 1;

      if (!hasFollowup) {
        const actionsEl = el.createDiv({ cls: 'ag-proceed-actions' });

        const proceedBtn = actionsEl.createEl('button', { text: '✓ Proceed', cls: 'ag-proceed-btn' });
        proceedBtn.addEventListener('click', async () => {
          if (!this.currentCascadeId) return;
          proceedBtn.disabled = true;
          proceedBtn.textContent = 'Proceeding...';
          try {
            const artifactUri = reviewPaths[0] || '';
            const model = this.currentModel !== 'MODEL_AUTO' ? this.currentModel : undefined;
            await this.plugin.client.proceedArtifact(this.currentCascadeId, artifactUri, model);
            proceedBtn.textContent = '✓ Proceeded';
            this.isStreaming = true;
            this.updateStreamingIndicator();
          } catch (err: any) {
            proceedBtn.textContent = '✗ Failed — Retry';
            proceedBtn.disabled = false;
            logger.error(LOG_SRC, 'Proceed failed', { message: err?.message });
          }
        });
      } else {
        el.createDiv({ text: '✓ Proceeded', cls: 'ag-proceed-done' });
      }
    }

    // Auto-proceed indicator
    if (autoProc) {
      const autoLabel = el.createDiv({ cls: 'ag-auto-proceed' });
      setIcon(autoLabel, 'zap');
      autoLabel.createSpan({ text: ' Auto-proceeded' });
    }
  }

  private renderStepStatus(step: Step, container: HTMLElement): HTMLSpanElement | null {
    const status = step.status || '';
    if (status.includes('RUNNING') || status.includes('GENERATING')) {
      const s = container.createSpan({ cls: 'ag-step-status ag-status-running' });
      setIcon(s, 'loader-2');
      return s;
    }
    if (status.includes('PENDING')) {
      const s = container.createSpan({ cls: 'ag-step-status ag-status-pending' });
      setIcon(s, 'clock');
      return s;
    }
    if (status.includes('ERROR')) {
      const s = container.createSpan({ cls: 'ag-step-status ag-status-error' });
      setIcon(s, 'x-circle');
      return s;
    }
    return null;
  }

  private renderError(step: Step) {
    const msg = step.errorMessage?.message || 'Unknown error';
    const el = this.messagesEl.createDiv({ cls: 'ag-step ag-step-error' });
    const warnEl = el.createSpan();
    setIcon(warnEl, 'alert-triangle');
    warnEl.createSpan({ text: ` ${msg.slice(0, 200)}` });
  }

  private renderTaskBoundary(step: Step) {
    const tb = step.taskBoundary;
    if (!tb || !tb.taskStatus) return;

    const el = this.messagesEl.createDiv({ cls: 'ag-step ag-step-boundary' });
    el.createSpan({
      text: `${tb.mode || ''} ${tb.taskName || ''} — ${tb.taskStatus}`.trim(),
      cls: 'ag-step-text',
    });
    if (tb.taskSummary) {
      el.createDiv({ text: tb.taskSummary, cls: 'ag-step-summary' });
    }
  }

  private renderEmptyState() {
    const container = this.messagesEl.createDiv({ cls: 'ag-empty-state' });

    const iconEl = container.createDiv({ cls: 'ag-empty-icon' });
    setIcon(iconEl, 'sparkles');

    container.createDiv({ text: 'What can I help with?', cls: 'ag-empty-title' });

    // Quick action cards based on context
    const cards = container.createDiv({ cls: 'ag-empty-cards' });

    const activeFile = this.app.workspace.getActiveFile();

    const suggestions: { icon: string; text: string; prompt: string }[] = [];

    if (activeFile) {
      suggestions.push(
        { icon: 'text', text: `Summarize ${activeFile.basename}`, prompt: `Summarize the key points of this note.` },
        { icon: 'sparkles', text: `Improve writing`, prompt: `Help me improve the writing in this note. Make it clearer and more polished.` },
      );
    }

    suggestions.push(
      { icon: 'search', text: 'Find in vault', prompt: 'Search my vault for notes about ' },
      { icon: 'lightbulb', text: 'Brainstorm ideas', prompt: 'Help me brainstorm ideas about ' },
    );

    for (const s of suggestions.slice(0, 4)) {
      const card = cards.createDiv({ cls: 'ag-empty-card' });
      const cardIcon = card.createSpan({ cls: 'ag-empty-card-icon' });
      setIcon(cardIcon, s.icon);
      card.createSpan({ text: s.text, cls: 'ag-empty-card-text' });

      card.addEventListener('click', () => {
        this.inputEl.value = s.prompt;
        this.inputEl.focus();
        this.inputEl.style.height = 'auto';
        this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 150) + 'px';
      });
    }
  }

  private updateStreamingIndicator() {
    const existing = this.messagesEl.querySelector('.ag-streaming');
    if (existing) existing.remove();

    if (this.isStreaming) {
      const indicator = this.messagesEl.createDiv({ cls: 'ag-streaming' });
      const phase = this.streamingPhase || 'Thinking';

      // Phase-specific icon
      const phaseIcons: Record<string, string> = {
        'Thinking': 'brain',
        'Planning': 'map',
        'Executing': 'play',
        'Writing': 'pencil',
        'Coding': 'code',
        'Running command': 'terminal',
        'Searching': 'search',
        'Reading file': 'file-text',
        'Browsing': 'globe',
        'Exploring': 'folder-open',
        'Verifying': 'check-circle',
        'Reviewing': 'eye',
        'Browser task': 'monitor',
      };
      const iconName = phaseIcons[phase] || 'loader-2';
      const iconEl = indicator.createSpan({ cls: 'ag-streaming-icon' });
      setIcon(iconEl, iconName);

      indicator.createSpan({ text: phase, cls: 'ag-streaming-text' });
      const dots = indicator.createSpan({ cls: 'ag-streaming-dots' });
      dots.createSpan({ text: '.' });
      dots.createSpan({ text: '.' });
      dots.createSpan({ text: '.' });
    }

    // Update send button state
    if (this.sendBtnEl) {
      if (this.isStreaming) {
        setIcon(this.sendBtnEl, 'square');
        this.sendBtnEl.title = 'Cancel';
      } else {
        setIcon(this.sendBtnEl, 'send');
        this.sendBtnEl.title = 'Send';
      }
    }
  }

  // ── Input ──

  private renderInput() {
    // Autocomplete dropdown (positioned above input)
    this.autocompleteEl = this.inputContainerEl.createDiv({ cls: 'ag-autocomplete' });
    this.autocompleteEl.hide();

    // Toolbar row: mode toggle + attach + model selector
    const toolbar = this.inputContainerEl.createDiv({ cls: 'ag-toolbar' });
    this.renderToolbar(toolbar);

    // Context bar (shows attached context files)
    this.contextBarEl = this.inputContainerEl.createDiv({ cls: 'ag-context-bar' });
    this.contextBarEl.hide();

    // Image preview area
    this.imagePreviewEl = this.inputContainerEl.createDiv({ cls: 'ag-image-preview' });
    this.imagePreviewEl.hide();

    // Selection preview bar (shows selected editor text)
    this.selectionBarEl = this.inputContainerEl.createDiv({ cls: 'ag-selection-bar' });
    this.selectionBarEl.hide();

    // Pin bar (shows pinned selections)
    this.pinBarEl = this.inputContainerEl.createDiv({ cls: 'ag-pin-bar' });
    this.pinBarEl.hide();
    this.renderPinBar();

    // Prompt picker (hidden, shown with /prompt or button)
    this.promptPickerEl = this.inputContainerEl.createDiv({ cls: 'ag-prompt-picker' });
    this.promptPickerEl.hide();

    const row = this.inputContainerEl.createDiv({ cls: 'ag-input-row' });

    this.inputEl = row.createEl('textarea', {
      cls: 'ag-input',
      attr: { placeholder: 'Ask anything... ⌘Enter to send', rows: '1' },
    });

    // Auto-resize textarea
    this.inputEl.addEventListener('input', () => {
      this.inputEl.style.height = 'auto';
      this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 150) + 'px';
      this.handleAutocomplete();
    });

    // Show Smart Context preview on focus
    this.inputEl.addEventListener('focus', () => {
      if (!this.inputEl.value.includes('@[')) {
        this.previewSmartContext();
      }
    });

    // Keyboard navigation for autocomplete + send
    this.inputEl.addEventListener('keydown', (e) => {
      if (this.autocompleteTrigger && this.autocompleteItems.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.autocompleteIdx = (this.autocompleteIdx + 1) % this.autocompleteItems.length;
          this.renderAutocompleteItems();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          this.autocompleteIdx = (this.autocompleteIdx - 1 + this.autocompleteItems.length) % this.autocompleteItems.length;
          this.renderAutocompleteItems();
          return;
        }
        if (e.key === 'Tab' || e.key === 'Enter') {
          e.preventDefault();
          this.insertAutocompleteItem(this.autocompleteItems[this.autocompleteIdx]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          this.hideAutocomplete();
          return;
        }
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.handleSend();
      }
    });

    // Handle paste of obsidian:// links AND images
    this.inputEl.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text/plain') || '';
      if (text.includes('obsidian://open')) {
        e.preventDefault();
        this.insertObsidianLink(text);
        return;
      }

      // Handle pasted images
      const items = e.clipboardData?.items;
      if (items) {
        for (let i = 0; i < items.length; i++) {
          if (items[i].type.startsWith('image/')) {
            const file = items[i].getAsFile();
            if (!file) continue;
            const reader = new FileReader();
            reader.onload = (ev) => {
              this.pastedImages.push({
                id: Math.random().toString(36).slice(2),
                dataUrl: ev.target?.result as string,
                mimeType: file.type,
              });
              this.renderImagePreview();
            };
            reader.readAsDataURL(file);
          }
        }
      }
    });

    // Handle drop of obsidian:// links or pinned items (#8)
    this.inputEl.addEventListener('drop', (e) => {
      // #8 Pin drag-drop
      const pinId = e.dataTransfer?.getData('application/x-ag-pin-id');
      if (pinId) {
        e.preventDefault();
        const pin = (this.plugin.settings.pins || []).find(p => p.id === pinId);
        if (pin) {
          const vaultBase = (this.app.vault.adapter as any).basePath as string;
          const lineInfo = pin.startLine > 0 ? ` (L${pin.startLine}-${pin.endLine})` : '';
          const pinText = `@[${vaultBase}/${pin.filePath}]\n[Pinned${lineInfo}]\n\`\`\`\n${pin.text}\n\`\`\`\n`;
          this.insertAtCursor(pinText);
        }
        return;
      }

      const text = e.dataTransfer?.getData('text/plain') || e.dataTransfer?.getData('text/uri-list') || '';
      if (text.includes('obsidian://open')) {
        e.preventDefault();
        this.insertObsidianLink(text);
      }
    });

    // Allow drop on textarea
    this.inputEl.addEventListener('dragover', (e) => e.preventDefault());

    this.sendBtnEl = row.createEl('button', { cls: 'ag-send-btn', attr: { 'aria-label': 'Send message' } });
    setIcon(this.sendBtnEl, 'send');
    this.sendBtnEl.addEventListener('click', () => this.handleSend());
  }

  // ── Obsidian Link Conversion ──

  /**
   * Convert obsidian://open?vault=X&file=Y into @[absolute-path] and insert at cursor.
   * Resolves the file path using the vault's base directory so Gateway can locate it.
   */
  private insertObsidianLink(rawText: string) {
    const lines = rawText.split(/[\n\r]+/);
    const converted: string[] = [];
    const vaultBasePath = (this.app.vault.adapter as any).basePath as string;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('obsidian://open')) {
        try {
          const url = new URL(trimmed);
          const filePath = url.searchParams.get('file');
          if (filePath) {
            const decoded = decodeURIComponent(filePath);

            // Try to resolve within vault (handles missing .md extension)
            let resolvedPath = decoded;
            const abstractFile = this.app.vault.getAbstractFileByPath(decoded)
              || this.app.vault.getAbstractFileByPath(decoded + '.md');
            if (abstractFile) {
              resolvedPath = abstractFile.path;
            } else if (!decoded.includes('.')) {
              // No extension and not found — assume .md
              resolvedPath = decoded + '.md';
            }

            // Build absolute path so Gateway resolves correctly
            const absolutePath = `${vaultBasePath}/${resolvedPath}`;
            converted.push(`@[${absolutePath}] `);
            logger.debug(LOG_SRC, `Obsidian link → @[${absolutePath}]`);
            continue;
          }
        } catch { /* not a valid URL — fall through */ }
      }
      if (trimmed) converted.push(trimmed);
    }

    if (converted.length > 0) {
      this.insertAtCursor(converted.join(''));
    }
  }

  // ── Autocomplete Engine ──

  private handleAutocomplete() {
    const cursorPos = this.inputEl.selectionStart || 0;
    const textBeforeCursor = this.inputEl.value.slice(0, cursorPos);

    const slashMatch = textBeforeCursor.match(/(^|\s)\/([\w-]*)$/);
    const tagMatch = textBeforeCursor.match(/(^|\s)@#([\w\/\-\u4e00-\u9fff]*)$/);
    const atMatch = textBeforeCursor.match(/(^|\s)@([\w\/\.\-\u4e00-\u9fff]*)$/);

    if (slashMatch) {
      const q = slashMatch[2].toLowerCase();
      this.autocompleteTrigger = '/';

      // Workflow matches
      const workflowItems: AutocompleteItem[] = this.workflows
        .filter(w => w.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map(w => ({
          type: 'workflow', name: w.name, description: w.description || '',
          prefix: `/${w.name} `, icon: 'zap',
        }));

      // #6 Prompt template matches (shown as /prompt:name)
      const promptItems: AutocompleteItem[] = (this.plugin.settings.promptTemplates || [])
        .filter(t => t.name.toLowerCase().includes(q) || 'prompt'.includes(q))
        .slice(0, 6)
        .map(t => ({
          type: 'skill' as const, name: `${t.icon} ${t.name}`, description: t.prompt.slice(0, 50),
          prefix: `__prompt__${t.id}__`, icon: 'file-text',
        }));

      this.showAutocomplete([...workflowItems, ...promptItems]);
    } else if (tagMatch) {
      // @#tag — search tags in vault
      const q = tagMatch[2].toLowerCase();
      this.autocompleteTrigger = '@';
      const tagItems = this.searchTags(q);
      this.showAutocomplete(tagItems);
    } else if (atMatch) {
      const q = atMatch[2].toLowerCase();
      this.autocompleteTrigger = '@';

      // Skill matches (immediate)
      const skillItems: AutocompleteItem[] = this.skills
        .filter(s => s.name.toLowerCase().includes(q))
        .slice(0, 5)
        .map(s => ({
          type: 'skill', name: s.name, description: s.description || '',
          prefix: `@${s.name} `, icon: 'puzzle',
        }));

      this.showAutocomplete(skillItems);

      // File search (debounced)
      if (this.fileSearchTimer) clearTimeout(this.fileSearchTimer);
      if (this.currentCascadeId && q.length > 0) {
        this.fileSearchTimer = setTimeout(async () => {
          try {
            const files = await this.plugin.client.getConversationFiles(this.currentCascadeId!, q);
            if (this.autocompleteTrigger !== '@') return; // menu closed while searching
            const fileItems: AutocompleteItem[] = files.slice(0, 10).map(f => ({
              type: 'file', name: f.name, description: f.relativePath,
              prefix: `@[${f.relativePath}] `, icon: 'file-text',
            }));
            // Merge: skills first, then files
            const currentSkills = this.autocompleteItems.filter(i => i.type === 'skill');
            this.showAutocomplete([...currentSkills, ...fileItems]);
          } catch { /* ignore file search errors */ }
        }, 300);
      }
    } else {
      this.hideAutocomplete();
    }
  }

  private showAutocomplete(items: AutocompleteItem[]) {
    this.autocompleteItems = items;
    this.autocompleteIdx = 0;
    if (items.length === 0) {
      this.hideAutocomplete();
      return;
    }
    this.renderAutocompleteItems();
    this.autocompleteEl?.show();
  }

  private hideAutocomplete() {
    this.autocompleteTrigger = null;
    this.autocompleteItems = [];
    this.autocompleteEl?.hide();
    if (this.fileSearchTimer) {
      clearTimeout(this.fileSearchTimer);
      this.fileSearchTimer = null;
    }
  }

  private renderAutocompleteItems() {
    if (!this.autocompleteEl) return;
    this.autocompleteEl.empty();

    let currentType = '';
    for (let i = 0; i < this.autocompleteItems.length; i++) {
      const item = this.autocompleteItems[i];

      // Section header
      const sectionLabel = item.type === 'skill' ? 'Skills' : item.type === 'workflow' ? 'Workflows' : 'Files';
      if (sectionLabel !== currentType) {
        currentType = sectionLabel;
        this.autocompleteEl.createDiv({ text: sectionLabel, cls: 'ag-ac-section' });
      }

      const el = this.autocompleteEl.createDiv({
        cls: `ag-ac-item ${i === this.autocompleteIdx ? 'ag-ac-selected' : ''}`,
      });

      const iconSpan = el.createSpan({ cls: 'ag-ac-icon' });
      setIcon(iconSpan, item.icon);

      const textDiv = el.createDiv({ cls: 'ag-ac-text' });
      const triggerPrefix = item.type === 'workflow' ? '/' : '@';
      textDiv.createDiv({ text: `${triggerPrefix}${item.name}`, cls: 'ag-ac-name' });
      if (item.description) {
        textDiv.createDiv({ text: item.description, cls: 'ag-ac-desc' });
      }

      el.addEventListener('mousedown', (e) => {
        e.preventDefault(); // prevent textarea blur
        this.insertAutocompleteItem(item);
      });
      el.addEventListener('mouseenter', () => {
        this.autocompleteIdx = i;
        this.renderAutocompleteItems();
      });
    }
  }

  private insertAutocompleteItem(item: AutocompleteItem) {
    // #6 Handle prompt template selection
    if (item.prefix.startsWith('__prompt__')) {
      const templateId = item.prefix.replace(/^__prompt__|__$/g, '');
      const tmpl = (this.plugin.settings.promptTemplates || []).find(t => t.id === templateId);
      if (tmpl) {
        this.hideAutocomplete();
        // Clear the /xxx trigger text from input
        this.inputEl.value = '';
        this.applyPromptTemplate(tmpl);
        return;
      }
    }

    const cursorPos = this.inputEl.selectionStart || 0;
    const text = this.inputEl.value;
    const textBeforeCursor = text.slice(0, cursorPos);

    // Try matching @#tag first, then @, then /
    let regex: RegExp;
    if (this.autocompleteTrigger === '/') {
      regex = /(^|\s)\/([\w-]*)$/;
    } else {
      // Try @# first
      const tagRegex = /(^|\s)@#([\w\/\-\u4e00-\u9fff]*)$/;
      regex = tagRegex.test(textBeforeCursor) ? tagRegex : /(^|\s)@([\w\/\.\-\u4e00-\u9fff]*)$/;
    }
    const match = textBeforeCursor.match(regex);

    if (match) {
      const triggerStart = match.index! + match[1].length;
      const newText = text.slice(0, triggerStart) + item.prefix + text.slice(cursorPos);
      this.inputEl.value = newText;
      const newPos = triggerStart + item.prefix.length;
      this.inputEl.selectionStart = newPos;
      this.inputEl.selectionEnd = newPos;
      this.inputEl.focus();
    }

    this.hideAutocomplete();
  }

  // ── Tag Search ──

  /**
   * Search vault tags and return matching autocomplete items.
   * Each tag item inserts @[file1] @[file2]... for all files with that tag.
   */
  private searchTags(query: string): AutocompleteItem[] {
    const vaultBase = (this.app.vault.adapter as any).basePath as string;
    const allTags = new Map<string, string[]>(); // tag -> [filePaths]

    // Scan metadataCache for all tags
    for (const [filePath, cache] of Object.entries(this.app.metadataCache.resolvedLinks ? {} : {})) { /* unused */ }

    // Use getTags from metadataCache
    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache?.tags) continue;
      for (const tag of cache.tags) {
        const tagName = tag.tag; // e.g., "#project"
        if (!allTags.has(tagName)) allTags.set(tagName, []);
        allTags.get(tagName)!.push(file.path);
      }
      // Also check frontmatter tags
      const fmTags = cache.frontmatter?.tags;
      if (Array.isArray(fmTags)) {
        for (const t of fmTags) {
          const tagName = t.startsWith('#') ? t : `#${t}`;
          if (!allTags.has(tagName)) allTags.set(tagName, []);
          if (!allTags.get(tagName)!.includes(file.path)) {
            allTags.get(tagName)!.push(file.path);
          }
        }
      }
    }

    // Filter by query
    const results: AutocompleteItem[] = [];
    for (const [tag, filePaths] of allTags.entries()) {
      if (query && !tag.toLowerCase().includes(query.toLowerCase())) continue;
      // Build prefix: insert all tagged files as @[absolutePath]
      const refs = filePaths.slice(0, 5).map(fp => `@[${vaultBase}/${fp}]`).join(' ');
      results.push({
        type: 'file',
        name: tag,
        description: `${filePaths.length} note${filePaths.length > 1 ? 's' : ''}`,
        prefix: refs + ' ',
        icon: 'hash',
      });
    }
    return results.slice(0, 10);
  }

  // ── Insert at cursor helper ──

  private insertAtCursor(textToInsert: string) {
    const start = this.inputEl.selectionStart || 0;
    const end = this.inputEl.selectionEnd || 0;
    const val = this.inputEl.value;
    this.inputEl.value = val.slice(0, start) + textToInsert + val.slice(end);
    const newPos = start + textToInsert.length;
    this.inputEl.selectionStart = newPos;
    this.inputEl.selectionEnd = newPos;
    this.inputEl.focus();
    // Trigger resize
    this.inputEl.style.height = 'auto';
    this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 150) + 'px';
  }

  // ── Code Block Enhancement ──

  private enhanceCodeBlocks(container: HTMLElement) {
    const codeBlocks = container.querySelectorAll('pre > code');
    codeBlocks.forEach((codeEl) => {
      const preEl = codeEl.parentElement;
      if (!preEl || preEl.classList.contains('ag-code-enhanced')) return;
      preEl.classList.add('ag-code-enhanced');

      // Detect language from class (e.g., "language-typescript")
      const langClass = Array.from(codeEl.classList).find((c) => c.startsWith('language-'));
      const lang = langClass ? langClass.replace('language-', '') : '';

      // Create header bar
      const header = document.createElement('div');
      header.className = 'ag-code-header';

      // Language label
      const langLabel = document.createElement('span');
      langLabel.className = 'ag-code-lang';
      langLabel.textContent = lang || 'text';
      header.appendChild(langLabel);

      // Copy button
      const copyBtn = document.createElement('button');
      copyBtn.className = 'ag-code-copy';
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const code = codeEl.textContent || '';
        navigator.clipboard.writeText(code);
        copyBtn.textContent = '✓ Copied';
        copyBtn.classList.add('ag-code-copy-done');
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
          copyBtn.classList.remove('ag-code-copy-done');
        }, 1500);
      });
      header.appendChild(copyBtn);

      // Apply button — insert code at cursor in active editor
      const applyBtn = document.createElement('button');
      applyBtn.className = 'ag-code-copy';
      applyBtn.textContent = 'Apply';
      applyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const code = codeEl.textContent || '';
        const activeFile = this.app.workspace.getActiveFile();
        const editor = this.app.workspace.activeEditor?.editor;
        if (editor) {
          // Insert at cursor position
          const cursor = editor.getCursor();
          editor.replaceRange(code, cursor);
          applyBtn.textContent = '✓ Applied';
          applyBtn.classList.add('ag-code-copy-done');
          setTimeout(() => {
            applyBtn.textContent = 'Apply';
            applyBtn.classList.remove('ag-code-copy-done');
          }, 1500);
        } else if (activeFile) {
          // No editor open — append to file
          await this.app.vault.append(activeFile, '\n' + code);
          applyBtn.textContent = '✓ Appended';
          applyBtn.classList.add('ag-code-copy-done');
          new Notice(`Appended to ${activeFile.name}`);
          setTimeout(() => {
            applyBtn.textContent = 'Apply';
            applyBtn.classList.remove('ag-code-copy-done');
          }, 1500);
        } else {
          new Notice('No active file — open a note first');
        }
      });
      header.appendChild(applyBtn);

      preEl.insertBefore(header, preEl.firstChild);
    });
  }

  // ── Auto WikiLink in AI Responses ──

  private autoWikiLink(container: HTMLElement) {
    // Build a set of note names (without extension) for matching
    const noteNames = new Map<string, string>(); // lowercaseName -> originalPath
    for (const file of this.app.vault.getMarkdownFiles()) {
      const name = file.basename; // without .md
      // Allow 2-char CJK names, require 3+ for Latin
      const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(name);
      if (name.length >= (hasCJK ? 2 : 3)) {
        noteNames.set(name.toLowerCase(), file.path);
      }
    }

    if (noteNames.size === 0) return;

    // Walk text nodes (skip code blocks and existing links)
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName.toLowerCase();
        // Skip code blocks, links, and already-wikified elements
        if (tag === 'code' || tag === 'pre' || tag === 'a' || parent.classList.contains('ag-wikilink')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const textNodes: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      textNodes.push(node as Text);
    }

    // Sort note names by length (longest first) to match "My Long Note Name" before "My Note"
    const sortedNames = [...noteNames.entries()].sort((a, b) => b[0].length - a[0].length);

    for (const textNode of textNodes) {
      let text = textNode.textContent || '';
      if (text.length < 3) continue;

      const textLower = text.toLowerCase();
      let replacements: { start: number; end: number; name: string; path: string }[] = [];

      for (const [nameLower, path] of sortedNames) {
        let idx = 0;
        while ((idx = textLower.indexOf(nameLower, idx)) !== -1) {
          // Check word boundary: ensure we're not matching inside a larger word
          // CJK characters are self-delimiting (no spaces needed)
          const before = idx > 0 ? textLower[idx - 1] : ' ';
          const after = idx + nameLower.length < textLower.length ? textLower[idx + nameLower.length] : ' ';
          const isCJK = (ch: string) => /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/.test(ch);
          const boundaryRe = /[\s,.;:!?()[\]{}'"—–\-\/]/;
          const isWordBoundary = (boundaryRe.test(before) || isCJK(before) || isCJK(textLower[idx]))
            && (boundaryRe.test(after) || isCJK(after) || isCJK(textLower[idx + nameLower.length - 1]));

          if (isWordBoundary) {
            // Check no overlap with existing replacements
            const overlaps = replacements.some(r => !(idx + nameLower.length <= r.start || idx >= r.end));
            if (!overlaps) {
              replacements.push({
                start: idx,
                end: idx + nameLower.length,
                name: text.slice(idx, idx + nameLower.length), // preserve original casing
                path,
              });
            }
          }
          idx += nameLower.length;
        }
      }

      if (replacements.length === 0) continue;

      // Sort by position (descending) to replace from end to start
      replacements.sort((a, b) => b.start - a.start);

      const parent = textNode.parentElement!;
      let currentText = text;

      // Build fragments
      const fragment = document.createDocumentFragment();
      let lastEnd = 0;

      // Re-sort ascending for fragment building
      replacements.sort((a, b) => a.start - b.start);

      for (const r of replacements) {
        // Text before this match
        if (r.start > lastEnd) {
          fragment.appendChild(document.createTextNode(currentText.slice(lastEnd, r.start)));
        }

        // Create wikilink element
        const link = document.createElement('a');
        link.className = 'ag-wikilink';
        link.textContent = r.name;
        link.title = r.path;
        link.addEventListener('click', (e) => {
          e.preventDefault();
          this.app.workspace.openLinkText(r.path, '', false);
        });
        fragment.appendChild(link);
        lastEnd = r.end;
      }

      // Remaining text
      if (lastEnd < currentText.length) {
        fragment.appendChild(document.createTextNode(currentText.slice(lastEnd)));
      }

      parent.replaceChild(fragment, textNode);
    }
  }

  // ── Streaming Phase Detection ──

  private detectStreamingPhase(steps: any[], data: any): string | null {
    if (!this.isStreaming) return null;

    // Check task boundary info from WS data
    const tb = data.lastTaskBoundary;
    if (tb?.mode) {
      const mode = (tb.mode || '').toLowerCase();
      if (mode.includes('plan')) return 'Planning';
      if (mode.includes('execut')) return 'Executing';
      if (mode.includes('verif')) return 'Verifying';
      if (mode.includes('review')) return 'Reviewing';
    }

    // Infer from last step type
    if (steps.length > 0) {
      const lastStep = steps[steps.length - 1];
      const type = (lastStep?.type || '').replace('CORTEX_STEP_TYPE_', '');
      const status = lastStep?.status || '';

      if (status.includes('GENERATING')) return 'Writing';
      if (type === 'CODE_ACTION') return 'Coding';
      if (type === 'RUN_COMMAND') return 'Running command';
      if (type === 'GREP_SEARCH' || type === 'FIND') return 'Searching';
      if (type === 'VIEW_FILE') return 'Reading file';
      if (type === 'SEARCH_WEB' || type === 'READ_URL_CONTENT') return 'Browsing';
      if (type === 'LIST_DIRECTORY') return 'Exploring';
      if (type === 'BROWSER_SUBAGENT') return 'Browser task';
    }

    return 'Thinking';
  }

  private renderToolbar(container: HTMLElement) {
    container.empty();

    // Plan / Fast toggle
    const modeBtn = container.createEl('button', { cls: 'ag-mode-btn', attr: { 'aria-label': this.agenticMode ? 'Planning mode' : 'Fast mode' } });
    if (this.agenticMode) {
      const iconSpan = modeBtn.createSpan({ cls: 'ag-mode-icon' });
      setIcon(iconSpan, 'rocket');
      modeBtn.createSpan({ text: ' Planning' });
      modeBtn.addClass('ag-mode-planning');
    } else {
      const iconSpan = modeBtn.createSpan({ cls: 'ag-mode-icon' });
      setIcon(iconSpan, 'zap');
      modeBtn.createSpan({ text: ' Fast' });
      modeBtn.addClass('ag-mode-fast');
    }
    modeBtn.title = this.agenticMode ? 'Plan before executing' : 'Execute directly';
    modeBtn.addEventListener('click', () => {
      this.agenticMode = !this.agenticMode;
      this.savePreferences();
      this.renderToolbar(container);
    });

    // Attach active file button
    const attachBtn = container.createEl('button', { cls: 'ag-attach-btn', attr: { 'aria-label': 'Attach current file' } });
    const attachIcon = attachBtn.createSpan({ cls: 'ag-mode-icon' });
    setIcon(attachIcon, 'paperclip');
    attachBtn.title = 'Attach current file (@file)';
    attachBtn.addEventListener('click', () => this.attachActiveFile());

    // Prompt template button
    const promptBtn = container.createEl('button', { cls: 'ag-attach-btn', attr: { 'aria-label': 'Prompt Templates' } });
    const promptIcon = promptBtn.createSpan({ cls: 'ag-mode-icon' });
    setIcon(promptIcon, 'file-text');
    promptBtn.title = 'Prompt Templates';
    promptBtn.addEventListener('click', () => this.showPromptPicker());

    // Pin count indicator (if pins exist)
    const pinCount = (this.plugin.settings.pins || []).length;
    if (pinCount > 0) {
      const pinIndicator = container.createEl('button', { cls: 'ag-attach-btn ag-pin-indicator' });
      const pinIcon = pinIndicator.createSpan({ cls: 'ag-mode-icon' });
      setIcon(pinIcon, 'pin');
      pinIndicator.createSpan({ text: ` ${pinCount}` });
      pinIndicator.title = `${pinCount} pinned selections`;
      pinIndicator.addEventListener('click', () => {
        // Toggle pin bar visibility
        if (this.pinBarEl?.isShown()) {
          this.pinBarEl.hide();
        } else {
          this.renderPinBar();
        }
      });
    }

    // Model selector
    const modelBtn = container.createEl('button', { cls: 'ag-model-btn' });
    const modelLabel = this.getModelLabel();
    const quotaPct = this.getModelQuota();
    modelBtn.createSpan({ text: modelLabel, cls: 'ag-model-label' });
    if (quotaPct !== null) {
      const quotaCls = quotaPct > 50 ? 'ag-quota-ok' : quotaPct > 20 ? 'ag-quota-warn' : 'ag-quota-low';
      modelBtn.createSpan({ text: ` ${quotaPct}%`, cls: `ag-model-quota-inline ${quotaCls}` });
    }
    const chevron = modelBtn.createSpan({ cls: 'ag-model-chevron' });
    setIcon(chevron, 'chevron-down');

    modelBtn.addEventListener('click', (e) => {
      this.showModelMenu(modelBtn);
    });
  }

  /**
   * Insert the currently active Obsidian file as @[absolute-path] into the input.
   */
  private attachActiveFile() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      logger.debug(LOG_SRC, 'No active file to attach');
      return;
    }
    const vaultBasePath = (this.app.vault.adapter as any).basePath as string;
    const absolutePath = `${vaultBasePath}/${activeFile.path}`;
    this.insertAtCursor(`@[${absolutePath}] `);
    logger.info(LOG_SRC, `Attached file: ${absolutePath}`);
  }

  private getModelLabel(): string {
    if (this.currentModel === 'MODEL_AUTO') return 'Auto';
    const m = this.models.find(m => m.modelOrAlias?.model === this.currentModel);
    return m?.label || this.currentModel.replace(/^MODEL_PLACEHOLDER_/, '');
  }

  private getModelQuota(): number | null {
    if (this.currentModel === 'MODEL_AUTO') return null;
    const m = this.models.find(m => m.modelOrAlias?.model === this.currentModel);
    if (m?.quotaInfo?.remainingFraction != null) {
      return Math.round(m.quotaInfo.remainingFraction * 100);
    }
    return null;
  }

  private showModelMenu(anchorEl: HTMLElement) {
    this.cleanupModelDropdown();

    const dropdown = document.body.createDiv({ cls: 'ag-model-dropdown' });
    this.activeDropdown = dropdown;

    const rect = anchorEl.getBoundingClientRect();
    dropdown.style.left = rect.left + 'px';
    dropdown.style.bottom = (window.innerHeight - rect.top + 4) + 'px';

    const selectModel = (model: string) => {
      this.currentModel = model;
      this.savePreferences();
      this.cleanupModelDropdown();
      this.renderToolbar(this.inputContainerEl.querySelector('.ag-toolbar')!);
    };

    // Auto option
    const autoItem = dropdown.createDiv({
      cls: `ag-model-item ${this.currentModel === 'MODEL_AUTO' ? 'ag-model-selected' : ''}`,
      text: 'Auto',
    });
    autoItem.addEventListener('click', () => selectModel('MODEL_AUTO'));

    for (const m of this.models) {
      const val = m.modelOrAlias?.model || '';
      if (!val) continue;
      const pct = m.quotaInfo?.remainingFraction != null
        ? ` (${Math.round(m.quotaInfo.remainingFraction * 100)}%)`
        : '';
      const item = dropdown.createDiv({
        cls: `ag-model-item ${val === this.currentModel ? 'ag-model-selected' : ''}`,
      });
      item.createSpan({ text: m.label });
      if (pct) item.createSpan({ text: pct, cls: 'ag-model-quota' });
      item.addEventListener('click', () => selectModel(val));
    }

    const closeHandler = (ev: MouseEvent) => {
      if (!dropdown.contains(ev.target as Node) && !anchorEl.contains(ev.target as Node)) {
        this.cleanupModelDropdown();
      }
    };
    this.activeDropdownCloseHandler = closeHandler;
    setTimeout(() => document.addEventListener('click', closeHandler), 0);
  }

  private cleanupModelDropdown() {
    if (this.activeDropdown) {
      this.activeDropdown.remove();
      this.activeDropdown = null;
    }
    if (this.activeDropdownCloseHandler) {
      document.removeEventListener('click', this.activeDropdownCloseHandler);
      this.activeDropdownCloseHandler = null;
    }
  }

  private async handleSend() {
    if (!this.currentCascadeId) return;

    if (this.isStreaming) {
      logger.info(LOG_SRC, 'Cancelling generation');
      await this.plugin.client.cancelGeneration(this.currentCascadeId);
      return;
    }

    // Prevent double send
    if (this.isSending) return;

    let text = this.inputEl.value.trim();
    if (!text) return;

    const originalText = text; // preserve for knowledge query

    this.isSending = true;
    this.inputEl.value = '';
    this.inputEl.style.height = 'auto';

    // Capture images before clearing
    const images = [...this.pastedImages];
    this.pastedImages = [];
    this.renderImagePreview();

    // ── Editor Selection Context ──
    if (this.editorSelection) {
      const selectionSnippet = this.editorSelection.slice(0, 3000);
      text = `[Selected text from editor]\n\`\`\`\n${selectionSnippet}\n\`\`\`\n\n${text}`;
      this.editorSelection = '';
      this.renderSelectionBar();
    }

    // ── Pinned Content Context ──
    const pins = this.plugin.settings.pins || [];
    if (pins.length > 0) {
      const vaultBase = (this.app.vault.adapter as any).basePath as string;
      const grouped = new Map<string, PinItem[]>();
      for (const p of pins) {
        const g = grouped.get(p.filePath) || [];
        g.push(p);
        grouped.set(p.filePath, g);
      }
      let pinContext = '';
      for (const [filePath, filePins] of grouped) {
        pinContext += `@[${vaultBase}/${filePath}]\n`;
        for (const p of filePins) {
          const lineInfo = p.startLine > 0 ? ` (L${p.startLine}-${p.endLine})` : '';
          pinContext += `[Pinned${lineInfo}]\n\`\`\`\n${p.text}\n\`\`\`\n`;
        }
      }
      text = pinContext + '\n' + text;

      // #3 Auto-clear pins after send
      this.plugin.settings.pins = [];
      this.plugin.saveSettings();
      this.renderPinBar();
      this.renderToolbar(this.inputContainerEl.querySelector('.ag-toolbar')!);
    }

    // ── Smart Context Injection ──
    // Inject context about active note and recent files (unless user already has @[] refs)
    const hasFileRefs = /@\[/.test(text);
    if (!hasFileRefs) {
      const contextPrefix = this.buildSmartContext();
      if (contextPrefix) {
        text = contextPrefix + text;
      }
    }

    // ── Knowledge Context Injection ──
    // Query KnowledgeEngine with the user's original message to find related vault notes
    if (this.plugin.knowledgeEngine) {
      try {
        const vaultBase = (this.app.vault.adapter as any).basePath as string;
        // Collect paths already referenced in text to avoid duplicates
        const existingRefs = new Set<string>();
        const refMatches = text.matchAll(/@\[([^\]]+)\]/g);
        for (const m of refMatches) {
          const refPath = m[1].replace(vaultBase + '/', '');
          existingRefs.add(refPath);
        }
        // Also exclude the active file
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) existingRefs.add(activeFile.path);

        const related = this.plugin.knowledgeEngine.queryByText(originalText, 3, existingRefs);
        if (related.length > 0) {
          const knowledgeRefs = related
            .map(r => `@[${vaultBase}/${r.path}]`)
            .join(' ');
          text = knowledgeRefs + '\n' + text;
        }
      } catch (err: any) {
        logger.warn(LOG_SRC, 'Knowledge context injection failed', { message: err?.message });
      }
    }

    logger.info(LOG_SRC, 'Sending message', { length: text.length });

    // Optimistically show user message
    const userStep: Step = {
      type: 'CORTEX_STEP_TYPE_USER_INPUT',
      userInput: {
        items: [{ text }],
        media: images.map(img => ({
          mimeType: img.mimeType,
          inlineData: img.dataUrl.split(',')[1],
        })),
      },
    };
    this.steps.push(userStep);
    this.isStreaming = true;
    this.renderMessages();

    try {
      const model = this.currentModel !== 'MODEL_AUTO' ? this.currentModel : undefined;
      const attachments = images.length > 0 ? {
        media: images.map(img => ({
          mimeType: img.mimeType,
          inlineData: img.dataUrl.split(',')[1],
        })),
      } : undefined;
      await this.plugin.client.sendMessage(this.currentCascadeId, text, this.agenticMode, model, attachments);
    } catch (err: any) {
      logger.error(LOG_SRC, 'Send message failed', { message: err?.message });
      this.isStreaming = false;

      // Check if this is a gateway disconnect
      const isDisconnect = !await this.plugin.client.ping();

      const errorStep: Step = {
        type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
        errorMessage: {
          message: isDisconnect
            ? 'Gateway disconnected. Please check connection and retry.'
            : `Send failed: ${err.message}`,
        },
      };
      this.steps.push(errorStep);
      this.renderMessages();

      if (isDisconnect) {
        this.gatewayConnected = false;
        this.renderHeader();
        this.showDisconnectBanner('Gateway connection lost during send.', true);
      }
    } finally {
      this.isSending = false;
    }
  }

  // ── Helpers ──

  private formatTime(mtime: number): string {
    const d = new Date(mtime);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  // ── Smart Context ──

  /**
   * Build context string with active file + its backlinks.
   * Returns empty string if no relevant context.
   */
  private buildSmartContext(): string {
    const vaultBase = (this.app.vault.adapter as any).basePath as string;
    const parts: string[] = [];
    const freshTags: string[] = [];

    // 1. Active file
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile) {
      const name = activeFile.name;
      if (this.contextTags.includes(name)) {
        parts.push(`@[${vaultBase}/${activeFile.path}]`);
        freshTags.push(name);
      }

      // 2. Backlinks of active file (via metadataCache)
      const backlinks = this.getBacklinks(activeFile.path);
      for (const bl of backlinks.slice(0, 3)) {
        const blName = bl.split('/').pop() || bl;
        if (this.contextTags.includes(blName)) {
          parts.push(`@[${vaultBase}/${bl}]`);
          freshTags.push(blName);
        }
      }
    }

    // 3. Recently edited files (last 3 unique, excluding active)
    const recentFiles = this.getRecentFiles(activeFile?.path);
    for (const rf of recentFiles.slice(0, 2)) {
      const rfName = rf.split('/').pop() || rf;
      if (this.contextTags.includes(rfName)) {
        const refPath = `${vaultBase}/${rf}`;
        if (!parts.includes(`@[${refPath}]`)) {
          parts.push(`@[${refPath}]`);
          freshTags.push(rfName);
        }
      }
    }

    // Clear context bar after sending — also reset dismissed set for next message
    this.contextTags = [];
    this.dismissedContextTags.clear();
    this.renderContextBar();

    if (parts.length === 0) return '';
    return parts.join(' ') + '\n\n';
  }

  private updateEditorSelection() {
    let sel = '';

    // Try CodeMirror editor first (Source / Live Preview mode)
    const editor = this.app.workspace.activeEditor?.editor;
    if (editor) {
      sel = editor.getSelection() || '';
    }

    // Fallback: window.getSelection() for Reading View / rendered content (tables, etc.)
    if (!sel) {
      const winSel = window.getSelection();
      if (winSel && winSel.rangeCount > 0 && !winSel.isCollapsed) {
        const range = winSel.getRangeAt(0);
        const container = range.commonAncestorContainer;
        const el = container instanceof Element ? container : container.parentElement;
        if (el && (
          el.closest('.markdown-preview-view') ||
          el.closest('.cm-editor') ||
          el.closest('.markdown-reading-view') ||
          el.closest('.markdown-rendered') ||
          el.closest('.workspace-leaf-content')
        )) {
          sel = winSel.toString() || '';
        }
      }
    }

    // Only update if user made a new selection; never clear a locked selection
    // (selection disappears when focus moves to chat input — preserve it)
    if (sel && sel !== this.editorSelection) {
      this.editorSelection = sel;
      this.renderSelectionBar();
    }
  }

  private renderSelectionBar() {
    if (!this.selectionBarEl) return;
    this.selectionBarEl.empty();

    if (!this.editorSelection) {
      this.selectionBarEl.hide();
      return;
    }

    this.selectionBarEl.show();
    const preview = this.editorSelection.length > 80
      ? this.editorSelection.slice(0, 80) + '...'
      : this.editorSelection;

    const selIcon = this.selectionBarEl.createSpan({ cls: 'ag-mode-icon' });
    setIcon(selIcon, 'scissors');
    const label = this.selectionBarEl.createSpan({ text: ` Selected: "${preview}"` });
    label.style.cssText = 'font-size: 11px; color: var(--text-muted); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';

    const clearBtn = this.selectionBarEl.createSpan({ cls: 'ag-selection-close' });
    setIcon(clearBtn, 'x');
    clearBtn.style.cssText = 'cursor: pointer; padding: 0 4px; color: var(--text-muted); flex-shrink: 0;';
    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.editorSelection = '';
      this.renderSelectionBar();
    });
  }

  // ── Pin Bar ──

  /** Called by main.ts when a new pin is added */
  onPinsUpdated() {
    this.renderPinBar();
  }

  private renderPinBar() {
    if (!this.pinBarEl) return;
    this.pinBarEl.empty();

    const pins = this.plugin.settings.pins || [];
    if (pins.length === 0) {
      this.pinBarEl.hide();
      return;
    }

    this.pinBarEl.show();

    // Group pins by file
    const grouped = new Map<string, PinItem[]>();
    for (const pin of pins) {
      const group = grouped.get(pin.filePath) || [];
      group.push(pin);
      grouped.set(pin.filePath, group);
    }

    // Header
    const header = this.pinBarEl.createDiv({ cls: 'ag-pin-header' });
    const pinHeaderIcon = header.createSpan({ cls: 'ag-mode-icon' });
    setIcon(pinHeaderIcon, 'pin');
    header.createSpan({ text: ` ${pins.length} pinned`, cls: 'ag-pin-count' });

    const clearAllBtn = header.createSpan({ text: 'Clear all', cls: 'ag-pin-clear-all' });
    clearAllBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.plugin.settings.pins = [];
      this.plugin.saveSettings();
      this.renderPinBar();
    });

    // Render grouped pins
    for (const [filePath, filePins] of grouped) {
      const fileGroup = this.pinBarEl.createDiv({ cls: 'ag-pin-group' });

      const fileLabel = fileGroup.createDiv({ cls: 'ag-pin-file' });
      const fileIcon = fileLabel.createSpan({ cls: 'ag-mode-icon' });
      setIcon(fileIcon, 'file-text');
      fileLabel.createSpan({ text: ` ${filePins[0].fileName}` });

      for (const pin of filePins) {
        const pinItem = fileGroup.createDiv({ cls: 'ag-pin-item' });
        // Make draggable for #8
        pinItem.draggable = true;
        pinItem.addEventListener('dragstart', (e) => {
          e.dataTransfer?.setData('text/plain', pin.text);
          e.dataTransfer?.setData('application/x-ag-pin-id', pin.id);
        });

        const lineInfo = pin.startLine > 0
          ? `L${pin.startLine}${pin.endLine !== pin.startLine ? `-${pin.endLine}` : ''}: `
          : '';
        const preview = pin.text.length > 60 ? pin.text.slice(0, 60) + '...' : pin.text;

        const textEl = pinItem.createSpan({ text: lineInfo + preview, cls: 'ag-pin-text' });

        // #2 Hover tooltip with full content
        textEl.title = pin.text.slice(0, 500);

        // #1 Click to jump to source
        textEl.style.cursor = 'pointer';
        textEl.addEventListener('click', (e) => {
          e.stopPropagation();
          const file = this.app.vault.getAbstractFileByPath(pin.filePath);
          if (file) {
            this.app.workspace.openLinkText(pin.filePath, '', false).then(() => {
              if (pin.startLine > 0) {
                const editor = this.app.workspace.activeEditor?.editor;
                if (editor) {
                  editor.setCursor({ line: pin.startLine - 1, ch: 0 });
                  editor.scrollIntoView({ from: { line: pin.startLine - 1, ch: 0 }, to: { line: pin.endLine - 1, ch: 0 } }, true);
                }
              }
            });
          }
        });

        const removeBtn = pinItem.createSpan({ cls: 'ag-pin-remove' });
        setIcon(removeBtn, 'x');
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.plugin.settings.pins = this.plugin.settings.pins.filter(p => p.id !== pin.id);
          this.plugin.saveSettings();
          this.renderPinBar();
          this.renderToolbar(this.inputContainerEl.querySelector('.ag-toolbar')!);
        });
      }
    }
  }

  // ── Prompt Template Picker ──

  private showPromptPicker() {
    if (!this.promptPickerEl) return;
    this.promptPickerEl.empty();
    this.promptPickerEl.show();

    const templates = (this.plugin.settings.promptTemplates || [])
      .filter(t => t.prompt); // exclude any legacy empty entries

    // Group by category
    const categories = new Map<string, PromptTemplate[]>();
    for (const t of templates) {
      const cat = t.category || 'Other';
      const list = categories.get(cat) || [];
      list.push(t);
      categories.set(cat, list);
    }

    // Header
    const header = this.promptPickerEl.createDiv({ cls: 'ag-pp-header' });
    const promptHeaderIcon = header.createSpan({ cls: 'ag-mode-icon' });
    setIcon(promptHeaderIcon, 'scroll-text');
    header.createSpan({ text: ' Prompt Templates' });
    const closeBtn = header.createSpan({ cls: 'ag-pp-close' });
    setIcon(closeBtn, 'x');
    closeBtn.addEventListener('click', () => this.hidePromptPicker());

    // Templates list
    const list = this.promptPickerEl.createDiv({ cls: 'ag-pp-list' });

    for (const [category, temps] of categories) {
      const catLabel = list.createDiv({ cls: 'ag-pp-category', text: category });

      for (const tmpl of temps) {
        const item = list.createDiv({ cls: 'ag-pp-item' });
        const itemIcon = item.createSpan();
        itemIcon.style.cssText = 'display: inline-flex; margin-right: 6px; vertical-align: middle;';
        setIcon(itemIcon, tmpl.icon);
        const itemSvg = itemIcon.querySelector('svg');
        if (itemSvg) { (itemSvg as unknown as HTMLElement).style.cssText = 'width: 14px; height: 14px;'; }
        item.createSpan({ text: tmpl.name });

        item.addEventListener('click', () => {
          this.hidePromptPicker();
          // Insert prompt into input, with pinned content and selection
          this.applyPromptTemplate(tmpl);
        });
      }
    }

    // Add new template button
    const addBtn = list.createDiv({ cls: 'ag-pp-add' });
    addBtn.createSpan({ text: '+ Create new template' });
    addBtn.addEventListener('click', () => {
      this.hidePromptPicker();
      this.plugin.showPromptManager();
    });

    // Manage button
    const manageBtn = list.createDiv({ cls: 'ag-pp-add' });
    const manageIcon = manageBtn.createSpan({ cls: 'ag-mode-icon' });
    setIcon(manageIcon, 'settings');
    manageBtn.createSpan({ text: ' Manage templates' });
    manageBtn.addEventListener('click', () => {
      this.hidePromptPicker();
      this.plugin.showPromptManager();
    });
  }

  private hidePromptPicker() {
    if (this.promptPickerEl) {
      this.promptPickerEl.empty();
      this.promptPickerEl.hide();
    }
  }

  private async applyPromptTemplate(tmpl: PromptTemplate) {
    if (!this.inputEl) return;

    const activeFile = this.app.workspace.getActiveFile();
    const vaultBase = (this.app.vault.adapter as any).basePath as string;

    // Use the plugin's async variable resolver (handles {{input:...}}, {{select:...}}, etc.)
    const resolved = await this.plugin.resolvePromptVariables(tmpl.prompt, this.editorSelection || '');
    if (resolved === null) return; // User cancelled interactive input

    let fullPrompt = resolved;

    // Auto-attach current file
    if (activeFile) {
      fullPrompt = `@[${vaultBase}/${activeFile.path}] ` + fullPrompt;
    }

    // Append pinned content
    const pins = this.plugin.settings.pins || [];
    if (pins.length > 0) {
      const grouped = new Map<string, PinItem[]>();
      for (const p of pins) {
        const g = grouped.get(p.filePath) || [];
        g.push(p);
        grouped.set(p.filePath, g);
      }
      for (const [filePath, filePins] of grouped) {
        fullPrompt += `@[${vaultBase}/${filePath}]\n`;
        for (const p of filePins) {
          const lineInfo = p.startLine > 0 ? ` (L${p.startLine}-${p.endLine})` : '';
          fullPrompt += `[Pinned${lineInfo}]\n\`\`\`\n${p.text}\n\`\`\`\n`;
        }
      }
    }

    this.inputEl.value = fullPrompt;
    this.inputEl.focus();
    this.inputEl.style.height = 'auto';
    this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 200) + 'px';
  }

  private showCreatePromptModal() {
    const { Modal: ObsModal, Setting } = require('obsidian');
    const modal = new ObsModal(this.app);
    modal.titleEl.setText('Create Prompt Template');

    let name = '';
    let prompt = '';
    let icon = 'file-text';
    let category = 'Custom';

    new Setting(modal.contentEl).setName('Name').addText((t: any) => {
      t.setPlaceholder('Template name');
      t.onChange((v: string) => name = v);
    });

    new Setting(modal.contentEl).setName('Icon').setDesc('Lucide icon name (e.g. sparkles, text, languages)').addText((t: any) => {
      t.setValue(icon).onChange((v: string) => icon = v);
      t.inputEl.style.width = '60px';
    });

    new Setting(modal.contentEl).setName('Category').addText((t: any) => {
      t.setValue(category).onChange((v: string) => category = v);
    });

    const promptEl = modal.contentEl.createEl('textarea', {
      attr: { placeholder: 'Enter the prompt template...\\n\\nUse this to define what the AI should do with the selected/pinned text.', rows: '6' },
      cls: 'ag-prompt-textarea',
    });
    promptEl.style.cssText = 'width: 100%; margin-top: 8px; font-family: inherit; padding: 8px; border-radius: 4px; border: 1px solid var(--background-modifier-border); resize: vertical; min-height: 100px;';
    promptEl.addEventListener('input', () => prompt = promptEl.value);

    new Setting(modal.contentEl).addButton((btn: any) => {
      btn.setButtonText('Save').setCta().onClick(async () => {
        if (!name || !prompt) {
          new Notice('Name and prompt are required');
          return;
        }
        const template: PromptTemplate = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          name, prompt, icon, category,
          showInToolbar: false, toolbarOrder: 0,
        };
        this.plugin.settings.promptTemplates.push(template);
        await this.plugin.saveSettings();
        new Notice(`Template "${name}" created`);
        modal.close();
      });
    });

    modal.open();
  }

  private showManagePromptsModal() {
    const { Modal: ObsModal } = require('obsidian');
    const modal = new ObsModal(this.app);
    modal.titleEl.setText('Manage Prompt Templates');

    const renderList = () => {
      modal.contentEl.empty();
      const templates = this.plugin.settings.promptTemplates || [];

      if (templates.length === 0) {
        modal.contentEl.createEl('p', { text: 'No templates yet.' });
        return;
      }

      for (const tmpl of templates) {
        const row = modal.contentEl.createDiv({ cls: 'ag-manage-prompt-row' });
        row.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--background-modifier-border);';

        const nameEl = row.createSpan({ cls: 'ag-manage-prompt-name' });
        nameEl.style.cssText = 'display: flex; align-items: center; gap: 6px;';
        const iconEl = nameEl.createSpan();
        setIcon(iconEl, tmpl.icon);
        const svg = iconEl.querySelector('svg');
        if (svg) { (svg as unknown as HTMLElement).style.cssText = 'width: 14px; height: 14px;'; }
        nameEl.createSpan({ text: tmpl.name });
        row.createSpan({ text: tmpl.category, cls: 'ag-manage-prompt-cat' }).style.cssText = 'color: var(--text-muted); font-size: 11px; margin-left: auto;';

        if (!tmpl.id.startsWith('builtin-')) {
          const delBtn = row.createEl('button', { cls: 'ag-manage-prompt-del' });
          delBtn.style.cssText = 'background: none; border: none; cursor: pointer; padding: 2px 4px; color: var(--text-muted); display: flex;';
          setIcon(delBtn, 'trash-2');
          const delSvg = delBtn.querySelector('svg');
          if (delSvg) { (delSvg as unknown as HTMLElement).style.cssText = 'width: 14px; height: 14px;'; }
          delBtn.addEventListener('mouseenter', () => { delBtn.style.color = 'var(--text-error)'; });
          delBtn.addEventListener('mouseleave', () => { delBtn.style.color = 'var(--text-muted)'; });
          delBtn.addEventListener('click', async () => {
            this.plugin.settings.promptTemplates = this.plugin.settings.promptTemplates.filter(t => t.id !== tmpl.id);
            await this.plugin.saveSettings();
            renderList();
          });
        }
      }
    };

    renderList();
    modal.open();
  }

  private renderImagePreview() {
    if (!this.imagePreviewEl) return;
    this.imagePreviewEl.empty();

    if (this.pastedImages.length === 0) {
      this.imagePreviewEl.hide();
      return;
    }

    this.imagePreviewEl.show();
    for (const img of this.pastedImages) {
      const wrapper = this.imagePreviewEl.createDiv({ cls: 'ag-image-thumb' });
      const imgEl = wrapper.createEl('img', { attr: { src: img.dataUrl } });
      imgEl.style.cssText = 'max-width: 60px; max-height: 60px; border-radius: 6px; object-fit: cover;';
      const removeBtn = wrapper.createEl('span', { cls: 'ag-image-remove', text: '×' });
      removeBtn.addEventListener('click', () => {
        this.pastedImages = this.pastedImages.filter(i => i.id !== img.id);
        this.renderImagePreview();
      });
    }
  }

  private renderContextBar() {
    if (!this.contextBarEl) return;
    this.contextBarEl.empty();

    if (this.contextTags.length === 0) {
      this.contextBarEl.hide();
      return;
    }

    this.contextBarEl.show();
    const label = this.contextBarEl.createSpan({ cls: 'ag-context-label' });
    setIcon(label, 'paperclip');
    label.appendText(' Context:');

    for (let i = 0; i < this.contextTags.length; i++) {
      const tag = this.contextBarEl.createSpan({ cls: 'ag-context-tag' });
      tag.createSpan({ text: this.contextTags[i] });
      const removeBtn = tag.createSpan({ cls: 'ag-context-remove', text: '×' });
      const idx = i;
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const removed = this.contextTags.splice(idx, 1)[0];
        if (removed) this.dismissedContextTags.add(removed);
        this.renderContextBar();
      });
    }
  }

  private previewSmartContext() {
    const vaultBase = (this.app.vault.adapter as any).basePath as string;
    const tags: string[] = [];

    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile) {
      tags.push(activeFile.name);
      const backlinks = this.getBacklinks(activeFile.path);
      for (const bl of backlinks.slice(0, 3)) {
        tags.push(bl.split('/').pop() || bl);
      }
    }

    const recentFiles = this.getRecentFiles(activeFile?.path);
    for (const rf of recentFiles.slice(0, 2)) {
      tags.push(rf.split('/').pop() || rf);
    }

    // Filter out tags user explicitly dismissed (don't re-add them on focus)
    this.contextTags = tags.filter(t => !this.dismissedContextTags.has(t));
    this.renderContextBar();
  }

  /**
   * Get backlinks (files that link TO this file) via Obsidian metadataCache.
   */
  private getBacklinks(filePath: string): string[] {
    const result: string[] = [];
    const resolvedLinks = this.app.metadataCache.resolvedLinks;
    // resolvedLinks[sourcePath][targetPath] = count
    for (const [source, targets] of Object.entries(resolvedLinks)) {
      if (source === filePath) continue;
      for (const target of Object.keys(targets as Record<string, number>)) {
        if (target === filePath) {
          result.push(source);
          break;
        }
      }
    }
    return result;
  }

  /**
   * Get recently opened files from Obsidian workspace (excludes current file).
   */
  private getRecentFiles(excludePath?: string): string[] {
    const result: string[] = [];
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    for (const leaf of leaves) {
      const file = (leaf.view as any)?.file;
      if (file && file.path !== excludePath && !result.includes(file.path)) {
        result.push(file.path);
      }
    }
    return result;
  }

  /**
   * Public API: Set text in the chat input (used by EditorMenu / FileMenu integrations).
   */
  setInputText(text: string) {
    if (!this.inputEl) return;
    // If not in conversation view, we can't type — so just store it
    if (this.showingConversationList) {
      // Create a new conversation first, then set text after opening
      this.createNewConversation().then(() => {
        if (this.inputEl) {
          this.inputEl.value = text;
          this.inputEl.focus();
          this.inputEl.style.height = 'auto';
          this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 200) + 'px';
        }
      });
    } else {
      this.inputEl.value = text;
      this.inputEl.focus();
      this.inputEl.style.height = 'auto';
      this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 200) + 'px';
    }
  }

  /**
   * Public API: Quick send with Flash model (used by Quick Actions).
   * Creates new conversation if needed, sends immediately with Flash model.
   */
  async quickSend(text: string) {
    // Find Flash model
    const flashModel = this.models.find(m => {
      const label = (m.label || '').toLowerCase();
      const model = (m.modelOrAlias?.model || '').toLowerCase();
      return label.includes('flash') || model.includes('flash');
    });
    const modelId = flashModel?.modelOrAlias?.model;

    const doSend = async () => {
      if (!this.currentCascadeId) return;

      // Show user message optimistically
      const userStep: Step = {
        type: 'CORTEX_STEP_TYPE_USER_INPUT',
        userInput: { items: [{ text }] },
      };
      this.steps.push(userStep);
      this.isStreaming = true;
      this.renderMessages();

      try {
        await this.plugin.client.sendMessage(this.currentCascadeId, text, false, modelId);
      } catch (err: any) {
        logger.error(LOG_SRC, 'Quick send failed', { message: err?.message });
        this.isStreaming = false;
        this.renderMessages();
      }
    };

    if (this.showingConversationList || !this.currentCascadeId) {
      await this.createNewConversation();
      // Small delay to ensure cascade is ready
      await new Promise(r => setTimeout(r, 200));
    }

    await doSend();
  }
}
