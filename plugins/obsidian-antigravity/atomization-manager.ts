/**
 * Atomization Manager — auto-trigger, suggestion persistence, and execution logic.
 * Extracted from main.ts for maintainability.
 */

import { App, Modal, Notice, TFile, setIcon } from 'obsidian';
import type { AntigravitySettings } from './settings';
import type { KnowledgeEngine } from './knowledge-engine';
import type { KnowledgeSteward } from './knowledge-steward';
import { RelatedNotesView, VIEW_TYPE_RELATED } from './related-notes-view';
import { analyzeSplit, executeSplit, analyzeUpgrade, type SplitPlan } from './atom-operations';
import { logger } from './logger';

/** Cached atom suggestions for a knowledge note */
export interface AtomSuggestions {
  splitPlan: SplitPlan | null;
  mergeCandidates: { pathA: string; pathB: string; overlapScore: number }[];
  upgradeAvailable: boolean;
  analysisTime: number;
  dismissed: boolean;
}

/** Persistent suggestion store (atom-suggestions.json) */
export interface SuggestionStoreData {
  version: number;
  suggestions: Record<string, { hash: string; suggestions: AtomSuggestions }>;
}

export class AtomizationManager {
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private settleTargetPath: string | null = null;
  readonly cache: Map<string, { hash: string; suggestions: AtomSuggestions }> = new Map();
  private persistDebounced: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private app: App,
    private getSettings: () => AntigravitySettings,
    private doSaveSettings: () => Promise<void>,
    private knowledgeEngine: KnowledgeEngine,
    private steward: KnowledgeSteward | null,
    private manifestId: string,
  ) {}

  /** Check if a file qualifies for automatic atomization analysis */
  isKnowledgeNote(file: TFile): boolean {
    const cache = this.app.metadataCache.getFileCache(file);
    return cache?.frontmatter?.type === 'knowledge';
  }

  /** Called on vault modify — start/reset settle timer for knowledge notes */
  onKnowledgeNoteModified(file: TFile) {
    const settings = this.getSettings();
    if (!settings.atomizationEnabled) return;
    if (!settings.copilotCredentials) return;
    if (!this.isKnowledgeNote(file)) return;

    // Reset settle timer
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTargetPath = file.path;

    const settleMs = (settings.atomizationSettleMinutes || 5) * 60 * 1000;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      logger.info('Plugin', 'Settle timer fired for knowledge note', { path: file.path });
      this.runAtomizationAnalysis(file.path);
    }, settleMs);

    logger.debug('Plugin', 'Settle timer (re)started for knowledge note', {
      path: file.path,
      settleMinutes: settings.atomizationSettleMinutes,
    });
  }

  /** Called on active-leaf-change — if user left a knowledge note, trigger immediately */
  onActiveLeafChangeForAtomization() {
    const settings = this.getSettings();
    if (!settings.atomizationEnabled) return;
    if (!settings.copilotCredentials) return;
    if (!this.settleTargetPath) return;

    // User navigated away from the note that had a pending settle timer
    const currentFile = this.app.workspace.getActiveFile();
    if (currentFile?.path === this.settleTargetPath) return; // still on the same note

    // Cancel the timer and trigger immediately
    const targetPath = this.settleTargetPath;
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    this.settleTargetPath = null;

    logger.info('Plugin', 'User left knowledge note, triggering immediate analysis', { path: targetPath });
    this.runAtomizationAnalysis(targetPath);
  }

  /** Run AI atomization analysis on a knowledge note (split + merge + upgrade) */
  async runAtomizationAnalysis(filePath: string) {
    const settings = this.getSettings();
    const profile = this.knowledgeEngine.getProfile(filePath);
    if (!profile) return;

    // Gate: only analyze knowledge notes with sufficient content
    if (profile.noteType !== 'knowledge') return;
    if (profile.wordCount < 800) {
      logger.debug('Plugin', 'Skipping atomization: too short', { path: filePath, words: profile.wordCount });
      return;
    }
    if (profile.topics.length < 3) {
      const metaCache = this.app.metadataCache.getFileCache(
        this.app.vault.getAbstractFileByPath(filePath) as TFile
      );
      const headings = metaCache?.headings?.filter(h => h.level <= 3) || [];
      if (headings.length < 3) {
        logger.debug('Plugin', 'Skipping atomization: too few headings/topics', {
          path: filePath, topics: profile.topics.length, headings: headings.length,
        });
        return;
      }
    }

    // Check if already analyzed with same content hash (and not dismissed)
    const cached = this.cache.get(filePath);
    if (cached && cached.hash === profile.contentHash && !cached.suggestions.dismissed) {
      logger.debug('Plugin', 'Atomization: cache hit, reusing suggestions', { path: filePath });
      this.emitAtomSuggestions(filePath, cached.suggestions);
      return;
    }

    logger.info('Plugin', 'Running atomization analysis (L1)', { path: filePath });

    // 1. Split analysis (AI)
    const splitPlan = await analyzeSplit(
      this.app, filePath,
      () => settings.copilotCredentials ?? null,
      (c) => { settings.copilotCredentials = c; this.doSaveSettings(); },
    );

    // 2. Merge candidates (L0 — steward overlap detection, no AI cost)
    const mergeCandidates: { pathA: string; pathB: string; overlapScore: number }[] = [];
    if (this.steward) {
      try {
        const report = await this.steward.analyze();
        for (const dup of report.duplications) {
          if ((dup.noteA === filePath || dup.noteB === filePath) && dup.overlapScore >= 0.7) {
            mergeCandidates.push({ pathA: dup.noteA, pathB: dup.noteB, overlapScore: dup.overlapScore });
          }
        }
      } catch (e) {
        logger.debug('Plugin', 'Merge detection skipped', { error: (e as Error).message });
      }
    }

    // 3. Upgrade check (AI — try top related note)
    let upgradeAvailable = false;
    try {
      const content = await this.app.vault.cachedRead(
        this.app.vault.getAbstractFileByPath(filePath) as TFile
      );
      const related = this.knowledgeEngine.queryByText(content, 1, new Set([filePath]));
      if (related.length > 0) {
        const suggestion = await analyzeUpgrade(
          this.app, filePath, related[0].path,
          () => settings.copilotCredentials ?? null,
          (c) => { settings.copilotCredentials = c; this.doSaveSettings(); },
        );
        upgradeAvailable = !!suggestion;
      }
    } catch (e) {
      logger.debug('Plugin', 'Upgrade detection skipped', { error: (e as Error).message });
    }

    const suggestions: AtomSuggestions = {
      splitPlan,
      mergeCandidates,
      upgradeAvailable,
      analysisTime: Date.now(),
      dismissed: false,
    };

    // Cache and persist
    this.cache.set(filePath, { hash: profile.contentHash, suggestions });
    this.persistSuggestions();

    this.emitAtomSuggestions(filePath, suggestions);

    const hasSuggestions = (splitPlan && splitPlan.atoms.length > 0) || mergeCandidates.length > 0 || upgradeAvailable;
    if (hasSuggestions) {
      logger.info('Plugin', 'Atomization suggestions generated', {
        path: filePath,
        split: splitPlan?.atoms.length ?? 0,
        merge: mergeCandidates.length,
        upgrade: upgradeAvailable,
      });
    }
  }

  /** Push suggestions to the Related Notes sidebar */
  emitAtomSuggestions(filePath: string, suggestions: AtomSuggestions) {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_RELATED);
    for (const leaf of leaves) {
      if (leaf.view instanceof RelatedNotesView) {
        (leaf.view as RelatedNotesView).onAtomSuggestions(filePath, suggestions);
      }
    }
  }

  /** Get cached atom suggestions for a path (called by RelatedNotesView) */
  getAtomSuggestions(filePath: string): AtomSuggestions | null {
    const cached = this.cache.get(filePath);
    return cached?.suggestions ?? null;
  }

  // ── Suggestion persistence ──

  private get suggestionsFilePath(): string {
    return `${this.app.vault.configDir}/plugins/${this.manifestId}/atom-suggestions.json`;
  }

  async loadSuggestions() {
    try {
      if (await this.app.vault.adapter.exists(this.suggestionsFilePath)) {
        const raw = await this.app.vault.adapter.read(this.suggestionsFilePath);
        const data: SuggestionStoreData = JSON.parse(raw);
        if (data.version === 1) {
          for (const [path, entry] of Object.entries(data.suggestions)) {
            this.cache.set(path, entry);
          }
          logger.info('Plugin', `Loaded ${Object.keys(data.suggestions).length} cached suggestions`);
        }
      }
    } catch (e) {
      logger.debug('Plugin', 'No saved suggestions found');
    }
  }

  persistSuggestions() {
    if (this.persistDebounced) clearTimeout(this.persistDebounced);
    this.persistDebounced = setTimeout(() => this.saveSuggestions(), 2000);
  }

  private async saveSuggestions() {
    const data: SuggestionStoreData = { version: 1, suggestions: {} };
    for (const [path, entry] of this.cache) {
      data.suggestions[path] = entry;
    }
    try {
      await this.app.vault.adapter.write(this.suggestionsFilePath, JSON.stringify(data));
    } catch (e) {
      logger.warn('Plugin', 'Failed to persist suggestions', { error: (e as Error).message });
    }
  }

  /** Dismiss suggestions for a note (persisted) */
  dismissSuggestions(filePath: string) {
    const cached = this.cache.get(filePath);
    if (cached) {
      cached.suggestions.dismissed = true;
      this.persistSuggestions();
    }
  }

  /** Execute atom split from the sidebar suggestion (reuse cached plan + confirm modal) */
  async executeAtomSplitFromSuggestion(filePath: string) {
    const cached = this.cache.get(filePath);
    if (!cached?.suggestions.splitPlan) {
      new Notice('No cached split plan found');
      return;
    }
    const plan = cached.suggestions.splitPlan;
    new SplitConfirmModal(this.app, filePath, plan, async (confirmed) => {
      if (!confirmed) {
        new Notice('Split cancelled');
        return;
      }
      new Notice(`Splitting into ${plan.atoms.length} atoms...`);
      const created = await executeSplit(this.app, filePath, plan);
      new Notice(`Created ${created.length} atom note(s)`);
      this.cache.delete(filePath);
      this.persistSuggestions();
      this.emitAtomSuggestions(filePath, {
        splitPlan: null, mergeCandidates: [], upgradeAvailable: false,
        analysisTime: Date.now(), dismissed: false,
      });
    }).open();
  }
}

// ── Split Confirmation Modal ──

export class SplitConfirmModal extends Modal {
  private sourceContent: string | null = null;

  constructor(
    app: App,
    private sourcePath: string,
    private plan: SplitPlan,
    private onResult: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('ag-split-modal');

    const sourceName = this.sourcePath.split('/').pop()?.replace(/\.md$/, '') || this.sourcePath;

    // Read source content for preview
    const sourceFile = this.app.vault.getAbstractFileByPath(this.sourcePath);
    let lines: string[] = [];
    if (sourceFile instanceof TFile) {
      this.sourceContent = await this.app.vault.read(sourceFile);
      lines = this.sourceContent.split('\n');
    }

    // Determine output folder
    const parentFolder = sourceFile instanceof TFile ? (sourceFile.parent?.path || '') : '';
    const targetFolder = parentFolder ? `${parentFolder}/${sourceName}` : sourceName;

    contentEl.createEl('h2', { text: 'Atom Split Preview' });

    const desc = contentEl.createEl('p');
    desc.innerHTML = `AI suggests splitting <strong>${sourceName}</strong> into <strong>${this.plan.atoms.length}</strong> atom notes.`;

    // Output folder info
    const folderInfo = contentEl.createEl('p');
    folderInfo.style.cssText = 'font-size: 12px; color: var(--text-muted);';
    folderInfo.innerHTML = `📂 Atoms will be created in: <code>${targetFolder}/</code>`;

    // Atom list with content preview
    const listEl = contentEl.createEl('div');
    listEl.style.cssText = 'margin: 12px 0; max-height: 400px; overflow-y: auto;';

    for (let i = 0; i < this.plan.atoms.length; i++) {
      const atom = this.plan.atoms[i];
      const item = listEl.createEl('div');
      item.style.cssText = 'padding: 8px 12px; margin: 4px 0; background: var(--background-secondary); border-radius: 6px; border-left: 3px solid var(--interactive-accent);';

      const titleRow = item.createEl('div');
      titleRow.style.cssText = 'font-weight: 600; font-size: 14px; margin-bottom: 4px; display: flex; align-items: center; justify-content: space-between;';
      titleRow.createSpan({ text: `${i + 1}. 🔹 ${atom.title}` });

      const metaRow = item.createEl('div');
      metaRow.style.cssText = 'font-size: 12px; color: var(--text-muted);';
      const lineCount = atom.endLine - atom.startLine + 1;
      metaRow.textContent = `Lines ${atom.startLine}–${atom.endLine} (${lineCount} lines)`;

      if (atom.tags.length > 0) {
        const tagsRow = item.createEl('div');
        tagsRow.style.cssText = 'font-size: 11px; color: var(--text-muted); margin-top: 2px;';
        tagsRow.textContent = atom.tags.map(t => `#${t}`).join('  ');
      }

      // Content preview (collapsible)
      if (lines.length > 0) {
        const previewToggle = item.createEl('div');
        previewToggle.style.cssText = 'font-size: 11px; color: var(--interactive-accent); cursor: pointer; margin-top: 4px; user-select: none;';
        previewToggle.textContent = '▶ Show content preview';

        const previewEl = item.createEl('pre');
        previewEl.style.cssText = 'display: none; font-size: 11px; line-height: 1.4; max-height: 200px; overflow-y: auto; background: var(--background-primary); padding: 8px; border-radius: 4px; margin-top: 4px; white-space: pre-wrap; word-break: break-word;';
        const previewLines = lines.slice(atom.startLine - 1, atom.endLine);
        previewEl.textContent = previewLines.join('\n');

        let expanded = false;
        previewToggle.addEventListener('click', () => {
          expanded = !expanded;
          previewEl.style.display = expanded ? 'block' : 'none';
          previewToggle.textContent = expanded ? '▼ Hide content preview' : '▶ Show content preview';
        });
      }
    }

    if (this.plan.makeComposite) {
      const compositeNote = contentEl.createEl('p');
      compositeNote.style.cssText = 'font-size: 13px; color: var(--text-muted); margin-top: 8px;';
      compositeNote.innerHTML = `📄 Original note will become a <strong>composite</strong> — its content will be replaced with <code>![[embed]]</code> references to each atom.`;
    }

    // Rollback hint
    const rollbackHint = contentEl.createEl('p');
    rollbackHint.style.cssText = 'font-size: 11px; color: var(--text-muted); margin-top: 4px;';
    rollbackHint.textContent = '💡 If you need to undo, use "Antigravity: Undo Last Split" from the command palette.';

    // Buttons
    const btnRow = contentEl.createEl('div');
    btnRow.style.cssText = 'display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px;';

    const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => {
      this.onResult(false);
      this.close();
    });

    const confirmBtn = btnRow.createEl('button', { text: `Split into ${this.plan.atoms.length} atoms`, cls: 'mod-cta' });
    confirmBtn.addEventListener('click', () => {
      this.onResult(true);
      this.close();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
