/**
 * Antigravity Obsidian Plugin — Main entry point.
 *
 * Registers a right-sidebar Chat View for conversing with
 * the Antigravity Gateway server directly inside Obsidian.
 * Initialises the structured logger and exports debug logs command.
 */

import { Plugin, WorkspaceLeaf, Notice, Menu, TFile } from 'obsidian';
import { ChatView, VIEW_TYPE_CHAT } from './chat-view';
import { GatewayClient } from './api-client';
import { AntigravitySettingTab, DEFAULT_SETTINGS, type AntigravitySettings } from './settings';
import { logger, type LogLevel } from './logger';
import { createInlineCompletionExtensions, type InlineCompletionConfig } from './inline-completion';
import { KnowledgeEngine, FileIndexStore, IDBIndexStore } from './knowledge-engine';
import { RelatedNotesView, VIEW_TYPE_RELATED } from './related-notes-view';
import { CopilotKnowledgeProvider } from './copilot-knowledge-provider';
import { LinkSuggester } from './link-suggester';
import { KnowledgeSteward } from './knowledge-steward';
import { VaultHealthView, VIEW_TYPE_VAULT_HEALTH } from './vault-health-view';
import { analyzeSplit, executeSplit, analyzeMerge, executeMerge, analyzeUpgrade, executeUpgrade } from './atom-operations';
import { AtomizationManager, SplitConfirmModal } from './atomization-manager';
import { showVaultDashboard } from './vault-dashboard-ui';
import { showPromptManager } from './prompt-manager-ui';
import { FloatingToolbarManager } from './floating-toolbar';
import { TranslationEngine, type SupportedLang, LANG_LABELS } from './translation-engine';
import { TranslationView, VIEW_TYPE_TRANSLATION } from './translation-view';
import { TranslationReader } from './translation-reader';

export default class AntigravityPlugin extends Plugin {
  settings!: AntigravitySettings;
  client!: GatewayClient;
  private statusBarEl: HTMLElement | null = null;
  private statusCheckInterval: ReturnType<typeof setInterval> | null = null;
  private selectionDisplayInterval: ReturnType<typeof setInterval> | null = null;
  private lastGatewayConnected = false;
  private cachedSelection = '';
  // Floating toolbar (extracted module)
  private floatingToolbarManager!: FloatingToolbarManager;
  // Inline completion
  private inlineCompletionExtensions: any[] | null = null;
  // Knowledge engine
  knowledgeEngine!: KnowledgeEngine;
  // Link suggester
  private linkSuggester: LinkSuggester | null = null;
  // Knowledge steward
  private steward: KnowledgeSteward | null = null;
  // Atomization manager (extracted module)
  private atomizationManager!: AtomizationManager;
  // Translation engine
  translationEngine!: TranslationEngine;
  // Translation reader (Reading View overlay)
  private translationReader!: TranslationReader;

  async onload() {
    await this.loadSettings();

    // Configure logger from settings
    logger.setLevel((this.settings.logLevel || 'INFO') as LogLevel);
    logger.info('Plugin', 'Plugin loading', { version: this.manifest.version });

    this.client = new GatewayClient(this.settings.gatewayUrl);

    // Register the chat view
    this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this));

    // Register the related notes view
    const useIDB = typeof indexedDB !== 'undefined';
    const store = useIDB
      ? new IDBIndexStore(this.app.vault.getName())
      : new FileIndexStore(this.app, this.manifest.id);
    this.knowledgeEngine = new KnowledgeEngine(this.app, store);

    this.registerView(VIEW_TYPE_RELATED, (leaf) => {
      const view = new RelatedNotesView(leaf, this.knowledgeEngine);
      // Wire engine updates to view
      this.knowledgeEngine.setOnRelationsUpdate((path, _rels) => {
        view.onRelationsUpdated(path);
      });
      // Wire atom split execution from sidebar suggestion
      view.onExecuteSplit = (filePath: string) => {
        this.atomizationManager.executeAtomSplitFromSuggestion(filePath);
      };
      // Wire merge execution (direct with paths)
      view.onExecuteMerge = async (pathA: string, pathB: string) => {
        if (!this.settings.copilotCredentials) {
          new Notice('Copilot login required for AI Merge');
          return;
        }
        new Notice('Analyzing merge opportunity...');
        try {
          const plan = await analyzeMerge(
            this.app, pathA, pathB,
            () => this.settings.copilotCredentials ?? null,
            (c) => { this.settings.copilotCredentials = c; this.saveSettings(); },
          );
          if (!plan) {
            new Notice('Merge analysis returned no result');
            return;
          }
          new Notice(`Merging into "${plan.title}"...`);
          const mergedPath = await executeMerge(this.app, plan);
          if (mergedPath) {
            new Notice(`Merged! Created "${plan.title}", originals archived.`);
            const mergedFile = this.app.vault.getAbstractFileByPath(mergedPath);
            if (mergedFile instanceof TFile) {
              this.app.workspace.getLeaf(false).openFile(mergedFile);
            }
            // Clear suggestion caches for both source notes
            this.atomizationManager.cache.delete(pathA);
            this.atomizationManager.cache.delete(pathB);
            this.atomizationManager.persistSuggestions();
          }
        } catch (e) {
          new Notice('Merge failed: ' + (e as Error).message);
        }
      };
      // Wire upgrade execution
      view.onExecuteUpgrade = (filePath: string) => {
        (this.app as any).commands.executeCommandById('obsidian-antigravity:atom-upgrade');
      };
      // Wire AI enrich for single note
      view.onEnrichNote = async (filePath: string) => {
        if (!this.settings.copilotCredentials) {
          new Notice('Copilot login required. Run "Antigravity: Login with Copilot"');
          return;
        }
        new Notice('AI enriching current note...');
        const count = await this.knowledgeEngine.enrichBatch(1);
        if (count > 0) {
          new Notice('AI enrichment complete');
        } else {
          new Notice('No unenriched notes found (already enriched?)');
        }
      };
      // Wire dismiss (persisted)
      view.onDismissSuggestions = (filePath: string) => {
        this.atomizationManager.dismissSuggestions(filePath);
      };
      // Set Copilot connection state
      view.copilotConnected = !!this.settings.copilotCredentials;
      // Set onboarding step
      view.onboardingStep = this.settings.onboardingStep ?? 0;
      view.onOnboardingAdvance = (step: number) => {
        this.settings.onboardingStep = step;
        this.saveSettings();
      };
      return view;
    });

    // Register the vault health view
    this.steward = new KnowledgeSteward(this.app, this.knowledgeEngine);
    this.registerView(VIEW_TYPE_VAULT_HEALTH, (leaf) => {
      return new VaultHealthView(
        leaf, this.steward!, this.knowledgeEngine,
        () => this.settings.copilotCredentials ?? null,
        (c) => { this.settings.copilotCredentials = c; this.saveSettings(); },
      );
    });

    // Initialize atomization manager (extracted module)
    this.atomizationManager = new AtomizationManager(
      this.app,
      () => this.settings,
      () => this.saveSettings(),
      this.knowledgeEngine,
      this.steward,
      this.manifest.id,
    );

    // Initialize translation engine
    this.translationEngine = new TranslationEngine(
      this.app,
      () => this.settings.copilotCredentials ?? null,
      (c) => { this.settings.copilotCredentials = c; this.saveSettings(); },
    );

    // Register the translation view
    this.registerView(VIEW_TYPE_TRANSLATION, (leaf) => {
      const lang = (this.settings.translationTargetLang || 'en') as SupportedLang;
      const view = new TranslationView(leaf, this.translationEngine, lang);
      view.onTargetLangChanged = (newLang) => {
        this.settings.translationTargetLang = newLang;
        this.saveSettings();
      };
      return view;
    });

    // Initialize translation reader (Reading View overlay + toolbar)
    this.translationReader = new TranslationReader(
      this.app,
      this.translationEngine,
      () => (this.settings.translationTargetLang || 'en') as SupportedLang,
      (lang: SupportedLang) => {
        this.settings.translationTargetLang = lang;
        this.saveSettings();
      },
      (active) => {
        // Update ribbon icon visual state
        const ribbonEl = document.querySelector('.side-dock-ribbon-action[aria-label="Toggle Translation View"]');
        if (ribbonEl) {
          ribbonEl.classList.toggle('ag-translation-view-action-active', active);
        }
      },
    );
    this.addChild(this.translationReader);

    // Initialize knowledge engine after layout is ready
    this.app.workspace.onLayoutReady(async () => {
      await this.knowledgeEngine.initialize(this.settings.excludeFolders);

      // Attach Copilot AI provider if authenticated
      if (this.settings.copilotCredentials) {
        this.knowledgeEngine.setProvider(new CopilotKnowledgeProvider(
          () => this.settings.copilotCredentials ?? null,
          (creds) => {
            this.settings.copilotCredentials = creds;
            this.saveSettings();
          },
        ));
      }

      // Initialize LinkSuggester
      this.linkSuggester = new LinkSuggester(this.app, this.knowledgeEngine);

      // Load persisted atom suggestions
      await this.atomizationManager.loadSuggestions();
    });

    // Hook vault events for incremental index updates
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile) this.knowledgeEngine.onFileModified(file);
      })
    );
    this.registerEvent(
      this.app.vault.on('create', (file) => {
        if (file instanceof TFile) this.knowledgeEngine.onFileCreated(file);
      })
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file instanceof TFile) {
          this.knowledgeEngine.onFileDeleted(file.path);
          this.translationEngine.onFileDeleted(file.path);
        }
      })
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile) {
          this.knowledgeEngine.onFileRenamed(oldPath, file.path);
          this.translationEngine.onFileRenamed(oldPath, file.path);
        }
      })
    );

    // Hook editor changes for LinkSuggester
    this.registerEvent(
      this.app.workspace.on('editor-change', () => {
        this.linkSuggester?.onEditorChange();
      })
    );

    // ── Atomization auto-trigger: settle timer on knowledge note edits ──
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile) this.atomizationManager.onKnowledgeNoteModified(file);
      })
    );

    // ── Atomization auto-trigger: analyze when user leaves a knowledge note ──
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        this.atomizationManager.onActiveLeafChangeForAtomization();
        // Update translation state on leaf change (non-blocking, follows to new file)
        this.translationReader.onActiveLeafChange().catch(() => {/* ignore */});
      })
    );

    // Add ribbon icon to open chat
    this.addRibbonIcon('bot', 'Open Google Antigravity Chat', () => {
      this.activateView();
    });

    // Add ribbon icon to open related notes
    this.addRibbonIcon('link', 'Open Related Notes', () => {
      this.activateRelatedNotesView();
    });

    // Add ribbon icon: toggle translation in Reading View
    this.addRibbonIcon('languages', 'Toggle Translation View', async () => {
      if (!this.settings.copilotCredentials) {
        new Notice('Copilot login required for translation');
        return;
      }
      await this.translationReader.toggle();
    });

    // Add command: open chat
    this.addCommand({
      id: 'open-chat',
      name: 'Open Google Antigravity Chat',
      callback: () => this.activateView(),
    });

    // Add command: open related notes
    this.addCommand({
      id: 'open-related-notes',
      name: 'Open Related Notes Panel',
      callback: () => this.activateRelatedNotesView(),
    });

    // Add command: open translation panel
    this.addCommand({
      id: 'open-translation',
      name: 'Open Translation Panel',
      callback: () => this.activateTranslationView(),
    });

    // Add command: translate current note
    this.addCommand({
      id: 'translate-current-note',
      name: 'Translate Current Note',
      callback: async () => {
        if (!this.settings.copilotCredentials) {
          new Notice('Copilot login required for translation');
          return;
        }
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') {
          new Notice('No active markdown file');
          return;
        }
        const lang = (this.settings.translationTargetLang || 'en') as SupportedLang;
        new Notice(`Translating to ${LANG_LABELS[lang]}...`);
        const content = await this.app.vault.cachedRead(file);
        const result = await this.translationEngine.translateFile(file.path, content, lang);
        if (result) {
          new Notice(`Translation complete → ${LANG_LABELS[lang]}`);
          await this.activateTranslationView();
        } else {
          new Notice('Translation failed');
        }
      },
    });

    // Add command: toggle translation language (quick switch zh↔en)
    this.addCommand({
      id: 'toggle-translation-lang',
      name: 'Toggle Translation Language (ZH ↔ EN)',
      callback: () => {
        const current = this.settings.translationTargetLang;
        const next: SupportedLang = current === 'en' ? 'zh' : 'en';
        this.settings.translationTargetLang = next;
        this.saveSettings();
        // Update existing translation view
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TRANSLATION);
        for (const leaf of leaves) {
          if (leaf.view instanceof TranslationView) {
            (leaf.view as TranslationView).setTargetLang(next);
          }
        }
        // Refresh reading view overlay if active
        if (this.translationReader.isActive()) {
          this.translationReader.refresh();
        }
        new Notice(`Translation target: ${LANG_LABELS[next]}`);
      },
    });

    // Add command: toggle translation in Reading View (in-place overlay)
    this.addCommand({
      id: 'toggle-translation-reader',
      name: 'Toggle Translation in Reading View',
      callback: async () => {
        if (!this.settings.copilotCredentials) {
          new Notice('Copilot login required for translation');
          return;
        }
        await this.translationReader.toggle();
        const state = this.translationReader.isActive() ? 'ON' : 'OFF';
        new Notice(`Reading View translation: ${state}`);
      },
    });

    // Add command: rebuild knowledge index
    this.addCommand({
      id: 'rebuild-knowledge-index',
      name: 'Rebuild Knowledge Index',
      callback: async () => {
        new Notice('Rebuilding knowledge index...');
        await this.knowledgeEngine.fullBuild();
        new Notice('Knowledge index rebuilt!');
      },
    });

    // Add command: AI enrich notes
    this.addCommand({
      id: 'enrich-notes-ai',
      name: 'AI Enrich Notes (Copilot)',
      callback: async () => {
        if (!this.settings.copilotCredentials) {
          new Notice('Please login to GitHub Copilot first (Settings → Inline Completion)');
          return;
        }
        // Ensure provider is set
        if (!this.knowledgeEngine.getStats().totalNotes) {
          new Notice('Knowledge index is empty. Rebuild first.');
          return;
        }
        new Notice('Starting AI enrichment (max 20 notes)...');
        const count = await this.knowledgeEngine.enrichBatch(20, (done, total) => {
          if (done % 5 === 0) new Notice(`Enriching... ${done}/${total}`);
        });
        new Notice(`AI enrichment complete: ${count} notes enriched`);
      },
    });

    // Add command: export debug logs
    this.addCommand({
      id: 'export-debug-logs',
      name: 'Export Debug Logs (Copy to Clipboard)',
      callback: async () => {
        const text = logger.exportAsText();
        await navigator.clipboard.writeText(text);
        new Notice(`Debug logs copied to clipboard (${logger.getEntries().length} entries)`);
        logger.info('Plugin', 'Debug logs exported to clipboard');
      },
    });

    // Add command: clear logs
    this.addCommand({
      id: 'clear-debug-logs',
      name: 'Clear Debug Logs',
      callback: () => {
        logger.clear();
        new Notice('Debug logs cleared');
      },
    });

    // Add command: Vault Dashboard
    this.addCommand({
      id: 'vault-dashboard',
      name: 'Vault Knowledge Dashboard',
      callback: () => showVaultDashboard(this.app, this.settings, () => this.activateView()),
    });

    // Add command: Vault Health Report
    this.addCommand({
      id: 'vault-health',
      name: 'Vault Health Report',
      callback: () => this.activateVaultHealthView(),
    });

    // Add command: Prompt Manager
    this.addCommand({
      id: 'prompt-manager',
      name: 'Manage Prompt Templates',
      callback: () => showPromptManager(this.app, this.settings, () => this.saveSettings()),
    });

    // Add command: AI Split current note into atoms
    this.addCommand({
      id: 'atom-split',
      name: 'AI Atom Split (Current Note)',
      callback: async () => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) { new Notice('No active file'); return; }
        // Guard: atom notes should not be split further
        const profile = this.knowledgeEngine.getProfile(activeFile.path);
        logger.info('AtomSplit', 'Checking file', { path: activeFile.path, role: profile?.role ?? 'none' });
        if (profile && profile.role === 'atom') {
          new Notice('This note is already an atom — it cannot be split further');
          return;
        }
        if (!this.settings.copilotCredentials) {
          new Notice('Copilot login required for AI atom operations');
          return;
        }
        new Notice('Analyzing note for split opportunities...');
        try {
          const plan = await analyzeSplit(
            this.app, activeFile.path,
            () => this.settings.copilotCredentials ?? null,
            (c) => { this.settings.copilotCredentials = c; this.saveSettings(); },
          );
          logger.info('AtomSplit', 'Analysis result', { atoms: plan?.atoms?.length ?? 0 });
          if (!plan || plan.atoms.length === 0) {
            new Notice('No split opportunities found');
            return;
          }
          // Show confirmation modal
          new SplitConfirmModal(this.app, activeFile.path, plan, async (confirmed) => {
            if (!confirmed) {
              new Notice('Split cancelled');
              return;
            }
            new Notice(`Splitting into ${plan.atoms.length} atoms...`);
            const created = await executeSplit(this.app, activeFile.path, plan);
            new Notice(`Created ${created.length} atom note(s)`);
          }).open();
        } catch (e) {
          logger.error('AtomSplit', 'Analysis failed', { error: (e as Error).message, stack: (e as Error).stack });
          new Notice('Atom split failed: ' + (e as Error).message);
        }
      },
    });

    // Add command: AI Upgrade current atom with related info
    this.addCommand({
      id: 'undo-last-split',
      name: 'Undo Last Atom Split',
      callback: async () => {
        const rollbackPath = `${this.app.vault.configDir}/plugins/${this.manifest.id}/last-split-rollback.json`;
        try {
          if (!await this.app.vault.adapter.exists(rollbackPath)) {
            new Notice('No split to undo');
            return;
          }
          const raw = await this.app.vault.adapter.read(rollbackPath);
          const data = JSON.parse(raw);

          // Restore original file content
          const sourceFile = this.app.vault.getAbstractFileByPath(data.sourcePath);
          if (sourceFile instanceof TFile) {
            await this.app.vault.modify(sourceFile, data.originalContent);
          }

          // Delete created atom files (but NOT the folder — may contain other files)
          let deletedCount = 0;
          for (const createdPath of data.createdPaths) {
            const f = this.app.vault.getAbstractFileByPath(createdPath);
            if (f instanceof TFile) {
              await this.app.vault.delete(f);
              deletedCount++;
            }
          }

          // Remove rollback file
          await this.app.vault.adapter.remove(rollbackPath);
          new Notice(`Undo complete: restored original, deleted ${deletedCount} atom file(s). Subfolder preserved.`);
        } catch (e) {
          new Notice('Undo failed: ' + (e as Error).message);
        }
      },
    });

    this.addCommand({
      id: 'atom-upgrade',
      name: 'AI Atom Upgrade (Current Note)',
      callback: async () => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) { new Notice('No active file'); return; }
        if (!this.settings.copilotCredentials) {
          new Notice('Copilot login required for AI atom operations');
          return;
        }
        // Find top related note to use as upgrade source
        const content = await this.app.vault.cachedRead(activeFile);
        const related = this.knowledgeEngine.queryByText(content, 3, new Set([activeFile.path]));
        if (related.length === 0) {
          new Notice('No related notes found for upgrade');
          return;
        }
        new Notice('Analyzing upgrade opportunities...');
        // Try each related note until one yields an upgrade
        for (const rel of related) {
          const suggestion = await analyzeUpgrade(
            this.app, activeFile.path, rel.path,
            () => this.settings.copilotCredentials ?? null,
            (c) => { this.settings.copilotCredentials = c; this.saveSettings(); },
          );
          if (suggestion) {
            new Notice(`Upgrade found from "${rel.path.split('/').pop()}". Applying...`);
            await executeUpgrade(this.app, suggestion);
            new Notice('Atom upgraded successfully!');
            return;
          }
        }
        new Notice('No upgrade opportunities found');
      },
    });

    // Add settings tab
    this.addSettingTab(new AntigravitySettingTab(this.app, this));

    // ── Editor Context Menu: Quick Actions ──
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu: Menu, editor) => {
        const selection = editor.getSelection();
        if (!selection) return;

        // Ask Antigravity (free-form)
        menu.addItem((item) =>
          item
            .setTitle('Ask Antigravity')
            .setIcon('bot')
            .onClick(async () => {
              await this.activateView();
              const chatLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
              if (chatLeaf?.view instanceof ChatView) {
                const activeFile = this.app.workspace.getActiveFile();
                const vaultBase = (this.app.vault.adapter as any).basePath as string;
                let prefix = '';
                if (activeFile) {
                  prefix = `@[${vaultBase}/${activeFile.path}] `;
                }
                (chatLeaf.view as ChatView).setInputText(prefix + selection);
              }
            }),
        );

        // Quick Actions from prompt templates
        const templates = (this.settings.promptTemplates || []).filter(t => t.prompt);
        for (const tmpl of templates.slice(0, 10)) { // Show up to 10 in context menu
          menu.addItem((item) =>
            item.setTitle(tmpl.name).setIcon(tmpl.icon).onClick(async () => {
              const resolved = await this.floatingToolbarManager.resolvePromptVariables(tmpl.prompt, selection);
              if (resolved === null) return;

              await this.activateView();
              const chatLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
              if (chatLeaf?.view instanceof ChatView) {
                const activeFile = this.app.workspace.getActiveFile();
                const vaultBase = (this.app.vault.adapter as any).basePath as string;
                let prefix = '';
                if (activeFile) prefix = `@[${vaultBase}/${activeFile.path}] `;
                (chatLeaf.view as ChatView).quickSend(prefix + resolved);
              }
            }),
          );
        }
      }),
    );

    // ── File Menu: "Send to Antigravity Chat" + "AI Atom Split" ──
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu: Menu, file) => {
        menu.addItem((item) =>
          item
            .setTitle('Send to Antigravity Chat')
            .setIcon('bot')
            .onClick(async () => {
              await this.activateView();
              const chatLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
              if (chatLeaf?.view instanceof ChatView) {
                const vaultBase = (this.app.vault.adapter as any).basePath as string;
                (chatLeaf.view as ChatView).setInputText(`@[${vaultBase}/${file.path}] `);
              }
            }),
        );
        if (file instanceof TFile && file.extension === 'md') {
          // Don't show split option for atom notes
          const fileProfile = this.knowledgeEngine.getProfile(file.path);
          if (!fileProfile || fileProfile.role !== 'atom') {
            menu.addItem((item) =>
              item
                .setTitle('AI Atom Split')
                .setIcon('scissors')
                .onClick(() => {
                  this.app.workspace.getLeaf(false).openFile(file).then(() => {
                    (this.app as any).commands.executeCommandById('obsidian-antigravity:atom-split');
                  });
                }),
            );
          }
        }
      }),
    );

    // Auto-open on the right if not already open
    this.app.workspace.onLayoutReady(() => {
      const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
      if (leaves.length === 0) {
        this.activateView();
      }
      // Auto-open translation panel if enabled
      if (this.settings.translationAutoOpen) {
        const tLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TRANSLATION);
        if (tLeaves.length === 0) {
          this.activateTranslationView();
        }
      }
    });

    // ── Hot Reload: watch main.js for changes ──
    this.setupHotReload();

    // ── StatusBar: connection indicator ──
    this.setupStatusBar();

    // ── Floating Toolbar: appears on text selection ──
    this.floatingToolbarManager = new FloatingToolbarManager(
      this.app, this,
      () => this.settings, () => this.saveSettings(),
      () => this.activateView(), () => this.getEditorSelection(),
    );
    this.floatingToolbarManager.setup();

    // ── Inline Completion: ghost text suggestions ──
    this.setupInlineCompletion();

    logger.info('Plugin', 'Plugin loaded successfully');
  }

  async onunload() {
    logger.info('Plugin', 'Plugin unloading');
    this.client.disconnectWs();
    this.teardownHotReload();
    if (this.statusCheckInterval) clearInterval(this.statusCheckInterval);
    if (this.selectionDisplayInterval) clearInterval(this.selectionDisplayInterval);
    this.floatingToolbarManager.remove();
    this.linkSuggester?.destroy();
  }

  private hotReloadWatcher: any = null;

  private setupHotReload() {
    try {
      const fs = require('fs');
      const path = require('path');
      const vaultBase = (this.app.vault.adapter as any).basePath as string;
      const pluginDir = path.join(vaultBase, '.obsidian', 'plugins', this.manifest.id);
      const mainJsPath = path.join(pluginDir, 'main.js');

      let debounceTimer: ReturnType<typeof setTimeout> | null = null;

      this.hotReloadWatcher = fs.watch(pluginDir, (eventType: string, filename: string) => {
        if (filename !== 'main.js' && filename !== 'styles.css') return;

        // Debounce — wait for all files to be written
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          logger.info('Plugin', `Hot reload triggered by ${filename} change`);
          new Notice('Antigravity plugin reloading...');

          // Short delay to ensure file write is complete
          await new Promise(r => setTimeout(r, 300));

          // Disable then re-enable the plugin (Obsidian's reload mechanism)
          const plugins = (this.app as any).plugins;
          if (plugins) {
            await plugins.disablePlugin(this.manifest.id);
            await plugins.enablePlugin(this.manifest.id);
            new Notice('Antigravity plugin reloaded');
          }
        }, 500);
      });

      logger.info('Plugin', `Hot reload watching: ${pluginDir}`);
    } catch (err: any) {
      logger.warn('Plugin', 'Hot reload setup failed (non-critical)', { error: err?.message });
    }
  }

  private teardownHotReload() {
    if (this.hotReloadWatcher) {
      try { this.hotReloadWatcher.close(); } catch { /* ignore */ }
      this.hotReloadWatcher = null;
    }
  }

  private setupStatusBar() {
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass('ag-statusbar');
    this.statusBarEl.style.cursor = 'pointer';
    this.updateStatusBar(false);

    // Click to open chat (or send selection if text selected)
    this.statusBarEl.addEventListener('click', async () => {
      if (this.cachedSelection.length > 0) {
        await this.activateView();
        const chatLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
        if (chatLeaf?.view instanceof ChatView) {
          (chatLeaf.view as ChatView).setInputText(this.cachedSelection);
          this.cachedSelection = '';  // Clear after sending
        }
      } else {
        this.activateView();
      }
    });

    // Periodic health check (every 30s) + selection display
    this.checkGatewayStatus();
    this.statusCheckInterval = setInterval(() => this.checkGatewayStatus(), 30000);

    // Fast selection display update (every 500ms)
    this.selectionDisplayInterval = setInterval(() => {
      this.updateStatusBar(this.lastGatewayConnected);
    }, 500);
  }

  private async checkGatewayStatus() {
    const connected = await this.client.ping();
    this.lastGatewayConnected = connected;
    this.updateStatusBar(connected);
  }

  private getEditorSelection(): string {
    // Try CodeMirror editor first
    const editor = this.app.workspace.activeEditor?.editor;
    const cmSel = editor?.getSelection?.() || '';
    if (cmSel) return cmSel;
    // Fallback: window.getSelection for Reading View / rendered tables
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
        return winSel.toString() || '';
      }
    }
    return '';
  }

  private updateStatusBar(connected: boolean) {
    if (!this.statusBarEl) return;
    this.statusBarEl.empty();

    const dot = connected ? '●' : '○';
    // Only update cached selection when there's a new one; don't clear on focus loss
    const freshSel = this.getEditorSelection();
    if (freshSel) this.cachedSelection = freshSel;
    const sel = this.cachedSelection;

    if (sel.length > 0) {
      this.statusBarEl.setText(`${dot} AG ✂ ${sel.length} chars`);
      this.statusBarEl.title = `Click to send selection to Antigravity Chat`;
    } else if (connected) {
      this.statusBarEl.setText(`${dot} AG`);
      this.statusBarEl.title = 'Antigravity Connected — Click to open chat';
    } else {
      this.statusBarEl.setText(`${dot} AG`);
      this.statusBarEl.title = 'Antigravity Disconnected — Click to open chat';
    }
  }


  async activateView() {
    const { workspace } = this.app;

    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_CHAT);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  async activateRelatedNotesView() {
    const { workspace } = this.app;

    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_RELATED);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: VIEW_TYPE_RELATED, active: true });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  async activateVaultHealthView() {
    const { workspace } = this.app;

    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_VAULT_HEALTH);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: VIEW_TYPE_VAULT_HEALTH, active: true });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
      // Auto-run analysis when opening
      const view = leaf.view;
      if (view instanceof VaultHealthView) {
        view.runAnalysis();
      }
    }
  }

  async activateTranslationView() {
    const { workspace } = this.app;

    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_TRANSLATION);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: VIEW_TYPE_TRANSLATION, active: true });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    let needsSave = false;

    // Migrate v1: old showInToolbar migration
    const templates = this.settings.promptTemplates;
    if (templates && templates.length > 0 && templates[0].showInToolbar === undefined) {
      const userTemplates = templates
        .filter((t: any) => !t.id.startsWith('builtin-'))
        .map((t: any) => ({ ...t, showInToolbar: t.showInToolbar ?? false, toolbarOrder: t.toolbarOrder ?? 0 }));
      this.settings.promptTemplates = [...DEFAULT_SETTINGS.promptTemplates, ...userTemplates];
      needsSave = true;
    }

    // Migrate v2: old submenu-based templates → variable-based templates
    // Detect if still using old format (has hasSubmenu entries or old child ids like builtin-translate-en)
    const hasOldSubmenuEntries = templates?.some((t: any) => t.hasSubmenu === true);
    const hasOldTranslateChildren = templates?.some((t: any) => t.id === 'builtin-translate-en');
    if (hasOldSubmenuEntries || hasOldTranslateChildren) {
      // Preserve user-created (non-builtin) templates
      const userTemplates = templates
        .filter((t: any) => !t.id.startsWith('builtin-'))
        .map((t: any) => ({ ...t, showInToolbar: t.showInToolbar ?? false, toolbarOrder: t.toolbarOrder ?? 0 }));
      this.settings.promptTemplates = [...DEFAULT_SETTINGS.promptTemplates, ...userTemplates];
      needsSave = true;
    }

    // Ensure promptLists and userVariables exist
    if (!this.settings.promptLists) {
      this.settings.promptLists = [...DEFAULT_SETTINGS.promptLists];
      needsSave = true;
    }
    if (!this.settings.userVariables) {
      this.settings.userVariables = [];
      needsSave = true;
    }

    if (needsSave) {
      await this.saveData(this.settings);
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ── Inline Completion ──


  private getInlineCompletionConfig(): InlineCompletionConfig {
    const s = this.settings;
    return {
      enabled: s.inlineCompletionEnabled,
      provider: s.inlineCompletionProvider,
      copilotCredentials: s.copilotCredentials ?? undefined,
      apiKey: s.inlineCompletionApiKey || undefined,
      apiBaseUrl: s.inlineCompletionApiBaseUrl || (s.inlineCompletionProvider === 'ollama' ? 'http://localhost:11434/v1' : undefined),
      model: s.inlineCompletionModel || 'gpt-4o-mini',
      triggerDelay: s.inlineCompletionDelay || 500,
      maxPrefixChars: 3000,
      maxSuffixChars: 1000,
      maxTokens: s.inlineCompletionMaxTokens || 128,
      temperature: s.inlineCompletionTemperature ?? 0.1,
      onCredentialsRefreshed: async (creds) => {
        this.settings.copilotCredentials = creds;
        await this.saveSettings();
      },
    };
  }

  private setupInlineCompletion() {
    if (!this.settings.inlineCompletionEnabled) return;



    this.inlineCompletionExtensions = createInlineCompletionExtensions(
      () => this.getInlineCompletionConfig(),
    );
    this.registerEditorExtension(this.inlineCompletionExtensions);
    logger.info('Plugin', 'Inline completion enabled', {
      provider: this.settings.inlineCompletionProvider,
    });
  }

  /** Called by settings when inline completion config changes */
  updateInlineCompletion() {
    // Extensions are registered once; the ViewPlugin reads config dynamically via getConfig()
    // So enabling/disabling is handled by the config.enabled flag
    if (this.settings.inlineCompletionEnabled && !this.inlineCompletionExtensions) {
      this.inlineCompletionExtensions = createInlineCompletionExtensions(
        () => this.getInlineCompletionConfig(),
      );
      this.registerEditorExtension(this.inlineCompletionExtensions);
    }
    logger.info('Plugin', 'Inline completion config updated', {
      enabled: this.settings.inlineCompletionEnabled,
      provider: this.settings.inlineCompletionProvider,
    });
  }
}
