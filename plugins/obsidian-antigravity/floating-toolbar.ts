/**
 * Floating Toolbar & Inline Result Panel — extracted from main.ts
 *
 * Handles text selection → floating toolbar → prompt resolution → inline AI result.
 */

import { App, Plugin, Modal, Notice, MarkdownRenderer, setIcon } from 'obsidian';
import { ChatView, VIEW_TYPE_CHAT } from './chat-view';
import { type AntigravitySettings, type PinItem, type PromptTemplate, type PromptList, type PromptListItem } from './settings';
import { showPromptManager } from './prompt-manager-ui';

export class FloatingToolbarManager {
  private floatingToolbar: HTMLElement | null = null;
  private floatingToolbarTimer: ReturnType<typeof setTimeout> | null = null;
  private inlineResultEl: HTMLElement | null = null;

  constructor(
    private app: App,
    private plugin: Plugin,
    private getSettings: () => AntigravitySettings,
    private doSaveSettings: () => Promise<void>,
    private doActivateView: () => Promise<void>,
    private getEditorSelection: () => string,
  ) {}

  setup() {
    this.plugin.registerDomEvent(document, 'mouseup', () => {
      if (this.floatingToolbarTimer) clearTimeout(this.floatingToolbarTimer);
      this.floatingToolbarTimer = setTimeout(() => this.checkAndShow(), 200);
    });

    this.plugin.registerDomEvent(document, 'keyup', (e: KeyboardEvent) => {
      if (e.shiftKey || e.key === 'a' && (e.ctrlKey || e.metaKey)) {
        if (this.floatingToolbarTimer) clearTimeout(this.floatingToolbarTimer);
        this.floatingToolbarTimer = setTimeout(() => this.checkAndShow(), 300);
      }
    });

    this.plugin.registerDomEvent(document, 'mousedown', (e: MouseEvent) => {
      if (this.floatingToolbar && !this.floatingToolbar.contains(e.target as Node)) {
        this.remove();
      }
    });
  }

  private checkAndShow() {
    if (this.floatingToolbar) return;

    const sel = this.getEditorSelection();
    if (!sel || sel.length < 2) {
      this.remove();
      return;
    }

    const winSel = window.getSelection();
    if (!winSel || winSel.rangeCount === 0) return;

    const range = winSel.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const el = container instanceof Element ? container : container.parentElement;
    if (!el) return;

    const isDocArea = el.closest('.markdown-preview-view') ||
      el.closest('.cm-editor') ||
      el.closest('.markdown-reading-view') ||
      el.closest('.markdown-rendered');

    const isOurUI = el.closest('.antigravity-chat-root') || el.closest('.modal-container') || el.closest('.setting-tab');
    if (!isDocArea || isOurUI) {
      this.remove();
      return;
    }

    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;

    this.show(sel, rect);
  }

  /** Resolve template variables in a prompt string (sync — auto variables only) */
  private resolveAutoVariables(prompt: string, selection: string): string {
    const settings = this.getSettings();
    const activeFile = this.app.workspace.getActiveFile();
    const vaultBase = (this.app.vault.adapter as any).basePath as string;
    const now = new Date();

    let result = prompt
      .replace(/\{\{selection\}\}/g, selection)
      .replace(/\{\{filename\}\}/g, activeFile?.basename || '')
      .replace(/\{\{filepath\}\}/g, activeFile?.path || '')
      .replace(/\{\{date\}\}/g, now.toISOString().split('T')[0])
      .replace(/\{\{time\}\}/g, now.toTimeString().split(' ')[0]);

    if (result.includes('{{fulltext}}') && activeFile) {
      result = result.replace(/\{\{fulltext\}\}/g, `[Full content of ${activeFile.basename} — use @[${vaultBase}/${activeFile.path}] to include]`);
    }

    if (result.includes('{{frontmatter}}') && activeFile) {
      const cache = this.app.metadataCache.getFileCache(activeFile);
      const fm = cache?.frontmatter;
      result = result.replace(/\{\{frontmatter\}\}/g, fm ? JSON.stringify(fm, null, 2) : '(no frontmatter)');
    }

    if (result.includes('{{pins}}')) {
      const pins = settings.pins || [];
      if (pins.length > 0) {
        const pinText = pins.map(p => {
          const lineInfo = p.startLine > 0 ? ` (L${p.startLine}-${p.endLine})` : '';
          return `[${p.fileName}${lineInfo}]\n${p.text}`;
        }).join('\n\n');
        result = result.replace(/\{\{pins\}\}/g, pinText);
      } else {
        result = result.replace(/\{\{pins\}\}/g, '(no pinned content)');
      }
    }

    const userVars = settings.userVariables || [];
    result = result.replace(/\{\{var:([^}]+)\}\}/g, (_match, varName: string) => {
      const uv = userVars.find(v => v.name === varName.trim());
      return uv ? uv.value : `{{var:${varName}}}`;
    });

    if (!prompt.includes('{{selection}}') && selection) {
      result += selection;
    }

    return result;
  }

  /** Resolve all variables (async — handles interactive variables with UI) */
  async resolvePromptVariables(prompt: string, selection: string): Promise<string | null> {
    let result = prompt;

    const inputMatches = [...result.matchAll(/\{\{input:([^}]+)\}\}/g)];
    for (const match of inputMatches) {
      const description = match[1].trim();
      const userInput = await this.showInputDialog(description);
      if (userInput === null) return null;
      result = result.replace(match[0], userInput);
    }

    const selectMatches = [...result.matchAll(/\{\{select:([^}]+)\}\}/g)];
    for (const match of selectMatches) {
      const listName = match[1].trim();
      const list = this.findPromptList(listName);
      if (!list) {
        new Notice(`List "${listName}" not found`);
        return null;
      }
      const selected = await this.showListSelectDialog(list, 'single', listName);
      if (selected === null) return null;
      result = result.replace(match[0], selected[0].value);
    }

    const multiMatches = [...result.matchAll(/\{\{multiselect:([^:}]+):(\d+)\}\}/g)];
    for (const match of multiMatches) {
      const listName = match[1].trim();
      const count = parseInt(match[2], 10);
      const list = this.findPromptList(listName);
      if (!list) {
        new Notice(`List "${listName}" not found`);
        return null;
      }
      const selected = await this.showListSelectDialog(list, 'multi', listName, count);
      if (selected === null) return null;
      result = result.replace(match[0], selected.map(s => s.value).join(', '));
    }

    const randomMatches = [...result.matchAll(/\{\{random:([^:}]+):(\d+)\}\}/g)];
    for (const match of randomMatches) {
      const listName = match[1].trim();
      const count = parseInt(match[2], 10);
      const list = this.findPromptList(listName);
      if (!list) {
        new Notice(`List "${listName}" not found`);
        return null;
      }
      const shuffled = [...list.items].sort(() => Math.random() - 0.5);
      const picked = shuffled.slice(0, Math.min(count, shuffled.length));
      result = result.replace(match[0], picked.map(s => s.value).join(', '));
    }

    result = this.resolveAutoVariables(result, selection);
    return result;
  }

  private findPromptList(name: string): PromptList | undefined {
    const lists = this.getSettings().promptLists || [];
    return lists.find(l => l.name === name);
  }

  /** Show input dialog and return user input (null if cancelled) */
  private showInputDialog(description: string): Promise<string | null> {
    return new Promise((resolve) => {
      const modal = new Modal(this.app);
      modal.titleEl.setText('Input Required');
      modal.modalEl.addClass('ag-input-dialog');
      const root = modal.contentEl;
      root.empty();
      root.style.cssText = 'padding: 16px;';

      const label = root.createDiv({ text: description });
      label.style.cssText = 'font-size: 14px; margin-bottom: 12px; color: var(--text-normal);';

      const input = root.createEl('input', { attr: { type: 'text', placeholder: description } });
      input.style.cssText = 'width: 100%; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--background-modifier-border); background: var(--background-primary); font-size: 14px; box-sizing: border-box;';

      const btnRow = root.createDiv();
      btnRow.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px;';

      const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
      cancelBtn.style.cssText = 'padding: 6px 16px; border-radius: 6px;';
      cancelBtn.addEventListener('click', () => { modal.close(); resolve(null); });

      const okBtn = btnRow.createEl('button', { text: 'OK', cls: 'mod-cta' });
      okBtn.style.cssText = 'padding: 6px 16px; border-radius: 6px;';
      okBtn.addEventListener('click', () => {
        const val = input.value.trim();
        if (!val) { new Notice('Please enter a value'); return; }
        modal.close();
        resolve(val);
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { okBtn.click(); }
        if (e.key === 'Escape') { modal.close(); resolve(null); }
      });

      modal.open();
      setTimeout(() => input.focus(), 50);
    });
  }

  /** Show list selection dialog (null if cancelled) */
  private showListSelectDialog(
    list: PromptList,
    mode: 'single' | 'multi',
    displayName: string,
    maxSelect?: number,
  ): Promise<PromptListItem[] | null> {
    return new Promise((resolve) => {
      const modal = new Modal(this.app);
      modal.titleEl.setText('');
      modal.modalEl.addClass('ag-list-select-dialog');
      const root = modal.contentEl;
      root.empty();
      root.style.cssText = 'padding: 16px; max-height: 60vh; overflow-y: auto;';

      const titleEl = root.createDiv();
      titleEl.style.cssText = 'font-weight: 600; font-size: 16px; margin-bottom: 12px;';
      titleEl.textContent = mode === 'single' ? `Select: ${displayName}` : `Select ${maxSelect || 'items'}: ${displayName}`;

      const selected = new Set<number>();

      const itemsContainer = root.createDiv();
      itemsContainer.style.cssText = 'display: flex; flex-direction: column; gap: 2px;';

      for (let i = 0; i < list.items.length; i++) {
        const item = list.items[i];
        const row = itemsContainer.createDiv();
        row.style.cssText = 'padding: 8px 12px; border-radius: 8px; cursor: pointer; display: flex; align-items: center; gap: 8px; font-size: 14px; transition: background 0.1s ease;';
        row.addEventListener('mouseenter', () => { if (!selected.has(i)) row.style.background = 'var(--background-modifier-hover)'; });
        row.addEventListener('mouseleave', () => { if (!selected.has(i)) row.style.background = ''; });

        if (mode === 'single') {
          row.createSpan({ text: item.label });
          row.addEventListener('click', () => {
            modal.close();
            resolve([item]);
          });
        } else {
          const checkbox = row.createEl('input', { attr: { type: 'checkbox' } }) as HTMLInputElement;
          checkbox.style.cssText = 'cursor: pointer; flex-shrink: 0;';
          row.createSpan({ text: item.label });
          const toggleItem = () => {
            if (selected.has(i)) {
              selected.delete(i);
              checkbox.checked = false;
              row.style.background = '';
            } else {
              if (maxSelect && selected.size >= maxSelect) {
                new Notice(`Maximum ${maxSelect} selections`);
                return;
              }
              selected.add(i);
              checkbox.checked = true;
              row.style.background = 'var(--interactive-accent-hover)';
            }
          };
          row.addEventListener('click', (e) => { if (e.target !== checkbox) toggleItem(); });
          checkbox.addEventListener('change', toggleItem);
        }
      }

      if (mode === 'multi') {
        const btnRow = root.createDiv();
        btnRow.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px;';

        const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
        cancelBtn.style.cssText = 'padding: 6px 16px; border-radius: 6px;';
        cancelBtn.addEventListener('click', () => { modal.close(); resolve(null); });

        const okBtn = btnRow.createEl('button', { text: 'OK', cls: 'mod-cta' });
        okBtn.style.cssText = 'padding: 6px 16px; border-radius: 6px;';
        okBtn.addEventListener('click', () => {
          if (selected.size === 0) { new Notice('Please select at least one item'); return; }
          const items = [...selected].map(i => list.items[i]);
          modal.close();
          resolve(items);
        });
      } else {
        const btnRow = root.createDiv();
        btnRow.style.cssText = 'display: flex; justify-content: flex-end; margin-top: 12px;';
        const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
        cancelBtn.style.cssText = 'padding: 6px 16px; border-radius: 6px;';
        cancelBtn.addEventListener('click', () => { modal.close(); resolve(null); });
      }

      modal.open();
    });
  }

  private show(selection: string, rect: DOMRect) {
    this.remove();

    const toolbar = document.body.createDiv({ cls: 'ag-floating-toolbar' });
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Quick Actions');
    this.floatingToolbar = toolbar;

    // Prevent mousedown on toolbar from clearing editor selection
    toolbar.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    // Position above selection, flip below if near top edge
    const toolbarHeight = 44;
    const toolbarWidth = 340;
    let left = rect.left + rect.width / 2 - toolbarWidth / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - toolbarWidth - 8));
    toolbar.style.left = `${left}px`;

    if (rect.top - toolbarHeight - 8 < 0) {
      toolbar.style.top = `${rect.bottom + 8}px`;
    } else {
      toolbar.style.top = `${rect.top - toolbarHeight - 8}px`;
    }

    const actionsRow = toolbar.createDiv({ cls: 'ag-ft-actions' });

    // ── Helper: fire a prompt template (async with variable resolution) ──
    const fireAction = async (prompt: string) => {
      const selectionRect = rect;
      this.remove();

      const resolved = await this.resolvePromptVariables(prompt, selection);
      if (resolved === null) return;

      const settings = this.getSettings();
      if (settings.quickActionProvider === 'copilot' && settings.copilotCredentials) {
        await this.showInlineResult(resolved, selection, selectionRect);
      } else {
        await this.doActivateView();
        const chatLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
        if (chatLeaf?.view instanceof ChatView) {
          const activeFile = this.app.workspace.getActiveFile();
          const vaultBase = (this.app.vault.adapter as any).basePath as string;
          let prefix = '';
          if (activeFile) prefix = `@[${vaultBase}/${activeFile.path}] `;
          (chatLeaf.view as ChatView).quickSend(prefix + resolved);
        }
      }
    };

    // ── Build toolbar buttons from prompt templates ──
    const settings = this.getSettings();
    const templates = settings.promptTemplates || [];
    const toolbarItems = templates
      .filter(t => t.showInToolbar && t.prompt)
      .sort((a, b) => (a.toolbarOrder || 0) - (b.toolbarOrder || 0));

    for (const item of toolbarItems) {
      const selectMatch = item.prompt.match(/\{\{select:([^}]+)\}\}/);
      const hasOtherInteractive = /\{\{(input|multiselect|random):/.test(item.prompt);

      if (selectMatch && !hasOtherInteractive) {
        const btnWrap = actionsRow.createDiv({ cls: 'ag-ft-more-wrap' });
        const btn = btnWrap.createEl('button', { cls: 'ag-ft-btn', title: item.name });
        btn.setAttribute('aria-label', item.name);
        setIcon(btn, item.icon);
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const existing = btnWrap.querySelector('.ag-ft-dropdown');
          if (existing) { existing.remove(); return; }
          toolbar.querySelectorAll('.ag-ft-dropdown').forEach(d => d.remove());
          this.showSelectDropdown(btnWrap, item.prompt, selectMatch[1], selection, toolbar, rect);
        });
      } else {
        const btn = actionsRow.createEl('button', { cls: 'ag-ft-btn', title: item.name });
        btn.setAttribute('aria-label', item.name);
        setIcon(btn, item.icon);
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          fireAction(item.prompt);
        });
      }
    }

    // Separator
    actionsRow.createSpan({ cls: 'ag-ft-sep' });

    // PIN button
    const pinBtn = actionsRow.createEl('button', { cls: 'ag-ft-btn ag-ft-pin', title: 'Pin Selection' });
    pinBtn.setAttribute('aria-label', 'Pin Selection');
    setIcon(pinBtn, 'pin');
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.pinSelection(selection);
      this.remove();
    });

    // Chat button (send to input)
    const chatBtn = actionsRow.createEl('button', { cls: 'ag-ft-btn ag-ft-chat', title: 'Ask in Chat' });
    chatBtn.setAttribute('aria-label', 'Ask in Chat');
    setIcon(chatBtn, 'message-circle');
    chatBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      this.remove();
      await this.doActivateView();
      const chatLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
      if (chatLeaf?.view instanceof ChatView) {
        const activeFile = this.app.workspace.getActiveFile();
        const vaultBase = (this.app.vault.adapter as any).basePath as string;
        let prefix = '';
        if (activeFile) prefix = `@[${vaultBase}/${activeFile.path}] `;
        (chatLeaf.view as ChatView).setInputText(prefix + selection);
      }
    });

    // More actions → dropdown menu with all prompts
    const moreBtnWrap = actionsRow.createDiv({ cls: 'ag-ft-more-wrap' });
    const moreBtn = moreBtnWrap.createEl('button', { cls: 'ag-ft-btn', title: 'More actions' });
    moreBtn.setAttribute('aria-label', 'More actions');
    setIcon(moreBtn, 'chevron-down');
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const existing = moreBtnWrap.querySelector('.ag-ft-dropdown');
      if (existing) { existing.remove(); return; }
      this.showToolbarDropdown(moreBtnWrap, selection, toolbar, rect);
    });

    // Animate in
    requestAnimationFrame(() => toolbar.addClass('ag-ft-visible'));
  }

  /** Show inline dropdown for a prompt's {{select:listName}} variable */
  private showSelectDropdown(anchor: HTMLElement, promptTemplate: string, listName: string, selection: string, toolbar: HTMLElement, selectionRect: DOMRect) {
    const list = this.findPromptList(listName.trim());
    if (!list) {
      new Notice(`List "${listName}" not found`);
      return;
    }

    const dropdown = anchor.createDiv({ cls: 'ag-ft-dropdown' });
    dropdown.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });

    const titleEl = dropdown.createDiv({ cls: 'ag-ft-dd-cat' });
    titleEl.textContent = listName;

    for (const item of list.items) {
      const row = dropdown.createDiv({ cls: 'ag-ft-dd-item' });
      row.createSpan({ text: item.label, cls: 'ag-ft-dd-label' });
      row.addEventListener('click', async (e) => {
        e.stopPropagation();
        this.remove();

        const resolvedPrompt = promptTemplate.replace(`{{select:${listName}}}`, item.value);
        const resolved = await this.resolvePromptVariables(resolvedPrompt, selection);
        if (resolved === null) return;

        const settings = this.getSettings();
        if (settings.quickActionProvider === 'copilot' && settings.copilotCredentials) {
          await this.showInlineResult(resolved, selection, selectionRect);
        } else {
          await this.doActivateView();
          const chatLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
          if (chatLeaf?.view instanceof ChatView) {
            const activeFile = this.app.workspace.getActiveFile();
            const vaultBase = (this.app.vault.adapter as any).basePath as string;
            let prefix = '';
            if (activeFile) prefix = `@[${vaultBase}/${activeFile.path}] `;
            (chatLeaf.view as ChatView).quickSend(prefix + resolved);
          }
        }
      });
    }

    const closeHandler = (e: MouseEvent) => {
      if (!dropdown.contains(e.target as Node) && !anchor.contains(e.target as Node)) {
        dropdown.remove();
        document.removeEventListener('click', closeHandler, true);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler, true), 10);
  }

  /** Show dropdown menu with all prompts below the "..." button */
  private showToolbarDropdown(anchor: HTMLElement, selection: string, toolbar: HTMLElement, selectionRect: DOMRect) {
    const settings = this.getSettings();
    const templates = settings.promptTemplates || [];
    const allPrompts = templates.filter(t => t.prompt);

    const dropdown = anchor.createDiv({ cls: 'ag-ft-dropdown' });
    dropdown.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });

    // Group by category
    const categories = new Map<string, PromptTemplate[]>();
    for (const t of allPrompts) {
      const cat = t.category || 'Custom';
      const list = categories.get(cat) || [];
      list.push(t);
      categories.set(cat, list);
    }

    for (const [category, temps] of categories) {
      const catLabel = dropdown.createDiv({ cls: 'ag-ft-dd-cat', text: category });
      for (const tmpl of temps) {
        const item = dropdown.createDiv({ cls: 'ag-ft-dd-item' });
        const itemIcon = item.createSpan({ cls: 'ag-ft-dd-icon' });
        setIcon(itemIcon, tmpl.icon);
        item.createSpan({ text: tmpl.name, cls: 'ag-ft-dd-label' });
        if (tmpl.showInToolbar) {
          item.createSpan({ text: '★', cls: 'ag-ft-dd-star' });
        }
        item.addEventListener('click', async (e) => {
          e.stopPropagation();
          this.remove();
          const resolved = await this.resolvePromptVariables(tmpl.prompt, selection);
          if (resolved === null) return;
          const curSettings = this.getSettings();
          if (curSettings.quickActionProvider === 'copilot' && curSettings.copilotCredentials) {
            await this.showInlineResult(resolved, selection, selectionRect);
          } else {
            await this.doActivateView();
            const chatLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
            if (chatLeaf?.view instanceof ChatView) {
              const activeFile = this.app.workspace.getActiveFile();
              const vaultBase = (this.app.vault.adapter as any).basePath as string;
              let prefix = '';
              if (activeFile) prefix = `@[${vaultBase}/${activeFile.path}] `;
              (chatLeaf.view as ChatView).quickSend(prefix + resolved);
            }
          }
        });
      }
    }

    // Separator + manage link
    dropdown.createDiv({ cls: 'ag-ft-dd-sep' });
    const manageItem = dropdown.createDiv({ cls: 'ag-ft-dd-item ag-ft-dd-manage' });
    const manageIcon = manageItem.createSpan({ cls: 'ag-ft-dd-icon' });
    setIcon(manageIcon, 'settings');
    manageItem.createSpan({ text: 'Manage Prompts...', cls: 'ag-ft-dd-label' });
    manageItem.addEventListener('click', (e) => {
      e.stopPropagation();
      this.remove();
      showPromptManager(this.app, this.getSettings(), () => this.doSaveSettings());
    });

    // Close dropdown on outside click
    const closeHandler = (e: MouseEvent) => {
      if (!dropdown.contains(e.target as Node) && !anchor.contains(e.target as Node)) {
        dropdown.remove();
        document.removeEventListener('click', closeHandler, true);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler, true), 10);
  }

  remove() {
    if (this.floatingToolbar) {
      const el = this.floatingToolbar;
      el.removeClass('ag-ft-visible');
      el.addEventListener('transitionend', () => el.remove(), { once: true });
      // Fallback removal if transition doesn't fire
      setTimeout(() => { if (el.parentNode) el.remove(); }, 300);
      this.floatingToolbar = null;
    }
  }

  // ── Inline Result Panel ──

  private removeInlineResult() {
    if (this.inlineResultEl) {
      this.inlineResultEl.remove();
      this.inlineResultEl = null;
    }
  }

  private async showInlineResult(prompt: string, selection: string, anchorRect: DOMRect) {
    this.removeInlineResult();

    const panel = document.body.createDiv({ cls: 'ag-inline-result' });
    this.inlineResultEl = panel;

    // Position below anchor
    panel.style.left = `${Math.max(8, anchorRect.left)}px`;
    panel.style.top = `${anchorRect.bottom + 6}px`;
    panel.style.maxWidth = `${Math.min(500, window.innerWidth - 32)}px`;

    // Loading state
    const loadingEl = panel.createDiv({ cls: 'ag-ir-loading' });
    const spinnerEl = loadingEl.createSpan({ cls: 'ag-ir-spinner' });
    setIcon(spinnerEl, 'loader-2');
    loadingEl.createSpan({ text: 'Thinking...' });

    // Close on outside click (tracked for cleanup)
    const outsideHandler = (e: MouseEvent) => {
      if (!panel.contains(e.target as Node)) {
        cleanup();
        this.removeInlineResult();
      }
    };
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { cleanup(); this.removeInlineResult(); }
    };
    const cleanup = () => {
      document.removeEventListener('mousedown', outsideHandler);
      document.removeEventListener('keydown', escHandler);
    };
    setTimeout(() => {
      document.addEventListener('mousedown', outsideHandler);
      document.addEventListener('keydown', escHandler);
    }, 100);

    const doRequest = async () => {
      try {
        const settings = this.getSettings();
        const creds = settings.copilotCredentials;
        if (!creds) throw new Error('Not logged in to GitHub Copilot');

        const { ensureFreshCopilotToken } = await import('./copilot-auth');
        const freshCreds = await ensureFreshCopilotToken(creds);
        if (freshCreds !== creds) {
          settings.copilotCredentials = freshCreds;
          await this.doSaveSettings();
        }

        const res = await fetch(`${freshCreds.apiBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${freshCreds.copilotToken}`,
            'Content-Type': 'application/json',
            'Editor-Version': 'vscode/1.96.2',
            'User-Agent': 'GitHubCopilotChat/0.22.2',
          },
          body: JSON.stringify({
            model: settings.quickActionModel || 'gpt-4o',
            messages: [
              { role: 'system', content: 'You are a helpful writing assistant. Respond directly without markdown code fences unless the user asks for code. Be concise.' },
              { role: 'user', content: prompt + selection },
            ],
            max_tokens: 1024,
            temperature: 0.3,
            stream: true,
          }),
        });

        if (!res.ok) {
          const errText = await res.text();
          let parsed: any;
          try { parsed = JSON.parse(errText); } catch { /* not JSON */ }
          const detail = parsed?.error?.message || errText.slice(0, 200);

          if (res.status === 401 || res.status === 403) {
            throw Object.assign(new Error(`Authentication failed: ${detail}`), { retryable: false, hint: 'Re-login in Settings → Inline Completion.' });
          } else if (res.status === 429) {
            throw Object.assign(new Error('Rate limited'), { retryable: true, hint: 'Too many requests. Wait a moment and retry.' });
          } else {
            throw Object.assign(new Error(`API ${res.status}: ${detail}`), { retryable: true });
          }
        }

        // ── Stream SSE response ──
        loadingEl.remove();
        const contentEl = panel.createDiv({ cls: 'ag-ir-content' });
        let fullText = '';

        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        if (!reader) throw new Error('No response stream');

        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            try {
              const chunk = JSON.parse(data);
              const delta = chunk.choices?.[0]?.delta?.content;
              if (delta) {
                fullText += delta;
                // Re-render markdown
                contentEl.empty();
                await MarkdownRenderer.render(this.app, fullText, contentEl, '', this.plugin);
              }
            } catch { /* skip malformed chunks */ }
          }
        }

        if (!fullText) {
          contentEl.textContent = 'No response';
          fullText = '';
        }

        // ── Action buttons ──
        this.renderInlineResultActions(panel, fullText, cleanup);

      } catch (err: any) {
        loadingEl.remove();
        const errorEl = panel.createDiv({ cls: 'ag-ir-error' });
        const msgEl = errorEl.createDiv({ cls: 'ag-ir-error-msg' });
        msgEl.textContent = err.message || 'Unknown error';

        if (err.hint) {
          errorEl.createDiv({ cls: 'ag-ir-error-hint', text: err.hint });
        }

        const errorActions = errorEl.createDiv({ cls: 'ag-ir-error-actions' });

        if (err.retryable !== false) {
          const retryBtn = errorActions.createEl('button', { cls: 'ag-ir-btn' });
          setIcon(retryBtn, 'refresh-cw');
          retryBtn.createSpan({ text: ' Retry' });
          retryBtn.addEventListener('click', async () => {
            errorEl.remove();
            // Re-add loading
            const newLoading = panel.createDiv({ cls: 'ag-ir-loading' });
            const sp = newLoading.createSpan({ cls: 'ag-ir-spinner' });
            setIcon(sp, 'loader-2');
            newLoading.createSpan({ text: 'Retrying...' });
            loadingEl.replaceWith?.(newLoading);
            await doRequest();
          });
        }

        const closeErrBtn = errorActions.createEl('button', { cls: 'ag-ir-btn ag-ir-close' });
        setIcon(closeErrBtn, 'x');
        closeErrBtn.addEventListener('click', () => { cleanup(); this.removeInlineResult(); });
      }
    };

    await doRequest();
  }

  private renderInlineResultActions(panel: HTMLElement, resultText: string, cleanup: () => void) {
    const actionsEl = panel.createDiv({ cls: 'ag-ir-actions' });

    // Copy
    const copyBtn = actionsEl.createEl('button', { cls: 'ag-ir-btn' });
    copyBtn.setAttribute('aria-label', 'Copy result');
    setIcon(copyBtn, 'copy');
    copyBtn.createSpan({ text: ' Copy' });
    copyBtn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(resultText);
      copyBtn.empty();
      setIcon(copyBtn, 'check');
      copyBtn.createSpan({ text: ' Copied' });
      setTimeout(() => { copyBtn.empty(); setIcon(copyBtn, 'copy'); copyBtn.createSpan({ text: ' Copy' }); }, 1500);
    });

    // Replace selection
    const replaceBtn = actionsEl.createEl('button', { cls: 'ag-ir-btn' });
    replaceBtn.setAttribute('aria-label', 'Replace selection');
    setIcon(replaceBtn, 'replace');
    replaceBtn.createSpan({ text: ' Replace' });
    replaceBtn.addEventListener('click', () => {
      const editor = this.app.workspace.activeEditor?.editor;
      if (editor) {
        editor.replaceSelection(resultText);
        cleanup();
        this.removeInlineResult();
      }
    });

    // Insert after
    const insertBtn = actionsEl.createEl('button', { cls: 'ag-ir-btn' });
    insertBtn.setAttribute('aria-label', 'Insert after selection');
    setIcon(insertBtn, 'arrow-down-to-line');
    insertBtn.createSpan({ text: ' Insert' });
    insertBtn.addEventListener('click', () => {
      const editor = this.app.workspace.activeEditor?.editor;
      if (editor) {
        const cursor = editor.getCursor('to');
        editor.replaceRange('\n' + resultText, cursor);
        cleanup();
        this.removeInlineResult();
      }
    });

    // Send to Chat
    const chatBtn = actionsEl.createEl('button', { cls: 'ag-ir-btn' });
    chatBtn.setAttribute('aria-label', 'Send to chat');
    setIcon(chatBtn, 'message-circle');
    chatBtn.createSpan({ text: ' To Chat' });
    chatBtn.addEventListener('click', async () => {
      cleanup();
      this.removeInlineResult();
      await this.doActivateView();
      const chatLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
      if (chatLeaf?.view instanceof ChatView) {
        (chatLeaf.view as ChatView).setInputText(resultText);
      }
    });

    // Close
    const closeBtn = actionsEl.createEl('button', { cls: 'ag-ir-btn ag-ir-close' });
    setIcon(closeBtn, 'x');
    closeBtn.addEventListener('click', () => { cleanup(); this.removeInlineResult(); });
  }

  private pinSelection(text: string) {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice('No active file to pin from');
      return;
    }

    // Get line numbers from editor
    let startLine = 0;
    let endLine = 0;
    const editor = this.app.workspace.activeEditor?.editor;
    if (editor) {
      const cursor = editor.getCursor('from');
      const cursorTo = editor.getCursor('to');
      startLine = cursor.line + 1; // 1-based
      endLine = cursorTo.line + 1;
    }

    const pin: PinItem = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      filePath: activeFile.path,
      fileName: activeFile.basename,
      startLine,
      endLine,
      text: text.slice(0, 5000), // cap at 5k chars
      timestamp: Date.now(),
    };

    const settings = this.getSettings();
    settings.pins.push(pin);
    this.doSaveSettings();

    // Notify ChatView
    const chatLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
    if (chatLeaf?.view instanceof ChatView) {
      (chatLeaf.view as ChatView).onPinsUpdated();
    }

    const lineInfo = startLine > 0 ? ` (L${startLine}${endLine !== startLine ? `-L${endLine}` : ''})` : '';
    new Notice(`Pinned from ${activeFile.basename}${lineInfo}`);
  }
}
