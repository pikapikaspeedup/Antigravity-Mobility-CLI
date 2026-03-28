/**
 * Translation View — Sidebar panel for viewing translated content.
 *
 * Shows the current active note translated into the target language.
 * Supports:
 * - One-click language switching
 * - Incremental translation status (fresh / stale blocks)
 * - Copy translated content
 * - Seamless Reading View integration via MarkdownPostProcessor
 */

import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice, setIcon, TFile } from 'obsidian';
import {
  TranslationEngine,
  type SupportedLang,
  type TranslationEntry,
  LANG_LABELS,
  detectLanguage,
} from './translation-engine';
import { logger } from './logger';

export const VIEW_TYPE_TRANSLATION = 'antigravity-translation';

const LOG_SRC = 'TranslationView';

export class TranslationView extends ItemView {
  private engine: TranslationEngine;
  private rootEl: HTMLElement | null = null;
  private contentEl_: HTMLElement | null = null;
  private headerEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private currentPath: string | null = null;
  private currentLang: SupportedLang = 'en';
  private isTranslating = false;
  private lastRenderedHash = '';

  // Callbacks wired from main.ts
  onTargetLangChanged?: (lang: SupportedLang) => void;

  constructor(leaf: WorkspaceLeaf, engine: TranslationEngine, initialLang: SupportedLang) {
    super(leaf);
    this.engine = engine;
    this.currentLang = initialLang;
  }

  getViewType() { return VIEW_TYPE_TRANSLATION; }
  getDisplayText() { return `Translation (${LANG_LABELS[this.currentLang]})`; }
  getIcon() { return 'languages'; }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('ag-translation-root');

    // Header
    this.headerEl = container.createDiv({ cls: 'ag-translation-header' });
    this.buildHeader();

    // Status bar
    this.statusEl = container.createDiv({ cls: 'ag-translation-status' });

    // Content area
    this.rootEl = container.createDiv({ cls: 'ag-translation-content markdown-rendered' });
    this.contentEl_ = this.rootEl;

    this.renderEmpty();

    // Listen to active file changes
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        this.onActiveFileChange();
      }),
    );
    this.registerEvent(
      this.app.workspace.on('file-open', () => {
        this.onActiveFileChange();
      }),
    );

    // Initial render
    this.onActiveFileChange();
  }

  async onClose() {
    this.rootEl = null;
    this.contentEl_ = null;
    this.headerEl = null;
    this.statusEl = null;
  }

  setTargetLang(lang: SupportedLang) {
    this.currentLang = lang;
    this.buildHeader();
    (this.leaf as any).updateHeader?.();
    this.onActiveFileChange();
  }

  // ── Header ──

  private buildHeader() {
    if (!this.headerEl) return;
    this.headerEl.empty();

    const row = this.headerEl.createDiv({ cls: 'ag-translation-header-row' });

    // Language selector
    const langSelect = row.createEl('select', { cls: 'ag-translation-lang-select dropdown' });
    for (const [code, label] of Object.entries(LANG_LABELS)) {
      const opt = langSelect.createEl('option', { value: code, text: label });
      if (code === this.currentLang) opt.selected = true;
    }
    langSelect.addEventListener('change', () => {
      const newLang = langSelect.value as SupportedLang;
      this.currentLang = newLang;
      (this.leaf as any).updateHeader?.();
      this.onTargetLangChanged?.(newLang);
      this.onActiveFileChange();
    });

    // Translate button
    const translateBtn = row.createEl('button', { cls: 'ag-translation-btn clickable-icon', attr: { 'aria-label': 'Translate / Refresh' } });
    setIcon(translateBtn, 'refresh-cw');
    translateBtn.addEventListener('click', () => this.translateCurrentFile());

    // Copy button
    const copyBtn = row.createEl('button', { cls: 'ag-translation-btn clickable-icon', attr: { 'aria-label': 'Copy translation' } });
    setIcon(copyBtn, 'copy');
    copyBtn.addEventListener('click', () => this.copyTranslation());
  }

  // ── Active File Tracking ──

  private async onActiveFileChange() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') {
      this.currentPath = null;
      this.renderEmpty();
      return;
    }

    if (file.path === this.currentPath && !this.engine.isTranslating(file.path)) {
      // Same file — check if content changed
      const content = await this.app.vault.cachedRead(file);
      const fresh = await this.engine.isCacheFresh(file.path, this.currentLang, content);
      if (fresh) return; // still fresh, no re-render needed
    }

    this.currentPath = file.path;
    await this.showCachedOrPrompt(file);
  }

  private async showCachedOrPrompt(file: TFile) {
    const content = await this.app.vault.cachedRead(file);
    const sourceLang = detectLanguage(content);

    // If source language matches target, show a hint
    if (sourceLang === this.currentLang) {
      this.renderSourceLangMatch(file.basename, sourceLang);
      return;
    }

    // Try to load cached translation
    const cached = await this.engine.getCachedTranslation(file.path, this.currentLang);
    if (cached) {
      const summary = await this.engine.getStaleSummary(file.path, content, this.currentLang);
      this.renderTranslation(cached, summary.staleBlocks);
    } else {
      this.renderUntranslated(file.basename);
    }
  }

  // ── Translation Action ──

  private async translateCurrentFile() {
    if (this.isTranslating) return;
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') {
      new Notice('No active markdown file');
      return;
    }

    this.isTranslating = true;
    this.renderTranslating(file.basename);
    const content = await this.app.vault.cachedRead(file);

    try {
      const result = await this.engine.translateFile(
        file.path, content, this.currentLang,
        (done, total) => this.updateStatus(`Translating blocks: ${done}/${total}`),
      );
      if (result !== null) {
        const cached = await this.engine.getCachedTranslation(file.path, this.currentLang);
        if (cached) this.renderTranslation(cached, 0);
        new Notice(`Translation complete → ${LANG_LABELS[this.currentLang]}`);
      } else {
        new Notice('Translation failed or already in progress');
        this.renderUntranslated(file.basename);
      }
    } catch (e) {
      logger.error(LOG_SRC, 'Translation error', { error: (e as Error).message });
      new Notice('Translation failed: ' + (e as Error).message);
      this.renderUntranslated(file.basename);
    } finally {
      this.isTranslating = false;
    }
  }

  private async copyTranslation() {
    if (!this.currentPath) return;
    const cached = await this.engine.getCachedTranslation(this.currentPath, this.currentLang);
    if (cached?.fullTranslation) {
      await navigator.clipboard.writeText(cached.fullTranslation);
      new Notice('Translation copied to clipboard');
    } else {
      new Notice('No translation available to copy');
    }
  }

  // ── Rendering ──

  private renderEmpty() {
    if (!this.rootEl) return;
    this.rootEl.empty();
    this.updateStatus('');
    const empty = this.rootEl.createDiv({ cls: 'ag-translation-empty' });
    empty.createEl('p', { text: 'Open a markdown note to see its translation.' });
  }

  private renderSourceLangMatch(filename: string, lang: SupportedLang) {
    if (!this.rootEl) return;
    this.rootEl.empty();
    this.updateStatus('');
    const info = this.rootEl.createDiv({ cls: 'ag-translation-empty' });
    info.createEl('p', { text: `"${filename}" appears to already be in ${LANG_LABELS[lang]}.` });
    info.createEl('p', { cls: 'ag-translation-hint', text: 'Select a different target language or click Translate to force translation.' });

    const forceBtn = info.createEl('button', { cls: 'mod-cta', text: 'Translate anyway' });
    forceBtn.addEventListener('click', () => this.translateCurrentFile());
  }

  private renderUntranslated(filename: string) {
    if (!this.rootEl) return;
    this.rootEl.empty();
    this.updateStatus('No translation cached');
    const wrapper = this.rootEl.createDiv({ cls: 'ag-translation-empty' });
    wrapper.createEl('p', { text: `"${filename}" has not been translated to ${LANG_LABELS[this.currentLang]} yet.` });

    const btn = wrapper.createEl('button', { cls: 'mod-cta', text: `Translate to ${LANG_LABELS[this.currentLang]}` });
    btn.addEventListener('click', () => this.translateCurrentFile());
  }

  private renderTranslating(filename: string) {
    if (!this.rootEl) return;
    this.rootEl.empty();
    this.updateStatus('Translating...');
    const wrapper = this.rootEl.createDiv({ cls: 'ag-translation-loading' });
    const spinner = wrapper.createDiv({ cls: 'ag-translation-spinner' });
    wrapper.createEl('p', { text: `Translating "${filename}" to ${LANG_LABELS[this.currentLang]}...` });
  }

  private async renderTranslation(entry: TranslationEntry, staleBlocks: number) {
    if (!this.rootEl) return;

    // Avoid re-render if content hasn't changed
    const renderHash = entry.sourceContentHash + entry.targetLang + staleBlocks;
    if (renderHash === this.lastRenderedHash) return;
    this.lastRenderedHash = renderHash;

    this.rootEl.empty();

    // Status
    if (staleBlocks > 0) {
      this.updateStatus(`${staleBlocks} block(s) may be outdated — click Refresh to update`);
    } else {
      const timeStr = new Date(entry.lastTranslated).toLocaleString();
      this.updateStatus(`Last translated: ${timeStr}`);
    }

    // Render markdown
    await MarkdownRenderer.render(
      this.app,
      entry.fullTranslation,
      this.rootEl,
      entry.sourcePath,
      this,
    );
  }

  private updateStatus(text: string) {
    if (!this.statusEl) return;
    this.statusEl.textContent = text;
  }
}
