/**
 * LinkSuggester — Real-time link suggestion while editing.
 *
 * Monitors the active editor for text that matches note titles or entities
 * in the knowledge index, and shows an inline popup to insert [[links]].
 */

import { App, MarkdownView, Notice, debounce, setIcon } from 'obsidian';
import type { KnowledgeEngine, NoteProfile } from './knowledge-engine';

interface Suggestion {
  notePath: string;
  displayName: string;
  matchText: string;
  matchStart: number; // ch offset in the line
  matchEnd: number;
  score: number;
}

export class LinkSuggester {
  private app: App;
  private engine: KnowledgeEngine;
  private popupEl: HTMLElement | null = null;
  private suggestions: Suggestion[] = [];
  private selectedIndex = 0;
  private currentLine = -1;
  private currentCh = -1;
  private enabled = true;
  private dismissedPaths = new Set<string>(); // dismissed for this editing session
  private lastCheckContent = '';
  private debouncedCheck: () => void;

  constructor(app: App, engine: KnowledgeEngine) {
    this.app = app;
    this.engine = engine;
    this.debouncedCheck = debounce(() => this.checkCurrentLine(), 800, true);
  }

  enable() { this.enabled = true; }
  disable() { this.enabled = false; this.hidePopup(); }

  /**
   * Should be called from plugin's 'editor-change' event.
   */
  onEditorChange() {
    if (!this.enabled) return;
    this.debouncedCheck();
  }

  /**
   * Keyboard handler — call from editorExtension or keydown listener.
   * Returns true if the event was consumed.
   */
  onKeyDown(e: KeyboardEvent): boolean {
    if (!this.popupEl) return false;

    if (e.key === 'Escape') {
      this.hidePopup();
      return true;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.selectedIndex = Math.min(this.selectedIndex + 1, this.suggestions.length - 1);
      this.updateSelection();
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
      this.updateSelection();
      return true;
    }
    if (e.key === 'Tab' || e.key === 'Enter') {
      if (this.suggestions.length > 0) {
        e.preventDefault();
        this.acceptSuggestion(this.selectedIndex);
        return true;
      }
    }
    return false;
  }

  destroy() {
    this.hidePopup();
  }

  // ── Internal ──

  private checkCurrentLine() {
    if (!this.enabled) return;

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) { this.hidePopup(); return; }

    const editor = view.editor;
    const cursor = editor.getCursor();
    const line = editor.getLine(cursor.line);
    const currentFile = view.file;
    if (!currentFile) { this.hidePopup(); return; }

    // Avoid re-checking same content
    const checkKey = `${currentFile.path}:${cursor.line}:${line}`;
    if (checkKey === this.lastCheckContent) return;
    this.lastCheckContent = checkKey;

    // Don't suggest inside existing [[links]] or code blocks
    const textBeforeCursor = line.slice(0, cursor.ch);
    if (this.isInsideLink(textBeforeCursor) || this.isInsideCode(textBeforeCursor)) {
      this.hidePopup();
      return;
    }

    // Find matching note titles in the current line text
    const suggestions = this.findSuggestions(line, currentFile.path);

    if (suggestions.length === 0) {
      this.hidePopup();
      return;
    }

    // Filter out already-linked notes and dismissed notes
    const filtered = suggestions.filter(s => {
      // Check if this text is already wrapped in [[]]
      const before = line.slice(Math.max(0, s.matchStart - 2), s.matchStart);
      const after = line.slice(s.matchEnd, s.matchEnd + 2);
      if (before === '[[' && after === ']]') return false;
      // Check if dismissed
      if (this.dismissedPaths.has(s.notePath)) return false;
      // Don't suggest linking to self
      if (s.notePath === currentFile.path) return false;
      return true;
    });

    if (filtered.length === 0) {
      this.hidePopup();
      return;
    }

    this.suggestions = filtered.slice(0, 5);
    this.selectedIndex = 0;
    this.currentLine = cursor.line;
    this.currentCh = cursor.ch;
    this.showPopup(view);
  }

  private findSuggestions(lineText: string, currentPath: string): Suggestion[] {
    const results: Suggestion[] = [];
    const lineLower = lineText.toLowerCase();
    const profiles = this.getAllProfiles();

    for (const profile of profiles) {
      if (profile.path === currentPath) continue;

      // Match by note title (basename without .md)
      const basename = profile.path.split('/').pop()?.replace(/\.md$/, '') || '';
      if (basename.length < 2) continue;

      const basenameLower = basename.toLowerCase();
      const idx = lineLower.indexOf(basenameLower);
      if (idx >= 0) {
        // Verify it's a word boundary match (not substring of a longer word)
        const charBefore = idx > 0 ? lineLower[idx - 1] : ' ';
        const charAfter = idx + basenameLower.length < lineLower.length
          ? lineLower[idx + basenameLower.length] : ' ';

        if (this.isWordBoundary(charBefore) && this.isWordBoundary(charAfter)) {
          results.push({
            notePath: profile.path,
            displayName: basename,
            matchText: lineText.slice(idx, idx + basename.length),
            matchStart: idx,
            matchEnd: idx + basename.length,
            score: 1.0,
          });
        }
      }
    }

    // Sort by score (higher first), then by match position
    results.sort((a, b) => b.score - a.score || a.matchStart - b.matchStart);
    return results;
  }

  private getAllProfiles(): NoteProfile[] {
    return this.engine.getAllProfiles();
  }

  private isWordBoundary(ch: string): boolean {
    return /[\s,.;:!?()[\]{}'"\/\-\u3000-\u303f\uff00-\uffef]/.test(ch) || ch === '';
  }

  private isInsideLink(text: string): boolean {
    const lastOpen = text.lastIndexOf('[[');
    const lastClose = text.lastIndexOf(']]');
    return lastOpen > lastClose;
  }

  private isInsideCode(text: string): boolean {
    const backtickCount = (text.match(/`/g) || []).length;
    return backtickCount % 2 === 1;
  }

  // ── Popup UI ──

  private showPopup(view: MarkdownView) {
    this.hidePopup();

    const editor = view.editor;
    // Get cursor position for popup placement
    const cursorCoords = (editor as any).cm?.coordsAtPos?.(
      editor.posToOffset(editor.getCursor())
    );

    this.popupEl = document.body.createDiv({ cls: 'ag-link-suggest-popup' });

    // Header
    const header = this.popupEl.createDiv({ cls: 'ag-link-suggest-header' });
    const headerIcon = header.createSpan();
    setIcon(headerIcon, 'link');
    const svg = headerIcon.querySelector('svg');
    if (svg) { svg.setAttribute('width', '12'); svg.setAttribute('height', '12'); }
    header.createSpan({ text: 'Link suggestions' });

    // Items
    const list = this.popupEl.createDiv({ cls: 'ag-link-suggest-list' });
    this.suggestions.forEach((sug, i) => {
      const item = list.createDiv({ cls: 'ag-link-suggest-item' });
      if (i === this.selectedIndex) item.addClass('ag-link-suggest-selected');
      item.setAttribute('data-index', String(i));

      const nameEl = item.createSpan({ cls: 'ag-link-suggest-name' });
      nameEl.textContent = sug.displayName;

      const folder = sug.notePath.split('/').slice(0, -1).join('/');
      if (folder) {
        item.createSpan({ cls: 'ag-link-suggest-folder', text: folder });
      }

      const actions = item.createDiv({ cls: 'ag-link-suggest-actions' });

      const insertBtn = actions.createSpan({ cls: 'ag-link-suggest-action ag-link-suggest-insert' });
      setIcon(insertBtn, 'link');
      const aSvg = insertBtn.querySelector('svg');
      if (aSvg) { aSvg.setAttribute('width', '11'); aSvg.setAttribute('height', '11'); }

      const dismissBtn = actions.createSpan({ cls: 'ag-link-suggest-action ag-link-suggest-dismiss' });
      setIcon(dismissBtn, 'x');
      const dSvg = dismissBtn.querySelector('svg');
      if (dSvg) { dSvg.setAttribute('width', '11'); dSvg.setAttribute('height', '11'); }

      item.addEventListener('click', () => this.acceptSuggestion(i));
      dismissBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.dismissSuggestion(i);
      });
    });

    // Keyboard hint
    const hint = this.popupEl.createDiv({ cls: 'ag-link-suggest-hint' });
    hint.textContent = 'Tab to insert · Esc to dismiss';

    // Position popup
    if (cursorCoords) {
      this.popupEl.style.left = `${cursorCoords.left}px`;
      this.popupEl.style.top = `${cursorCoords.bottom + 4}px`;
    } else {
      // Fallback: center in editor area
      const editorEl = view.containerEl.querySelector('.cm-editor');
      if (editorEl) {
        const rect = editorEl.getBoundingClientRect();
        this.popupEl.style.left = `${rect.left + 20}px`;
        this.popupEl.style.top = `${rect.top + 40}px`;
      }
    }
  }

  private updateSelection() {
    if (!this.popupEl) return;
    const items = this.popupEl.querySelectorAll('.ag-link-suggest-item');
    items.forEach((item, i) => {
      item.toggleClass('ag-link-suggest-selected', i === this.selectedIndex);
    });
  }

  private acceptSuggestion(index: number) {
    const sug = this.suggestions[index];
    if (!sug) return;

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;

    const editor = view.editor;

    // Replace the matched text with [[link]]
    const from = { line: this.currentLine, ch: sug.matchStart };
    const to = { line: this.currentLine, ch: sug.matchEnd };
    const linkText = `[[${sug.displayName}]]`;
    editor.replaceRange(linkText, from, to);

    new Notice(`Linked to [[${sug.displayName}]]`);
    this.hidePopup();
  }

  private dismissSuggestion(index: number) {
    const sug = this.suggestions[index];
    if (sug) {
      this.dismissedPaths.add(sug.notePath);
      this.suggestions.splice(index, 1);
      if (this.suggestions.length === 0) {
        this.hidePopup();
      } else {
        this.selectedIndex = Math.min(this.selectedIndex, this.suggestions.length - 1);
        // Re-render popup
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view) this.showPopup(view);
      }
    }
  }

  private hidePopup() {
    if (this.popupEl) {
      this.popupEl.remove();
      this.popupEl = null;
    }
    this.suggestions = [];
    this.lastCheckContent = '';
  }
}
