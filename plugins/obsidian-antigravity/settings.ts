/**
 * Antigravity Plugin Settings
 */

import { App, PluginSettingTab, Setting, Notice, Modal } from 'obsidian';
import type AntigravityPlugin from './main';
import { logger, type LogLevel } from './logger';
import { loginWithGitHubCopilot, fetchCopilotUsage, COPILOT_MODELS, fetchCopilotModels, type CopilotCredentials, type CopilotModel } from './copilot-auth';
import type { CompletionProvider } from './inline-completion';

const LOG_SRC = 'Settings';

export interface PinItem {
  id: string;
  filePath: string;     // Vault-relative path
  fileName: string;     // Display name (basename)
  startLine: number;
  endLine: number;
  text: string;
  timestamp: number;
}

export interface PromptListItem {
  label: string;   // Display text shown in selection UI
  value: string;   // Value substituted into prompt
}

export interface PromptList {
  id: string;
  name: string;           // Key used in {{select:name}}, {{multiselect:name:N}}, {{random:name:N}}
  items: PromptListItem[];
  isBuiltin: boolean;
}

export interface UserVariable {
  id: string;
  name: string;           // Key used in {{var:name}}
  value: string;          // Value to substitute
  description: string;    // Description for the user
}

export interface PromptTemplate {
  id: string;
  name: string;
  prompt: string;
  icon: string;           // Lucide icon name
  category: string;
  showInToolbar: boolean;  // Show in floating selection toolbar
  toolbarOrder: number;    // Toolbar display order (lower = first)
  isBuiltin?: boolean;     // Whether this is a built-in template
  hasSubmenu?: boolean;    // @deprecated — kept for migration only
}

export interface AntigravitySettings {
  gatewayUrl: string;
  workspaceUri: string; // Explicit workspace URI override (empty = auto-detect from vault path)
  logLevel: LogLevel;
  lastModel: string;      // Persisted model selection
  lastAgenticMode: boolean; // Persisted Plan/Fast mode
  excludeFolders: string;   // Comma-separated folders to exclude from dashboard analysis
  pins: PinItem[];          // Pinned text selections
  promptTemplates: PromptTemplate[]; // User-defined prompt templates
  promptLists: PromptList[];         // Lists for {{select:...}} variables
  userVariables: UserVariable[];     // User-defined {{var:...}} variables
  // Inline Completion
  inlineCompletionEnabled: boolean;
  inlineCompletionProvider: CompletionProvider;
  inlineCompletionApiKey: string;
  inlineCompletionApiBaseUrl: string;
  inlineCompletionModel: string;
  inlineCompletionDelay: number;
  inlineCompletionMaxTokens: number;
  inlineCompletionTemperature: number;
  copilotCredentials: CopilotCredentials | null;
  // Quick Action provider
  quickActionProvider: 'antigravity' | 'copilot';
  quickActionModel: string;
  // Atomization
  atomizationEnabled: boolean;
  atomizationSettleMinutes: number;
  // Translation
  translationTargetLang: string;  // SupportedLang code, e.g. 'en', 'zh'
  translationAutoOpen: boolean;   // Auto-open translation panel on startup
  // Onboarding
  onboardingStep: number; // 0=welcome, 1=type intro, 99=done
}

export const DEFAULT_SETTINGS: AntigravitySettings = {
  gatewayUrl: 'http://localhost:3000',
  workspaceUri: '',
  logLevel: 'INFO',
  lastModel: 'MODEL_AUTO',
  lastAgenticMode: true,
  excludeFolders: 'node_modules,.git,dist,build,.obsidian',
  pins: [],
  inlineCompletionEnabled: false,
  inlineCompletionProvider: 'copilot',
  inlineCompletionApiKey: '',
  inlineCompletionApiBaseUrl: '',
  inlineCompletionModel: 'gpt-4o-mini',
  inlineCompletionDelay: 500,
  inlineCompletionMaxTokens: 128,
  inlineCompletionTemperature: 0.1,
  copilotCredentials: null,
  quickActionProvider: 'copilot',
  quickActionModel: 'gpt-4o',
  atomizationEnabled: true,
  atomizationSettleMinutes: 5,
  translationTargetLang: 'en',
  translationAutoOpen: false,
  onboardingStep: 0,
  promptTemplates: [
    // ── Translate (single template with list variable) ──
    { id: 'builtin-translate', name: 'Translate', prompt: 'Translate the following text to {{select:targetLanguage}}, keep the original formatting:\n\n{{selection}}', icon: 'languages', category: 'Translation', showInToolbar: true, toolbarOrder: 10, isBuiltin: true },
    // ── Improve (single template with list variable) ──
    { id: 'builtin-improve', name: 'Improve', prompt: '{{select:improvementAction}}:\n\n{{selection}}', icon: 'sparkles', category: 'Writing', showInToolbar: true, toolbarOrder: 20, isBuiltin: true },
    // ── Direct actions (toolbar) ──
    { id: 'builtin-summarize', name: 'Summarize', prompt: 'Summarize the following text concisely:\n\n{{selection}}', icon: 'text', category: 'Analysis', showInToolbar: true, toolbarOrder: 30, isBuiltin: true },
    { id: 'builtin-explain', name: 'Explain', prompt: 'Explain the following text in simple terms:\n\n{{selection}}', icon: 'book-open', category: 'Analysis', showInToolbar: true, toolbarOrder: 40, isBuiltin: true },
    { id: 'builtin-continue', name: 'Continue writing', prompt: 'Continue writing the following text naturally. Match the tone, style, and topic. Write 2-3 more paragraphs:\n\n{{selection}}', icon: 'pen-line', category: 'Writing', showInToolbar: true, toolbarOrder: 50, isBuiltin: true },
    { id: 'builtin-action-items', name: 'Find action items', prompt: 'Extract all action items, tasks, and to-dos from the following text. Format them as a checklist:\n\n{{selection}}', icon: 'list-checks', category: 'Analysis', showInToolbar: true, toolbarOrder: 60, isBuiltin: true },
    // ── Non-toolbar templates ──
    { id: 'builtin-keypoints', name: 'Extract Key Points', prompt: 'Extract the key points from the following text as a bullet list:\n\n{{selection}}', icon: 'list', category: 'Analysis', showInToolbar: false, toolbarOrder: 0, isBuiltin: true },
    { id: 'builtin-tags', name: 'Suggest Tags', prompt: 'Suggest relevant Obsidian tags (#tag format) for the following text:\n\n{{selection}}', icon: 'tags', category: 'Organization', showInToolbar: false, toolbarOrder: 0, isBuiltin: true },
    // ── Interactive examples ──
    { id: 'builtin-extract-material', name: 'Extract Material', prompt: '1. I am researching {{input:Enter the purpose of material extraction}}, please extract useful information from the original text. Remember, "original text"! "Original text"! Extract in list format.\n2. Below is the content to analyze. If not in Chinese, please output in Chinese with proper markdown formatting:\n```\n"""{{selection}}"""\n```', icon: 'search', category: 'Analysis', showInToolbar: false, toolbarOrder: 0, isBuiltin: true },
    { id: 'builtin-format-table', name: 'Format as Table', prompt: '##Profile: Formatting Master\n##Workflow:\nStep1. Format the content and output as a table in Chinese with these columns: {{input:Enter column names (comma separated)}}.\nStep2. Return the table in markdown format. Maintain the original order for easy verification.\nStep3. Output "Done" when finished.\n\nContent:\n{{selection}}', icon: 'table', category: 'Writing', showInToolbar: false, toolbarOrder: 0, isBuiltin: true },
  ],
  promptLists: [
    {
      id: 'list-target-language',
      name: 'targetLanguage',
      items: [
        { label: 'English', value: 'English' },
        { label: '简体中文', value: 'Chinese (简体中文)' },
        { label: '繁體中文', value: 'Traditional Chinese (繁體中文)' },
        { label: '日本語', value: 'Japanese' },
        { label: '한국어', value: 'Korean' },
        { label: 'Español', value: 'Spanish' },
        { label: 'Français', value: 'French' },
        { label: 'Deutsch', value: 'German' },
        { label: 'Português', value: 'Portuguese' },
        { label: 'Русский', value: 'Russian' },
      ],
      isBuiltin: true,
    },
    {
      id: 'list-improvement-action',
      name: 'improvementAction',
      items: [
        { label: 'Improve writing', value: 'Improve the writing quality of the following text. Keep the same meaning but make it clearer and more polished' },
        { label: 'Fix spelling & grammar', value: 'Fix all spelling and grammar errors in the following text. Do not change the meaning or style, only correct mistakes' },
        { label: 'Make shorter', value: 'Make the following text shorter and more concise while keeping the key information' },
        { label: 'Make longer', value: 'Expand the following text with more detail and explanation while keeping the same tone' },
        { label: 'Simplify language', value: 'Simplify the language of the following text. Use shorter sentences and simpler words' },
        { label: 'Professional tone', value: 'Rewrite the following text in a professional and formal tone' },
        { label: 'Casual tone', value: 'Rewrite the following text in a casual and friendly tone' },
      ],
      isBuiltin: true,
    },
  ],
  userVariables: [],
};

export class AntigravitySettingTab extends PluginSettingTab {
  plugin: AntigravityPlugin;

  constructor(app: App, plugin: AntigravityPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Antigravity Settings' });

    // ── Gateway URL ──
    const gatewaySetting = new Setting(containerEl)
      .setName('Gateway URL')
      .setDesc('The URL of your Antigravity Gateway server.');

    // Connection status indicator (inline)
    const statusEl = gatewaySetting.descEl.createSpan({ cls: 'ag-setting-status' });

    gatewaySetting.addText((text) =>
      text
        .setPlaceholder('http://localhost:3000')
        .setValue(this.plugin.settings.gatewayUrl)
        .onChange(async (value) => {
          this.plugin.settings.gatewayUrl = value;
          this.plugin.client.setBaseUrl(value);
          await this.plugin.saveSettings();
          logger.info(LOG_SRC, 'Gateway URL updated', { url: value });
        }),
    );

    // Test Connection button
    gatewaySetting.addButton((btn) =>
      btn
        .setButtonText('Test')
        .setCta()
        .onClick(async () => {
          statusEl.empty();
          statusEl.textContent = ' Testing...';
          statusEl.className = 'ag-setting-status ag-setting-testing';

          const reachable = await this.plugin.client.ping();
          statusEl.empty();

          if (reachable) {
            statusEl.textContent = ' Connected';
            statusEl.className = 'ag-setting-status ag-setting-connected';
            logger.info(LOG_SRC, 'Connection test: OK');
          } else {
            statusEl.textContent = ' Unreachable';
            statusEl.className = 'ag-setting-status ag-setting-failed';
            logger.warn(LOG_SRC, 'Connection test: FAILED');
          }
        }),
    );

    // ── Workspace selector ──
    const wsSetting = new Setting(containerEl)
      .setName('Workspace')
      .setDesc('The Antigravity workspace this vault is associated with. Auto-detected if matching.');

    const wsDropdown = wsSetting.controlEl.createEl('select', { cls: 'dropdown' });
    wsDropdown.createEl('option', { value: '', text: 'Auto-detect from vault path' });

    this.loadWorkspaceOptions(wsDropdown);

    wsDropdown.value = this.plugin.settings.workspaceUri;
    wsDropdown.addEventListener('change', async () => {
      this.plugin.settings.workspaceUri = wsDropdown.value;
      await this.plugin.saveSettings();
      logger.info(LOG_SRC, 'Workspace updated', { workspace: wsDropdown.value || 'auto-detect' });
    });

    // ── Log Level ──
    new Setting(containerEl)
      .setName('Log Level')
      .setDesc('Minimum log level for debug output. Lower levels record more detail for troubleshooting.')
      .addDropdown((dd) =>
        dd
          .addOptions({
            DEBUG: 'DEBUG — Verbose (all details)',
            INFO: 'INFO — Standard',
            WARN: 'WARN — Warnings & errors only',
            ERROR: 'ERROR — Errors only',
          })
          .setValue(this.plugin.settings.logLevel)
          .onChange(async (value) => {
            this.plugin.settings.logLevel = value as LogLevel;
            logger.setLevel(value as LogLevel);
            await this.plugin.saveSettings();
            logger.info(LOG_SRC, `Log level changed to ${value}`);
            new Notice(`Log level set to ${value}`);
          }),
      );

    // ── Dashboard Exclude Folders ──
    const excludeSetting = new Setting(containerEl)
      .setName('Dashboard Exclude Folders')
      .setDesc('Folders excluded from Dashboard analysis. Click folders below to toggle.');

    // Visual folder picker
    const excludeContainer = containerEl.createDiv({ cls: 'ag-exclude-folders' });
    excludeContainer.style.cssText = 'margin: 0 0 16px 0; padding: 12px; border: 1px solid var(--background-modifier-border); border-radius: 8px; max-height: 300px; overflow-y: auto;';

    const excludeSet = new Set(
      (this.plugin.settings.excludeFolders || '').split(',').map(s => s.trim()).filter(Boolean)
    );

    const saveExcludes = async () => {
      this.plugin.settings.excludeFolders = [...excludeSet].join(',');
      await this.plugin.saveSettings();
    };

    // Collect all top-level and second-level folders
    const allFolders = new Set<string>();
    for (const f of this.app.vault.getFiles()) {
      const parts = f.path.split('/');
      if (parts.length > 1) allFolders.add(parts[0]);
      if (parts.length > 2) allFolders.add(parts[0] + '/' + parts[1]);
    }

    const sortedFolders = [...allFolders].sort((a, b) => a.localeCompare(b));

    // "Select all common" preset button
    const presetRow = excludeContainer.createDiv();
    presetRow.style.cssText = 'margin-bottom: 8px; display: flex; gap: 6px;';

    const presetBtn = presetRow.createEl('button', { text: 'Add common excludes', cls: 'mod-muted' });
    presetBtn.style.cssText = 'font-size: 11px; padding: 2px 8px;';
    presetBtn.addEventListener('click', async () => {
      for (const p of ['node_modules', '.git', 'dist', 'build', '.obsidian', '.trash']) {
        excludeSet.add(p);
      }
      await saveExcludes();
      this.display(); // re-render
    });

    const clearBtn = presetRow.createEl('button', { text: '✕ Clear all', cls: 'mod-muted' });
    clearBtn.style.cssText = 'font-size: 11px; padding: 2px 8px;';
    clearBtn.addEventListener('click', async () => {
      excludeSet.clear();
      await saveExcludes();
      this.display();
    });

    // Count files per folder
    const folderFileCounts = new Map<string, number>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const parts = f.path.split('/');
      if (parts.length > 1) {
        const top = parts[0];
        folderFileCounts.set(top, (folderFileCounts.get(top) || 0) + 1);
      }
    }

    for (const folder of sortedFolders) {
      const topFolder = folder.split('/')[0];
      const isExcluded = excludeSet.has(folder) || excludeSet.has(topFolder);
      const isTopLevel = !folder.includes('/');

      const row = excludeContainer.createDiv({ cls: 'ag-folder-row' });
      row.style.cssText = `display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 4px; cursor: pointer; ${!isTopLevel ? 'padding-left: 24px;' : ''}`;
      row.addEventListener('mouseenter', () => { row.style.background = 'var(--background-modifier-hover)'; });
      row.addEventListener('mouseleave', () => { row.style.background = ''; });

      const checkbox = row.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
      checkbox.checked = isExcluded;
      checkbox.style.cssText = 'margin: 0; flex-shrink: 0;';

      const label = row.createSpan({ text: folder });
      label.style.cssText = `font-size: 13px; ${isExcluded ? 'text-decoration: line-through; opacity: 0.5;' : ''}`;

      if (isTopLevel && folderFileCounts.has(folder)) {
        const count = row.createSpan({ text: `${folderFileCounts.get(folder)} notes` });
        count.style.cssText = 'font-size: 10px; color: var(--text-faint); margin-left: auto;';
      }

      const toggleFn = async () => {
        if (excludeSet.has(folder)) {
          excludeSet.delete(folder);
        } else {
          excludeSet.add(folder);
        }
        await saveExcludes();
        // Update visual state inline
        checkbox.checked = excludeSet.has(folder);
        label.style.textDecoration = excludeSet.has(folder) ? 'line-through' : '';
        label.style.opacity = excludeSet.has(folder) ? '0.5' : '1';
      };

      row.addEventListener('click', (e) => {
        if (e.target !== checkbox) toggleFn();
      });
      checkbox.addEventListener('change', toggleFn);
    }

    // ══════════════════════════════════════════════
    // ── Atomization ──
    // ══════════════════════════════════════════════
    containerEl.createEl('h3', { text: 'Atomization (Knowledge Notes)' });

    new Setting(containerEl)
      .setName('Enable Auto Atomization Suggestions')
      .setDesc('Automatically analyze notes with type: knowledge in frontmatter and suggest split/merge/upgrade operations.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.atomizationEnabled).onChange(async (v) => {
          this.plugin.settings.atomizationEnabled = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Settle Wait Time (minutes)')
      .setDesc('Wait this long after the last edit before triggering AI analysis. Also triggers immediately when you leave the note.')
      .addText((text) =>
        text
          .setPlaceholder('5')
          .setValue(String(this.plugin.settings.atomizationSettleMinutes))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (n >= 1 && n <= 30) {
              this.plugin.settings.atomizationSettleMinutes = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    // ══════════════════════════════════════════════
    // ── Translation ──
    // ══════════════════════════════════════════════
    containerEl.createEl('h3', { text: 'Translation (Multilingual)' });

    new Setting(containerEl)
      .setName('Default Target Language')
      .setDesc('The default language for the Translation panel. You can also switch languages inside the panel.')
      .addDropdown((dd) =>
        dd
          .addOption('en', 'English')
          .addOption('zh', '中文')
          .addOption('ja', '日本語')
          .addOption('ko', '한국어')
          .addOption('es', 'Español')
          .addOption('fr', 'Français')
          .addOption('de', 'Deutsch')
          .setValue(this.plugin.settings.translationTargetLang)
          .onChange(async (value) => {
            this.plugin.settings.translationTargetLang = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Auto-open Translation Panel')
      .setDesc('Automatically open the translation panel when the plugin loads.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.translationAutoOpen).onChange(async (v) => {
          this.plugin.settings.translationAutoOpen = v;
          await this.plugin.saveSettings();
        }),
      );

    // ══════════════════════════════════════════════
    // ── Quick Action Provider ──
    // ══════════════════════════════════════════════
    containerEl.createEl('h3', { text: 'Quick Actions (Selection)' });

    new Setting(containerEl)
      .setName('Provider')
      .setDesc('Which AI provider to use when you click a quick action (Translate, Summarize, etc.) on selected text.')
      .addDropdown((dd) =>
        dd
          .addOption('copilot', 'GitHub Copilot — direct inline result')
          .addOption('antigravity', 'Antigravity Chat — send to chat')
          .setValue(this.plugin.settings.quickActionProvider)
          .onChange(async (value) => {
            this.plugin.settings.quickActionProvider = value as 'copilot' | 'antigravity';
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if (this.plugin.settings.quickActionProvider === 'copilot') {
      // Model selector
      const qaModelSetting = new Setting(containerEl)
        .setName('Model')
        .setDesc('Model for quick actions. GPT-4o and GPT-5 mini are free on paid plans.');

      const qaSelect = qaModelSetting.controlEl.createEl('select', { cls: 'dropdown' });
      qaSelect.style.cssText = 'min-width: 260px;';

      const qaCategories = [
        { key: 'included', label: '── Free (paid plans) ──' },
        { key: 'premium', label: '── Premium ──' },
      ] as const;

      for (const cat of qaCategories) {
        const group = qaSelect.createEl('optgroup', { attr: { label: cat.label } });
        for (const m of COPILOT_MODELS.filter(m => m.category === cat.key)) {
          const costLabel = m.multiplier === 0 ? 'FREE' : `${m.multiplier}x`;
          group.createEl('option', { value: m.id, text: `${m.name}  [${costLabel}]` });
        }
      }

      qaSelect.value = this.plugin.settings.quickActionModel;
      qaSelect.addEventListener('change', async () => {
        this.plugin.settings.quickActionModel = qaSelect.value;
        await this.plugin.saveSettings();
      });

      if (!this.plugin.settings.copilotCredentials) {
        new Setting(containerEl)
          .setName('Not logged in — login below')
          .setDesc('Please login with GitHub Copilot in the Inline Completion section below.');
      }
    }

    // ══════════════════════════════════════════════
    // ── Inline Completion ──
    // ══════════════════════════════════════════════
    containerEl.createEl('h3', { text: 'Inline Completion' });

    // Enable toggle
    new Setting(containerEl)
      .setName('Enable Inline Completion')
      .setDesc('Show ghost text suggestions as you type, like GitHub Copilot.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.inlineCompletionEnabled)
          .onChange(async (value) => {
            this.plugin.settings.inlineCompletionEnabled = value;
            await this.plugin.saveSettings();
            this.plugin.updateInlineCompletion();
          }),
      );

    // Provider selection
    new Setting(containerEl)
      .setName('Provider')
      .setDesc('Which AI provider to use for completions.')
      .addDropdown((dd) =>
        dd
          .addOptions({
            copilot: 'GitHub Copilot (use your subscription)',
            openai: 'OpenAI API',
            ollama: 'Ollama (local)',
            custom: 'Custom OpenAI-compatible',
          })
          .setValue(this.plugin.settings.inlineCompletionProvider)
          .onChange(async (value) => {
            this.plugin.settings.inlineCompletionProvider = value as CompletionProvider;
            await this.plugin.saveSettings();
            this.plugin.updateInlineCompletion();
            this.display(); // re-render to show/hide provider-specific settings
          }),
      );

    const provider = this.plugin.settings.inlineCompletionProvider;

    // ── Copilot-specific: login button + quota ──
    if (provider === 'copilot') {
      const copilotSetting = new Setting(containerEl)
        .setName('GitHub Copilot Authentication')
        .setDesc(this.plugin.settings.copilotCredentials ? 'Logged in' : 'Not logged in');

      if (this.plugin.settings.copilotCredentials) {
        // Quota display
        const quotaEl = containerEl.createDiv({ cls: 'ag-copilot-quota' });
        quotaEl.style.cssText = 'padding: 8px 12px; margin: -8px 0 12px; background: var(--background-secondary); border-radius: 8px; font-size: 13px;';
        quotaEl.textContent = 'Loading quota...';

        // Fetch quota async
        const creds = this.plugin.settings.copilotCredentials;
        fetchCopilotUsage(creds.githubToken).then(usage => {
          quotaEl.empty();
          if (usage) {
            const planBadge = quotaEl.createSpan({ text: `${usage.plan.toUpperCase()} ` });
            planBadge.style.cssText = 'font-weight: bold; margin-right: 8px;';

            const premLabel = usage.premiumRemaining >= 0 ? `Premium: ${usage.premiumRemaining}%` : 'Premium: N/A';
            const chatLabel = usage.chatRemaining >= 0 ? `Chat: ${usage.chatRemaining}%` : 'Chat: N/A';
            quotaEl.createSpan({ text: `${premLabel} remaining · ${chatLabel} remaining` });

            // Color-coded bar
            if (usage.premiumRemaining >= 0) {
              const bar = quotaEl.createDiv();
              bar.style.cssText = 'margin-top: 6px; height: 4px; border-radius: 2px; background: var(--background-modifier-border); overflow: hidden;';
              const fill = bar.createDiv();
              const pct = Math.max(0, Math.min(100, usage.premiumRemaining));
              const color = pct > 50 ? 'rgb(46,160,67)' : pct > 20 ? 'rgb(210,153,34)' : 'rgb(218,54,51)';
              fill.style.cssText = `height: 100%; width: ${pct}%; background: ${color}; border-radius: 2px; transition: width 0.3s;`;
            }
          } else {
            quotaEl.textContent = 'Could not fetch quota';
          }
        });

        copilotSetting.addButton((btn) =>
          btn.setButtonText('Logout').setWarning().onClick(async () => {
            this.plugin.settings.copilotCredentials = null;
            await this.plugin.saveSettings();
            this.plugin.updateInlineCompletion();
            this.display();
            new Notice('Logged out from GitHub Copilot');
          }),
        );
      } else {
        copilotSetting.addButton((btn) =>
          btn.setButtonText('Login with GitHub').setCta().onClick(async () => {
            try {
              const creds = await loginWithGitHubCopilot((userCode, uri) => {
                const modal = new CopilotLoginModal(this.app, userCode, uri);
                modal.open();
              });
              this.plugin.settings.copilotCredentials = creds;
              await this.plugin.saveSettings();
              this.plugin.updateInlineCompletion();
              this.display();
              new Notice('✅ GitHub Copilot login successful!');
            } catch (e: any) {
              new Notice(`Login failed: ${e.message}`);
            }
          }),
        );
      }
    }

    // ── OpenAI / Custom: API key & base URL ──
    if (provider === 'openai' || provider === 'custom') {
      new Setting(containerEl)
        .setName('API Key')
        .setDesc('Your API key for the completion provider.')
        .addText((text) =>
          text
            .setPlaceholder('sk-...')
            .setValue(this.plugin.settings.inlineCompletionApiKey)
            .onChange(async (value) => {
              this.plugin.settings.inlineCompletionApiKey = value;
              await this.plugin.saveSettings();
              this.plugin.updateInlineCompletion();
            }),
        );
    }

    if (provider === 'custom' || provider === 'ollama') {
      new Setting(containerEl)
        .setName('API Base URL')
        .setDesc(provider === 'ollama' ? 'Ollama endpoint (default: http://localhost:11434/v1)' : 'Custom OpenAI-compatible endpoint.')
        .addText((text) =>
          text
            .setPlaceholder(provider === 'ollama' ? 'http://localhost:11434/v1' : 'https://api.example.com/v1')
            .setValue(this.plugin.settings.inlineCompletionApiBaseUrl)
            .onChange(async (value) => {
              this.plugin.settings.inlineCompletionApiBaseUrl = value;
              await this.plugin.saveSettings();
              this.plugin.updateInlineCompletion();
            }),
        );
    }

    // Model selection
    if (provider === 'copilot') {
      // Rich model selector with multiplier info
      const modelSetting = new Setting(containerEl)
        .setName('Model')
        .setDesc('Select a model. Multiplier shows premium request cost per interaction.');

      const modelSelect = modelSetting.controlEl.createEl('select', { cls: 'dropdown' });
      modelSelect.style.cssText = 'min-width: 280px;';

      const categories = [
        { key: 'included', label: '── Included (free on paid plans) ──' },
        { key: 'premium', label: '── Premium ──' },
        { key: 'ultra', label: '── Ultra ──' },
      ] as const;

      for (const cat of categories) {
        const group = modelSelect.createEl('optgroup', { attr: { label: cat.label } });
        for (const m of COPILOT_MODELS.filter(m => m.category === cat.key)) {
          const costLabel = m.multiplier === 0
            ? 'FREE'
            : m.multiplier < 1
            ? `${m.multiplier}x fast`
            : m.multiplier >= 3
            ? `${m.multiplier}x premium`
            : `${m.multiplier}x`;
          group.createEl('option', {
            value: m.id,
            text: `${m.name}  [${costLabel}]`,
          });
        }
      }

      modelSelect.value = this.plugin.settings.inlineCompletionModel;
      modelSelect.addEventListener('change', async () => {
        this.plugin.settings.inlineCompletionModel = modelSelect.value;
        await this.plugin.saveSettings();
        this.plugin.updateInlineCompletion();
      });

      // If logged in, try to fetch live models from API
      if (this.plugin.settings.copilotCredentials) {
        const creds = this.plugin.settings.copilotCredentials;
        fetchCopilotModels(creds.copilotToken, creds.apiBaseUrl).then(() => {
          // Static catalog is always used for display; API fetch is for validation
        });
      }
    } else {
      new Setting(containerEl)
        .setName('Model')
        .setDesc('Model ID for completions.')
        .addText((text) =>
          text
            .setPlaceholder(provider === 'ollama' ? 'llama3.2' : 'gpt-4o-mini')
            .setValue(this.plugin.settings.inlineCompletionModel)
            .onChange(async (value) => {
              this.plugin.settings.inlineCompletionModel = value;
              await this.plugin.saveSettings();
              this.plugin.updateInlineCompletion();
            }),
        );
    }

    // Trigger delay
    new Setting(containerEl)
      .setName('Trigger Delay')
      .setDesc('Milliseconds to wait after typing before requesting a suggestion (100-2000).')
      .addText((text) =>
        text
          .setPlaceholder('500')
          .setValue(String(this.plugin.settings.inlineCompletionDelay))
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            if (num >= 100 && num <= 2000) {
              this.plugin.settings.inlineCompletionDelay = num;
              await this.plugin.saveSettings();
              this.plugin.updateInlineCompletion();
            }
          }),
      );

    // ══════════════════════════════════════════════
    // ── Debug Actions ──
    // ══════════════════════════════════════════════
    containerEl.createEl('h3', { text: 'Debug' });

    new Setting(containerEl)
      .setName('Export Debug Logs')
      .setDesc(`Copy ${logger.getEntries().length} log entries to clipboard for troubleshooting.`)
      .addButton((btn) =>
        btn
          .setButtonText('Copy Logs')
          .onClick(async () => {
            const text = logger.exportAsText();
            await navigator.clipboard.writeText(text);
            new Notice(`Debug logs copied (${logger.getEntries().length} entries)`);
          }),
      );
  }

  private async loadWorkspaceOptions(dropdown: HTMLSelectElement) {
    try {
      const servers = await this.plugin.client.getServers();
      for (const s of servers) {
        const ws = s.workspace || `file://localhost:${s.port}`;
        dropdown.createEl('option', { value: ws, text: ws.replace('file://', '') });
      }
      if (this.plugin.settings.workspaceUri) {
        dropdown.value = this.plugin.settings.workspaceUri;
      }
    } catch {
      logger.debug(LOG_SRC, 'Could not load workspace options (gateway not running)');
    }
  }
}

// ── Copilot Login Modal ──

class CopilotLoginModal extends Modal {
  constructor(app: App, private userCode: string, private verificationUri: string) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'GitHub Copilot Login' });
    contentEl.createEl('p', { text: 'Open the URL below and enter this code:' });

    const codeEl = contentEl.createEl('div');
    codeEl.style.cssText = 'font-size: 28px; font-weight: bold; text-align: center; padding: 16px; margin: 12px 0; background: var(--background-secondary); border-radius: 8px; letter-spacing: 4px; font-family: monospace; cursor: pointer;';
    codeEl.textContent = this.userCode;
    codeEl.title = 'Click to copy';
    codeEl.addEventListener('click', () => {
      navigator.clipboard.writeText(this.userCode);
      new Notice('Code copied!');
    });

    const linkEl = contentEl.createEl('a', {
      text: this.verificationUri,
      href: this.verificationUri,
    });
    linkEl.style.cssText = 'display: block; text-align: center; margin: 8px 0 16px; font-size: 14px;';

    contentEl.createEl('p', {
      text: 'Waiting for authorization... This dialog will close automatically.',
      cls: 'mod-muted',
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
