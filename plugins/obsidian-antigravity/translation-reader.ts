/**
 * Translation Reader — Inline Reading View translation with toolbar.
 *
 * Features:
 * - Absolute positioned overlay (no DOM interference)
 * - Follow mode: auto-translate when switching files
 * - Session-based cancellation: switching files cancels in-flight translation
 * - Toolbar: copy, export, retranslate, switch language, close
 */

import { App, MarkdownView, MarkdownRenderer, Component, Notice, setIcon } from 'obsidian';
import { TranslationEngine, type SupportedLang, LANG_LABELS, detectLanguage } from './translation-engine';
import { logger } from './logger';

const LOG_SRC = 'TranslationReader';
const OVERLAY_CLS = 'ag-translation-overlay';

export class TranslationReader extends Component {
  private active = false;
  private previousMode: string | null = null;
  private currentFilePath: string | null = null;
  private lastTranslatedContent: string | null = null;

  /** Incrementing session counter — ensures stale translations don't apply */
  private sessionId = 0;

  constructor(
    private app: App,
    private engine: TranslationEngine,
    private getTargetLang: () => SupportedLang,
    private setTargetLang: (lang: SupportedLang) => void,
    private onActiveStateChanged?: (active: boolean) => void,
  ) {
    super();
  }

  isActive(): boolean { return this.active; }

  async toggle(): Promise<void> {
    if (this.active) {
      this.deactivate();
    } else {
      await this.activate();
    }
  }

  async activate(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) {
      new Notice('No active markdown note');
      return;
    }

    this.active = true;
    this.currentFilePath = view.file.path;
    this.onActiveStateChanged?.(true);

    // Switch to Reading View if needed
    const mode = view.getMode();
    if (mode !== 'preview') {
      this.previousMode = mode;
      const state = view.getState();
      state.mode = 'preview';
      await view.setState(state, {} as any);
      await new Promise(r => setTimeout(r, 300));
    }

    await this.renderTranslation();
    logger.info(LOG_SRC, 'Translation reader activated', { path: this.currentFilePath });
  }

  deactivate(): void {
    this.active = false;
    this.sessionId++; // Cancel any in-flight translation
    this.lastTranslatedContent = null;
    this.onActiveStateChanged?.(false);
    this.clearOverlay();

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (this.previousMode && view) {
      const state = view.getState();
      state.mode = this.previousMode;
      view.setState(state, {} as any).then(() => this.clearOverlay());
      this.previousMode = null;
    }
    this.currentFilePath = null;
    logger.info(LOG_SRC, 'Translation reader deactivated');
  }

  async refresh(): Promise<void> {
    if (!this.active) return;
    this.sessionId++; // Cancel current
    this.clearOverlay();
    await this.renderTranslation();
  }

  /**
   * Follow mode: auto-translate when switching files.
   */
  async onActiveLeafChange(): Promise<void> {
    if (!this.active) return;

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) {
      this.clearOverlay();
      return;
    }

    if (view.file.path !== this.currentFilePath) {
      this.currentFilePath = view.file.path;
      this.sessionId++; // Cancel previous translation
      this.clearOverlay();

      const mode = view.getMode();
      if (mode !== 'preview') {
        const state = view.getState();
        state.mode = 'preview';
        await view.setState(state, {} as any);
        await new Promise(r => setTimeout(r, 200));
      }

      await this.renderTranslation();
    }
  }

  // ── Toolbar Actions ──

  private async copyToClipboard(): Promise<void> {
    if (this.lastTranslatedContent) {
      await navigator.clipboard.writeText(this.lastTranslatedContent);
      new Notice('Copied');
    }
  }

  private async exportAsFile(): Promise<void> {
    if (!this.lastTranslatedContent || !this.currentFilePath) return;
    const lang = this.getTargetLang();
    const baseName = this.currentFilePath.replace(/\.md$/, '');
    const newPath = `${baseName}.${lang}.md`;
    const existingFile = this.app.vault.getAbstractFileByPath(newPath);
    if (existingFile) {
      await this.app.vault.modify(existingFile as any, this.lastTranslatedContent);
      new Notice(`Updated: ${newPath}`);
    } else {
      await this.app.vault.create(newPath, this.lastTranslatedContent);
      new Notice(`Created: ${newPath}`);
    }
  }

  private async retranslate(): Promise<void> {
    if (!this.currentFilePath) return;
    await this.engine.clearCache(this.currentFilePath, this.getTargetLang());
    this.sessionId++;
    this.clearOverlay();
    await this.renderTranslation();
  }

  // ── Core Render ──

  private async renderTranslation(): Promise<void> {
    // Capture session at start — if it changes during async ops, stop
    const mySession = ++this.sessionId;

    try {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view || !view.file) return;

      const file = view.file;
      const targetLang = this.getTargetLang();
      const content = await this.app.vault.cachedRead(file);
      const sourceLang = detectLanguage(content);

      // Session check — abort if user navigated away
      if (mySession !== this.sessionId) return;

      let cached = await this.engine.getCachedTranslation(file.path, targetLang);

      if (!cached) {
        // Show loading state
        this.showLoadingOverlay(view, sourceLang, targetLang);

        const result = await this.engine.translateFile(
          file.path, content, targetLang,
          (done, total) => {
            if (mySession !== this.sessionId) return;
            this.updateLoadingProgress(done, total);
          },
        );

        if (mySession !== this.sessionId) return; // Cancelled

        if (!result) {
          new Notice('Translation failed — check Copilot login');
          this.clearOverlay();
          return;
        }
        cached = await this.engine.getCachedTranslation(file.path, targetLang);
      }

      if (!cached || mySession !== this.sessionId) return;

      // Auto-update stale blocks
      const summary = await this.engine.getStaleSummary(file.path, content, targetLang);
      if (mySession !== this.sessionId) return;

      if (summary.staleBlocks > 0) {
        this.showLoadingOverlay(view, sourceLang, targetLang, `Updating ${summary.staleBlocks} block(s)...`);
        await this.engine.translateFile(file.path, content, targetLang);
        if (mySession !== this.sessionId) return;
        cached = await this.engine.getCachedTranslation(file.path, targetLang);
        if (!cached) return;
      }

      this.lastTranslatedContent = cached.fullTranslation;

      // Find preview container
      const previewEl = (view as any).previewMode?.containerEl as HTMLElement | undefined;
      if (!previewEl) return;

      previewEl.style.position = 'relative';
      this.clearOverlay();
      if (mySession !== this.sessionId) return;

      // Create overlay
      const overlay = document.createElement('div');
      overlay.className = OVERLAY_CLS;
      previewEl.appendChild(overlay);

      // Toolbar
      overlay.appendChild(this.buildToolbar(sourceLang, targetLang));

      // Content
      const contentArea = document.createElement('div');
      contentArea.className = 'ag-translation-overlay-content';
      overlay.appendChild(contentArea);
      await MarkdownRenderer.render(this.app, cached.fullTranslation, contentArea, file.path, this);

    } catch (e) {
      if (mySession === this.sessionId) {
        logger.error(LOG_SRC, 'renderTranslation failed', { error: (e as Error).message });
        new Notice('Translation error: ' + (e as Error).message);
      }
    }
  }

  private showLoadingOverlay(view: MarkdownView, sourceLang: string, targetLang: SupportedLang, message?: string): void {
    const previewEl = (view as any).previewMode?.containerEl as HTMLElement | undefined;
    if (!previewEl) return;

    previewEl.style.position = 'relative';
    this.clearOverlay();

    const overlay = document.createElement('div');
    overlay.className = OVERLAY_CLS;
    previewEl.appendChild(overlay);

    overlay.appendChild(this.buildToolbar(sourceLang, targetLang));

    const loading = document.createElement('div');
    loading.className = 'ag-tr-loading';
    const spinner = document.createElement('div');
    spinner.className = 'ag-tr-loading-spinner';
    loading.appendChild(spinner);
    const text = document.createElement('div');
    text.className = 'ag-tr-loading-text';
    text.textContent = message || `Translating to ${LANG_LABELS[targetLang]}...`;
    loading.appendChild(text);
    const progress = document.createElement('div');
    progress.className = 'ag-tr-loading-progress';
    progress.id = 'ag-tr-progress';
    loading.appendChild(progress);
    overlay.appendChild(loading);
  }

  private updateLoadingProgress(done: number, total: number): void {
    const el = document.getElementById('ag-tr-progress');
    if (el) {
      el.textContent = `${done} / ${total} blocks`;
    }
  }

  private buildToolbar(sourceLang: string, targetLang: SupportedLang): HTMLElement {
    const toolbar = document.createElement('div');
    toolbar.className = 'ag-tr-toolbar';

    const srcLabel = LANG_LABELS[sourceLang as SupportedLang] || sourceLang;
    const tgtLabel = LANG_LABELS[targetLang];
    const langBadge = document.createElement('span');
    langBadge.className = 'ag-tr-toolbar-lang';
    const langIconEl = document.createElement('span');
    langIconEl.className = 'ag-tr-toolbar-lang-icon';
    setIcon(langIconEl, 'languages');
    langBadge.appendChild(langIconEl);
    langBadge.appendChild(document.createTextNode(` ${srcLabel} → ${tgtLabel}`));
    toolbar.appendChild(langBadge);

    toolbar.appendChild(this.el('span', 'ag-tr-toolbar-spacer'));

    // Buttons
    toolbar.appendChild(this.toolbarBtn('arrow-left-right', 'Switch language', () => {
      const next: SupportedLang = targetLang === 'en' ? 'zh' : 'en';
      this.setTargetLang(next);
      this.refresh();
    }));
    toolbar.appendChild(this.toolbarBtn('refresh-cw', 'Re-translate (clear cache)', () => this.retranslate()));
    toolbar.appendChild(this.toolbarBtn('copy', 'Copy translation', () => this.copyToClipboard()));
    toolbar.appendChild(this.toolbarBtn('file-output', `Export as .${targetLang}.md`, () => this.exportAsFile()));

    const closeBtn = this.toolbarBtn('x', 'Exit translation view', () => this.deactivate());
    closeBtn.classList.add('ag-tr-toolbar-close');
    toolbar.appendChild(closeBtn);

    return toolbar;
  }

  private toolbarBtn(icon: string, label: string, onClick: () => void): HTMLElement {
    const btn = document.createElement('button');
    btn.className = 'ag-tr-toolbar-btn';
    btn.setAttribute('aria-label', label);
    btn.title = label;
    setIcon(btn, icon);
    btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return btn;
  }

  private el(tag: string, cls: string): HTMLElement {
    const e = document.createElement(tag);
    e.className = cls;
    return e;
  }

  private clearOverlay(): void {
    document.querySelectorAll('.' + OVERLAY_CLS).forEach(el => el.remove());
    document.querySelectorAll('.markdown-preview-view').forEach(el => {
      (el as HTMLElement).style.position = '';
    });
  }

  onunload(): void {
    this.clearOverlay();
  }
}
