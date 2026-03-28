/**
 * Prompt Manager UI — modal for managing prompt templates, lists, and variables.
 * Extracted from main.ts for maintainability.
 */

import { App, Modal, Notice, setIcon } from 'obsidian';
import { DEFAULT_SETTINGS, type AntigravitySettings, type PromptTemplate, type PromptList, type UserVariable } from './settings';

/** Check if a prompt contains interactive variables that need user input */
export function hasInteractiveVariables(prompt: string): boolean {
  return /\{\{(input|select|multiselect|random):/.test(prompt);
}

export function showPromptManager(
  app: App,
  settings: AntigravitySettings,
  saveSettings: () => Promise<void>,
) {
  const modal = new Modal(app);
  modal.titleEl.setText('');
  modal.modalEl.addClass('ag-prompt-manager-modal');
  modal.modalEl.style.cssText = 'width: 640px; max-width: 90vw;';
  const root = modal.contentEl;
  root.empty();
  root.style.cssText = 'max-height: 75vh; overflow-y: auto; padding: 0;';

  let filterText = '';
  let editingId: string | null = null;
  let activeTab: 'prompts' | 'lists' | 'variables' = 'prompts';

  const render = () => {
    root.empty();

    // ── Header Row ──
    const header = root.createDiv();
    header.style.cssText = 'padding: 20px 20px 0; display: flex; align-items: center; justify-content: space-between;';
    const titleEl = header.createDiv();
    titleEl.style.cssText = 'font-weight: 700; font-size: 18px; display: flex; align-items: center; gap: 10px;';
    const titleIcon = titleEl.createSpan();
    setIcon(titleIcon, 'scroll-text');
    titleEl.createSpan({ text: 'Prompt Manager' });

    // ── Tab Bar ──
    const tabBar = root.createDiv();
    tabBar.style.cssText = 'display: flex; gap: 0; padding: 12px 20px 0; border-bottom: 1px solid var(--background-modifier-border);';
    const tabs: { key: typeof activeTab; label: string; icon: string }[] = [
      { key: 'prompts', label: 'Prompts', icon: 'scroll-text' },
      { key: 'lists', label: 'Lists', icon: 'list' },
      { key: 'variables', label: 'Variables', icon: 'variable' },
    ];
    for (const tab of tabs) {
      const tabEl = tabBar.createDiv();
      tabEl.style.cssText = `padding: 8px 16px; cursor: pointer; font-size: 13px; font-weight: 500; border-bottom: 2px solid ${activeTab === tab.key ? 'var(--interactive-accent)' : 'transparent'}; color: ${activeTab === tab.key ? 'var(--text-normal)' : 'var(--text-muted)'}; display: flex; align-items: center; gap: 6px; transition: color 0.15s;`;
      const tabIcon = tabEl.createSpan();
      setIcon(tabIcon, tab.icon);
      (tabIcon.querySelector('svg') as SVGElement | null)?.setAttribute('width', '14');
      (tabIcon.querySelector('svg') as SVGElement | null)?.setAttribute('height', '14');
      tabEl.createSpan({ text: tab.label });
      tabEl.addEventListener('click', () => { activeTab = tab.key; render(); });
      tabEl.addEventListener('mouseenter', () => { if (activeTab !== tab.key) tabEl.style.color = 'var(--text-normal)'; });
      tabEl.addEventListener('mouseleave', () => { if (activeTab !== tab.key) tabEl.style.color = 'var(--text-muted)'; });
    }

    if (activeTab === 'prompts') renderPromptsTab(app, settings, saveSettings, root, render, filterText, (v: string) => { filterText = v; }, editingId, (v: string | null) => { editingId = v; });
    else if (activeTab === 'lists') renderListsTab(app, settings, saveSettings, root, render);
    else if (activeTab === 'variables') renderVariablesTab(app, settings, saveSettings, root, render);
  };

  render();
  modal.open();

  (modal as any)._pmRender = render;
  (modal as any)._pmEditingId = () => editingId;
  (modal as any)._pmSetEditingId = (id: string | null) => { editingId = id; };
}

// ── Prompts Tab ──

function renderPromptsTab(
  app: App,
  settings: AntigravitySettings,
  saveSettings: () => Promise<void>,
  root: HTMLElement,
  rerender: () => void,
  filterText: string,
  setFilterText: (v: string) => void,
  editingId: string | null,
  setEditingId: (v: string | null) => void,
) {
  const templates = settings.promptTemplates || [];

  // Add button
  const addRow = root.createDiv();
  addRow.style.cssText = 'padding: 12px 20px 0; display: flex; justify-content: flex-end;';
  const addBtn = addRow.createEl('button', { cls: 'mod-cta' });
  addBtn.style.cssText = 'font-size: 12px; padding: 6px 14px; border-radius: 8px; display: flex; align-items: center; gap: 4px;';
  const addIcon = addBtn.createSpan();
  setIcon(addIcon, 'plus');
  addBtn.createSpan({ text: 'New Prompt' });
  addBtn.addEventListener('click', () => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const newTmpl: PromptTemplate = {
      id, name: '', prompt: '', icon: 'file-text', category: 'Custom',
      showInToolbar: false, toolbarOrder: 0,
    };
    settings.promptTemplates.push(newTmpl);
    setEditingId(id);
    rerender();
  });

  // Search
  const searchRow = root.createDiv();
  searchRow.style.cssText = 'padding: 12px 20px 4px;';
  const searchInput = searchRow.createEl('input', {
    attr: { type: 'text', placeholder: 'Search prompts...' },
  });
  searchInput.style.cssText = 'width: 100%; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--background-modifier-border); background: var(--background-primary); font-size: 13px; box-sizing: border-box;';
  searchInput.value = filterText;
  searchInput.addEventListener('input', () => {
    setFilterText(searchInput.value);
    renderList();
  });
  if (!editingId) setTimeout(() => searchInput.focus(), 50);

  // Toolbar Preview
  const toolbarPrompts = templates.filter(t => t.showInToolbar && t.prompt);
  if (toolbarPrompts.length > 0) {
    const previewSection = root.createDiv();
    previewSection.style.cssText = 'padding: 12px 20px 0;';
    const previewLabel = previewSection.createDiv();
    previewLabel.style.cssText = 'font-size: 11px; color: var(--text-faint); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;';
    previewLabel.textContent = 'Toolbar Preview';
    const previewBar = previewSection.createDiv();
    previewBar.style.cssText = 'display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 8px; border-radius: 10px; background: var(--background-secondary); border: 1px solid var(--background-modifier-border);';
    for (const tp of toolbarPrompts.sort((a, b) => (a.toolbarOrder || 0) - (b.toolbarOrder || 0))) {
      const chip = previewBar.createDiv();
      chip.style.cssText = 'display: flex; align-items: center; gap: 4px; padding: 4px 8px; border-radius: 6px; font-size: 11px; color: var(--text-muted); background: var(--background-primary); cursor: default;';
      const chipIcon = chip.createSpan();
      setIcon(chipIcon, tp.icon);
      (chipIcon.querySelector('svg') as SVGElement | null)?.setAttribute('width', '12');
      (chipIcon.querySelector('svg') as SVGElement | null)?.setAttribute('height', '12');
      chip.createSpan({ text: tp.name });
    }
  }

  // List Container
  const listContainer = root.createDiv();
  listContainer.style.cssText = 'padding: 12px 12px 20px;';

  const renderList = () => {
    listContainer.empty();
    const query = filterText.toLowerCase();

    const filtered = templates.filter(t =>
      (t.prompt || t.id === editingId) &&
      (query === '' || t.name.toLowerCase().includes(query) || (t.prompt || '').toLowerCase().includes(query) || t.category.toLowerCase().includes(query))
    );

    if (filtered.length === 0) {
      const emptyEl = listContainer.createDiv();
      emptyEl.style.cssText = 'text-align: center; padding: 32px; color: var(--text-muted); font-size: 14px;';
      emptyEl.textContent = query ? 'No prompts match your search' : 'No prompts yet. Click "+ New Prompt" to create one!';
      return;
    }

    // Group by category
    const categories = new Map<string, PromptTemplate[]>();
    for (const t of filtered) {
      const cat = t.category || 'Custom';
      const list = categories.get(cat) || [];
      list.push(t);
      categories.set(cat, list);
    }

    for (const [category, temps] of categories) {
      const catEl = listContainer.createDiv();
      catEl.style.cssText = 'padding: 10px 8px 4px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: var(--text-faint);';
      catEl.textContent = category;

      for (const tmpl of temps) {
        renderPromptCard(app, settings, saveSettings, listContainer, tmpl, templates, rerender, false);

        if (editingId === tmpl.id) {
          const wrapper = listContainer.querySelector(`[data-tmpl-id="${tmpl.id}"]`) as HTMLElement | null;
          if (wrapper) {
            setTimeout(() => {
              openInlineEditor(app, settings, saveSettings, wrapper, tmpl, rerender);
              wrapper.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 50);
          }
          setEditingId(null);
        }
      }
    }
  };

  renderList();

  // Variable Reference
  const helpEl = root.createDiv();
  helpEl.style.cssText = 'padding: 4px 20px 16px; font-size: 11px; color: var(--text-faint); line-height: 2.0;';
  const codeStyle = 'font-size:10px;padding:1px 4px;border-radius:3px;background:var(--background-secondary)';
  helpEl.innerHTML = `<strong>Auto Variables:</strong> <code style="${codeStyle}">{{selection}}</code> · <code style="${codeStyle}">{{pins}}</code> · <code style="${codeStyle}">{{filename}}</code> · <code style="${codeStyle}">{{filepath}}</code> · <code style="${codeStyle}">{{frontmatter}}</code> · <code style="${codeStyle}">{{date}}</code> · <code style="${codeStyle}">{{time}}</code><br/>`
    + `<strong>Interactive:</strong> <code style="${codeStyle}">{{input:description}}</code> · <code style="${codeStyle}">{{select:listName}}</code> · <code style="${codeStyle}">{{multiselect:listName:N}}</code> · <code style="${codeStyle}">{{random:listName:N}}</code><br/>`
    + `<strong>User Vars:</strong> <code style="${codeStyle}">{{var:keyName}}</code>`;
}

// ── Lists Tab ──

function renderListsTab(
  app: App,
  settings: AntigravitySettings,
  saveSettings: () => Promise<void>,
  root: HTMLElement,
  rerender: () => void,
) {
  const lists = settings.promptLists || [];

  const addRow = root.createDiv();
  addRow.style.cssText = 'padding: 12px 20px 0; display: flex; justify-content: flex-end;';
  const addBtn = addRow.createEl('button', { cls: 'mod-cta' });
  addBtn.style.cssText = 'font-size: 12px; padding: 6px 14px; border-radius: 8px; display: flex; align-items: center; gap: 4px;';
  const addBtnIcon = addBtn.createSpan();
  setIcon(addBtnIcon, 'plus');
  addBtn.createSpan({ text: 'New List' });
  addBtn.addEventListener('click', () => {
    const id = 'list-' + Date.now().toString(36);
    const newList: PromptList = { id, name: '', items: [{ label: '', value: '' }], isBuiltin: false };
    settings.promptLists.push(newList);
    saveSettings();
    rerender();
  });

  const helpEl = root.createDiv();
  helpEl.style.cssText = 'padding: 12px 20px 4px; font-size: 12px; color: var(--text-muted);';
  helpEl.textContent = 'Lists are used with {{select:name}}, {{multiselect:name:N}}, {{random:name:N}} variables in prompts.';

  const listContainer = root.createDiv();
  listContainer.style.cssText = 'padding: 8px 20px 20px;';

  for (const list of lists) {
    const card = listContainer.createDiv();
    card.style.cssText = 'margin-bottom: 16px; padding: 16px; border-radius: 12px; background: var(--background-secondary); border: 1px solid var(--background-modifier-border);';

    // Header row
    const headerRow = card.createDiv();
    headerRow.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-bottom: 12px;';

    const nameInput = headerRow.createEl('input', {
      attr: { type: 'text', placeholder: 'List name (used in {{select:name}})', value: list.name },
    });
    nameInput.style.cssText = 'flex: 1; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--background-modifier-border); background: var(--background-primary); font-size: 13px; font-weight: 600;';
    nameInput.addEventListener('change', async () => {
      list.name = nameInput.value.trim();
      await saveSettings();
    });

    if (list.isBuiltin) {
      const badge = headerRow.createSpan({ text: 'BUILTIN' });
      badge.style.cssText = 'font-size: 9px; padding: 1px 5px; border-radius: 4px; background: var(--background-modifier-border); color: var(--text-faint); letter-spacing: 0.5px;';
    }

    // Usage hint
    const usageEl = card.createDiv();
    usageEl.style.cssText = 'font-size: 11px; color: var(--text-faint); margin-bottom: 8px; font-family: var(--font-monospace);';
    usageEl.textContent = list.name ? `{{select:${list.name}}}` : '{{select:???}}';

    // Items
    const itemsContainer = card.createDiv();
    const renderItems = () => {
      itemsContainer.empty();
      for (let i = 0; i < list.items.length; i++) {
        const item = list.items[i];
        const row = itemsContainer.createDiv();
        row.style.cssText = 'display: flex; gap: 6px; margin-bottom: 4px; align-items: center;';

        const labelInput = row.createEl('input', {
          attr: { type: 'text', placeholder: 'Label (shown)', value: item.label },
        });
        labelInput.style.cssText = 'flex: 1; padding: 4px 8px; border-radius: 4px; border: 1px solid var(--background-modifier-border); background: var(--background-primary); font-size: 12px;';
        labelInput.addEventListener('change', async () => {
          item.label = labelInput.value;
          if (!item.value || item.value === item.label) item.value = item.label;
          await saveSettings();
        });

        const valueInput = row.createEl('input', {
          attr: { type: 'text', placeholder: 'Value (substituted)', value: item.value },
        });
        valueInput.style.cssText = 'flex: 1; padding: 4px 8px; border-radius: 4px; border: 1px solid var(--background-modifier-border); background: var(--background-primary); font-size: 12px;';
        valueInput.addEventListener('change', async () => {
          item.value = valueInput.value;
          await saveSettings();
        });

        const removeBtn = row.createEl('button');
        removeBtn.style.cssText = 'padding: 2px 4px; border-radius: 4px; cursor: pointer; color: var(--text-faint); flex-shrink: 0;';
        setIcon(removeBtn, 'x');
        removeBtn.addEventListener('click', async () => {
          list.items.splice(i, 1);
          await saveSettings();
          renderItems();
        });
      }
    };
    renderItems();

    // Add item + delete list buttons
    const btnRow = card.createDiv();
    btnRow.style.cssText = 'display: flex; gap: 8px; margin-top: 8px;';

    const addItemBtn = btnRow.createEl('button', { text: '+ Add item' });
    addItemBtn.style.cssText = 'font-size: 11px; padding: 4px 10px; border-radius: 6px; cursor: pointer;';
    addItemBtn.addEventListener('click', async () => {
      list.items.push({ label: '', value: '' });
      await saveSettings();
      renderItems();
    });

    if (list.isBuiltin) {
      const resetBtn = btnRow.createEl('button', { text: 'Reset' });
      resetBtn.style.cssText = 'font-size: 11px; padding: 4px 10px; border-radius: 6px; cursor: pointer; margin-left: auto;';
      resetBtn.addEventListener('click', async () => {
        const defaultList = DEFAULT_SETTINGS.promptLists.find(d => d.id === list.id);
        if (defaultList) {
          Object.assign(list, defaultList);
          await saveSettings();
          rerender();
          new Notice('Reset to default');
        }
      });
    } else {
      const delBtn = btnRow.createEl('button', { text: 'Delete list' });
      delBtn.style.cssText = 'font-size: 11px; padding: 4px 10px; border-radius: 6px; cursor: pointer; color: var(--text-error); margin-left: auto;';
      delBtn.addEventListener('click', async () => {
        settings.promptLists = settings.promptLists.filter(l => l.id !== list.id);
        await saveSettings();
        rerender();
      });
    }
  }
}

// ── Variables Tab ──

function renderVariablesTab(
  app: App,
  settings: AntigravitySettings,
  saveSettings: () => Promise<void>,
  root: HTMLElement,
  rerender: () => void,
) {
  const vars = settings.userVariables || [];

  const addRow = root.createDiv();
  addRow.style.cssText = 'padding: 12px 20px 0; display: flex; justify-content: flex-end;';
  const addBtn = addRow.createEl('button', { cls: 'mod-cta' });
  addBtn.style.cssText = 'font-size: 12px; padding: 6px 14px; border-radius: 8px; display: flex; align-items: center; gap: 4px;';
  const addBtnIcon = addBtn.createSpan();
  setIcon(addBtnIcon, 'plus');
  addBtn.createSpan({ text: 'New Variable' });
  addBtn.addEventListener('click', () => {
    const id = 'var-' + Date.now().toString(36);
    const newVar: UserVariable = { id, name: '', value: '', description: '' };
    settings.userVariables.push(newVar);
    saveSettings();
    rerender();
  });

  const helpEl = root.createDiv();
  helpEl.style.cssText = 'padding: 12px 20px 4px; font-size: 12px; color: var(--text-muted);';
  helpEl.textContent = 'Variables are reusable key-value pairs. Use {{var:name}} in prompts to substitute the value.';

  const listContainer = root.createDiv();
  listContainer.style.cssText = 'padding: 8px 20px 20px;';

  if (vars.length === 0) {
    const emptyEl = listContainer.createDiv();
    emptyEl.style.cssText = 'text-align: center; padding: 32px; color: var(--text-muted); font-size: 14px;';
    emptyEl.textContent = 'No variables yet. Create one to reuse values across prompts.';
    return;
  }

  for (const uv of vars) {
    const card = listContainer.createDiv();
    card.style.cssText = 'margin-bottom: 12px; padding: 14px; border-radius: 10px; background: var(--background-secondary); border: 1px solid var(--background-modifier-border);';

    // Row 1: name + description
    const row1 = card.createDiv();
    row1.style.cssText = 'display: flex; gap: 10px; margin-bottom: 8px;';

    const nameWrap = row1.createDiv();
    nameWrap.style.cssText = 'width: 140px; flex-shrink: 0;';
    nameWrap.createDiv({ text: 'Name', cls: 'ag-pm-field-label' });
    const nameInput = nameWrap.createEl('input', {
      attr: { type: 'text', placeholder: 'e.g. writingStyle', value: uv.name },
    });
    nameInput.style.cssText = 'width: 100%; padding: 4px 8px; border-radius: 4px; border: 1px solid var(--background-modifier-border); background: var(--background-primary); font-size: 12px;';
    nameInput.addEventListener('change', async () => { uv.name = nameInput.value.trim(); await saveSettings(); });

    const descWrap = row1.createDiv();
    descWrap.style.cssText = 'flex: 1;';
    descWrap.createDiv({ text: 'Description', cls: 'ag-pm-field-label' });
    const descInput = descWrap.createEl('input', {
      attr: { type: 'text', placeholder: 'What this variable is for', value: uv.description },
    });
    descInput.style.cssText = 'width: 100%; padding: 4px 8px; border-radius: 4px; border: 1px solid var(--background-modifier-border); background: var(--background-primary); font-size: 12px;';
    descInput.addEventListener('change', async () => { uv.description = descInput.value; await saveSettings(); });

    // Row 2: value
    card.createDiv({ text: 'Value', cls: 'ag-pm-field-label' });
    const valueEl = card.createEl('textarea', {
      attr: { rows: '2', placeholder: 'The value that will replace {{var:name}}' },
    });
    valueEl.style.cssText = 'width: 100%; font-size: 12px; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--background-modifier-border); background: var(--background-primary); resize: vertical; min-height: 40px; box-sizing: border-box;';
    valueEl.value = uv.value;
    valueEl.addEventListener('change', async () => { uv.value = valueEl.value; await saveSettings(); });

    // Usage hint + delete
    const footer = card.createDiv();
    footer.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-top: 6px;';
    const usageEl = footer.createDiv();
    usageEl.style.cssText = 'font-size: 11px; color: var(--text-faint); font-family: var(--font-monospace);';
    usageEl.textContent = uv.name ? `{{var:${uv.name}}}` : '{{var:???}}';

    const delBtn = footer.createEl('button', { text: 'Delete' });
    delBtn.style.cssText = 'font-size: 11px; padding: 4px 10px; border-radius: 6px; cursor: pointer; color: var(--text-error);';
    delBtn.addEventListener('click', async () => {
      settings.userVariables = settings.userVariables.filter(v => v.id !== uv.id);
      await saveSettings();
      rerender();
    });
  }
}

// ── Prompt Card (used by Prompt Manager) ──

function renderPromptCard(
  app: App,
  settings: AntigravitySettings,
  saveSettings: () => Promise<void>,
  parent: HTMLElement,
  tmpl: PromptTemplate,
  templates: PromptTemplate[],
  rerender: () => void,
  _indented: boolean,
) {
  const wrapper = parent.createDiv();
  wrapper.setAttribute('data-tmpl-id', tmpl.id);

  const card = wrapper.createDiv({ cls: 'ag-pm-card' });
  card.style.cssText = 'display: flex; align-items: center; gap: 10px; padding: 10px 12px; margin: 2px 0; border-radius: 10px; cursor: pointer; transition: background 0.1s ease;';
  card.addEventListener('mouseenter', () => card.style.background = 'var(--background-modifier-hover)');
  card.addEventListener('mouseleave', () => card.style.background = '');

  // Icon circle
  const iconWrap = card.createDiv();
  iconWrap.style.cssText = 'width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; background: var(--interactive-accent); color: var(--text-on-accent); flex-shrink: 0;';
  const iconEl = iconWrap.createSpan();
  setIcon(iconEl, tmpl.icon);
  const iconSvg = iconEl.querySelector('svg') as SVGElement | null;
  if (iconSvg) { iconSvg.setAttribute('width', '16'); iconSvg.setAttribute('height', '16'); }

  // Text column
  const textCol = card.createDiv();
  textCol.style.cssText = 'flex: 1; min-width: 0;';
  const nameRow = textCol.createDiv();
  nameRow.style.cssText = 'font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 6px;';
  nameRow.createSpan({ text: tmpl.name || '(Untitled)' });
  if (tmpl.showInToolbar) {
    const badge = nameRow.createSpan({ text: 'TOOLBAR' });
    badge.style.cssText = 'font-size: 9px; padding: 1px 5px; border-radius: 4px; background: var(--interactive-accent); color: var(--text-on-accent); letter-spacing: 0.5px;';
  }
  if (tmpl.isBuiltin || tmpl.id.startsWith('builtin-')) {
    const builtinBadge = nameRow.createSpan({ text: 'BUILTIN' });
    builtinBadge.style.cssText = 'font-size: 9px; padding: 1px 5px; border-radius: 4px; background: var(--background-modifier-border); color: var(--text-faint); letter-spacing: 0.5px;';
  }
  if (hasInteractiveVariables(tmpl.prompt || '')) {
    const interactiveBadge = nameRow.createSpan({ text: 'INTERACTIVE' });
    interactiveBadge.style.cssText = 'font-size: 9px; padding: 1px 5px; border-radius: 4px; background: var(--text-accent); color: var(--text-on-accent); letter-spacing: 0.5px;';
  }
  const preview = (tmpl.prompt || '').replace(/\n/g, ' ').slice(0, 80);
  const previewEl = textCol.createDiv({ text: preview + ((tmpl.prompt || '').length > 80 ? '...' : '') });
  previewEl.style.cssText = 'font-size: 11px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px;';

  // Action buttons (visible on hover)
  const actions = card.createDiv();
  actions.style.cssText = 'display: flex; gap: 2px; opacity: 0; transition: opacity 0.15s ease; flex-shrink: 0;';
  card.addEventListener('mouseenter', () => actions.style.opacity = '1');
  card.addEventListener('mouseleave', () => actions.style.opacity = '0');

  // Toolbar toggle
  const toolbarBtn = createPmActionBtn(actions, tmpl.showInToolbar ? 'Remove from toolbar' : 'Add to toolbar', tmpl.showInToolbar ? 'layout-panel-top' : 'plus-square');
  toolbarBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    tmpl.showInToolbar = !tmpl.showInToolbar;
    if (tmpl.showInToolbar && !tmpl.toolbarOrder) {
      tmpl.toolbarOrder = Math.max(...templates.map(t => t.toolbarOrder || 0), 0) + 10;
    }
    await saveSettings();
    rerender();
  });

  // Edit
  const editBtn = createPmActionBtn(actions, 'Edit', 'pencil');
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openInlineEditor(app, settings, saveSettings, wrapper, tmpl, rerender);
  });

  // Reset builtin / Delete custom
  if (tmpl.isBuiltin || tmpl.id.startsWith('builtin-')) {
    const resetBtn = createPmActionBtn(actions, 'Reset to default', 'rotate-ccw');
    resetBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const defaultTemplate = DEFAULT_SETTINGS.promptTemplates.find(d => d.id === tmpl.id);
      if (defaultTemplate) {
        Object.assign(tmpl, defaultTemplate);
        await saveSettings();
        rerender();
        new Notice('Reset to default');
      }
    });
  } else {
    const delBtn = createPmActionBtn(actions, 'Delete', 'trash-2');
    delBtn.style.color = 'var(--text-error)';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      settings.promptTemplates = settings.promptTemplates.filter(t => t.id !== tmpl.id);
      await saveSettings();
      rerender();
    });
  }

  // Click row to edit
  card.addEventListener('click', () => {
    openInlineEditor(app, settings, saveSettings, wrapper, tmpl, rerender);
  });
}

// ── Inline Editor (expands below card) ──

function openInlineEditor(
  app: App,
  settings: AntigravitySettings,
  saveSettings: () => Promise<void>,
  wrapper: HTMLElement,
  tmpl: PromptTemplate,
  rerender: () => void,
) {
  // Close any existing inline editor first
  const existingEditor = wrapper.parentElement?.querySelector('.ag-pm-inline-editor');
  if (existingEditor) { existingEditor.remove(); }

  // Also remove from other cards
  wrapper.parentElement?.querySelectorAll('.ag-pm-inline-editor').forEach(el => el.remove());

  const ICON_GRID = [
    'languages', 'text', 'sparkles', 'book-open', 'list', 'tags', 'check', 'type',
    'shrink', 'expand', 'briefcase', 'smile', 'shield', 'pencil', 'file-text', 'code',
    'brain', 'lightbulb', 'search', 'globe', 'message-circle', 'target', 'zap', 'star',
    'heart', 'bookmark', 'link', 'image', 'calendar', 'clock', 'map', 'compass',
    'flag', 'award', 'coffee', 'feather', 'hash', 'at-sign', 'terminal', 'database',
    'layers', 'grid', 'box', 'package',
  ];

  const editor = wrapper.createDiv({ cls: 'ag-pm-inline-editor' });
  editor.style.cssText = 'padding: 16px; margin: 4px 0 8px; border-radius: 12px; background: var(--background-secondary); border: 1px solid var(--background-modifier-border);';

  let name = tmpl.name;
  let prompt = tmpl.prompt;
  let icon = tmpl.icon;
  let category = tmpl.category;
  let showInToolbar = tmpl.showInToolbar || false;

  // Row 1: Name + Category side by side
  const row1 = editor.createDiv();
  row1.style.cssText = 'display: flex; gap: 10px; margin-bottom: 10px;';

  const nameWrap = row1.createDiv();
  nameWrap.style.cssText = 'flex: 1;';
  nameWrap.createDiv({ text: 'Name', cls: 'ag-pm-field-label' });
  const nameInput = nameWrap.createEl('input', {
    attr: { type: 'text', placeholder: 'My prompt', value: name },
  });
  nameInput.style.cssText = 'width: 100%; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--background-modifier-border); background: var(--background-primary); font-size: 13px;';
  nameInput.addEventListener('input', () => name = nameInput.value);

  const catWrap = row1.createDiv();
  catWrap.style.cssText = 'width: 140px; flex-shrink: 0;';
  catWrap.createDiv({ text: 'Category', cls: 'ag-pm-field-label' });
  const catSelect = catWrap.createEl('select');
  catSelect.style.cssText = 'width: 100%; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--background-modifier-border); background: var(--background-primary); font-size: 13px;';
  for (const cat of ['Translation', 'Writing', 'Analysis', 'Organization', 'Custom']) {
    const opt = catSelect.createEl('option', { text: cat, attr: { value: cat } });
    if (cat === category) opt.selected = true;
  }
  catSelect.addEventListener('change', () => category = catSelect.value);

  // Row 2: Icon picker
  const iconSection = editor.createDiv();
  iconSection.style.cssText = 'margin-bottom: 10px;';
  iconSection.createDiv({ text: 'Icon', cls: 'ag-pm-field-label' });
  const iconGrid = iconSection.createDiv();
  iconGrid.style.cssText = 'display: flex; flex-wrap: wrap; gap: 4px; padding: 6px; border-radius: 8px; background: var(--background-primary); border: 1px solid var(--background-modifier-border); max-height: 80px; overflow-y: auto;';

  const renderIconGrid = () => {
    iconGrid.empty();
    for (const iconName of ICON_GRID) {
      const iconBtn = iconGrid.createDiv();
      iconBtn.style.cssText = `width: 28px; height: 28px; border-radius: 6px; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background 0.1s ease; ${icon === iconName ? 'background: var(--interactive-accent); color: var(--text-on-accent);' : 'color: var(--text-muted);'}`;
      iconBtn.title = iconName;
      const ic = iconBtn.createSpan();
      setIcon(ic, iconName);
      (ic.querySelector('svg') as SVGElement | null)?.setAttribute('width', '14');
      (ic.querySelector('svg') as SVGElement | null)?.setAttribute('height', '14');
      iconBtn.addEventListener('click', () => {
        icon = iconName;
        renderIconGrid();
      });
      iconBtn.addEventListener('mouseenter', () => {
        if (icon !== iconName) iconBtn.style.background = 'var(--background-modifier-hover)';
      });
      iconBtn.addEventListener('mouseleave', () => {
        if (icon !== iconName) iconBtn.style.background = '';
      });
    }
  };
  renderIconGrid();

  // Row 3: Toolbar toggle
  const toolbarRow = editor.createDiv();
  toolbarRow.style.cssText = 'margin-bottom: 10px; display: flex; align-items: center; gap: 8px;';
  const toolbarCheckbox = toolbarRow.createEl('input', { attr: { type: 'checkbox' } });
  toolbarCheckbox.checked = showInToolbar;
  toolbarCheckbox.style.cssText = 'cursor: pointer;';
  toolbarCheckbox.addEventListener('change', () => showInToolbar = toolbarCheckbox.checked);
  toolbarRow.createSpan({ text: 'Show in selection toolbar' });
  toolbarRow.style.fontSize = '13px';
  toolbarRow.style.color = 'var(--text-muted)';

  // Row 4: Prompt textarea
  editor.createDiv({ text: 'Prompt', cls: 'ag-pm-field-label' });
  const promptEl = editor.createEl('textarea', {
    attr: { rows: '5', placeholder: 'Translate the following text to...\n\n{{selection}}' },
  });
  promptEl.style.cssText = 'width: 100%; font-family: var(--font-monospace); font-size: 12px; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--background-modifier-border); background: var(--background-primary); resize: vertical; min-height: 80px; line-height: 1.5; box-sizing: border-box;';
  promptEl.value = prompt;
  promptEl.addEventListener('input', () => prompt = promptEl.value);

  // Variable chips
  const varRow = editor.createDiv();
  varRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: 3px; margin-top: 4px; margin-bottom: 4px;';

  const autoVarLabel = varRow.createSpan({ text: 'Auto:' });
  autoVarLabel.style.cssText = 'font-size: 10px; color: var(--text-faint); padding: 2px 4px; align-self: center;';

  for (const v of ['{{selection}}', '{{pins}}', '{{filename}}', '{{filepath}}', '{{frontmatter}}', '{{date}}', '{{time}}']) {
    const chip = varRow.createEl('button', { text: v });
    chip.style.cssText = 'font-size: 10px; padding: 2px 6px; border-radius: 4px; font-family: var(--font-monospace); background: var(--background-primary); border: 1px solid var(--background-modifier-border); color: var(--text-muted); cursor: pointer;';
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      const start = promptEl.selectionStart;
      const end = promptEl.selectionEnd;
      promptEl.value = promptEl.value.slice(0, start) + v + promptEl.value.slice(end);
      prompt = promptEl.value;
      promptEl.focus();
      promptEl.setSelectionRange(start + v.length, start + v.length);
    });
  }

  // Interactive variable chips
  const interactiveRow = editor.createDiv();
  interactiveRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: 3px; margin-bottom: 4px;';

  const interactiveLabel = interactiveRow.createSpan({ text: 'Interactive:' });
  interactiveLabel.style.cssText = 'font-size: 10px; color: var(--text-faint); padding: 2px 4px; align-self: center;';

  const interactiveVars = [
    { text: '{{input:...}}', insert: '{{input:' },
    { text: '{{select:...}}', insert: '{{select:' },
    { text: '{{multiselect:...:N}}', insert: '{{multiselect:' },
    { text: '{{random:...:N}}', insert: '{{random:' },
  ];
  for (const iv of interactiveVars) {
    const chip = interactiveRow.createEl('button', { text: iv.text });
    chip.style.cssText = 'font-size: 10px; padding: 2px 6px; border-radius: 4px; font-family: var(--font-monospace); background: var(--interactive-accent-hover); border: 1px solid var(--interactive-accent); color: var(--text-accent); cursor: pointer;';
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      const start = promptEl.selectionStart;
      const end = promptEl.selectionEnd;
      promptEl.value = promptEl.value.slice(0, start) + iv.insert + promptEl.value.slice(end);
      prompt = promptEl.value;
      promptEl.focus();
      promptEl.setSelectionRange(start + iv.insert.length, start + iv.insert.length);
    });
  }

  // User variable chips (if any exist)
  const userVars = settings.userVariables || [];
  if (userVars.length > 0) {
    const userVarRow = editor.createDiv();
    userVarRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: 3px; margin-bottom: 4px;';
    const uvLabel = userVarRow.createSpan({ text: 'User:' });
    uvLabel.style.cssText = 'font-size: 10px; color: var(--text-faint); padding: 2px 4px; align-self: center;';
    for (const uv of userVars) {
      if (!uv.name) continue;
      const chip = userVarRow.createEl('button', { text: `{{var:${uv.name}}}` });
      chip.style.cssText = 'font-size: 10px; padding: 2px 6px; border-radius: 4px; font-family: var(--font-monospace); background: var(--background-primary); border: 1px solid var(--background-modifier-border); color: var(--text-muted); cursor: pointer;';
      chip.title = uv.description || uv.value;
      chip.addEventListener('click', (e) => {
        e.preventDefault();
        const v = `{{var:${uv.name}}}`;
        const start = promptEl.selectionStart;
        const end = promptEl.selectionEnd;
        promptEl.value = promptEl.value.slice(0, start) + v + promptEl.value.slice(end);
        prompt = promptEl.value;
        promptEl.focus();
        promptEl.setSelectionRange(start + v.length, start + v.length);
      });
    }
  }

  // List name chips (available lists)
  const lists = settings.promptLists || [];
  if (lists.length > 0) {
    const listRow = editor.createDiv();
    listRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: 3px; margin-bottom: 10px;';
    const listLabel = listRow.createSpan({ text: 'Lists:' });
    listLabel.style.cssText = 'font-size: 10px; color: var(--text-faint); padding: 2px 4px; align-self: center;';
    for (const l of lists) {
      if (!l.name) continue;
      const chip = listRow.createEl('button', { text: `{{select:${l.name}}}` });
      chip.style.cssText = 'font-size: 10px; padding: 2px 6px; border-radius: 4px; font-family: var(--font-monospace); background: var(--background-primary); border: 1px solid var(--background-modifier-border); color: var(--text-muted); cursor: pointer;';
      chip.title = `${l.items.length} items`;
      chip.addEventListener('click', (e) => {
        e.preventDefault();
        const v = `{{select:${l.name}}}`;
        const start = promptEl.selectionStart;
        const end = promptEl.selectionEnd;
        promptEl.value = promptEl.value.slice(0, start) + v + promptEl.value.slice(end);
        prompt = promptEl.value;
        promptEl.focus();
        promptEl.setSelectionRange(start + v.length, start + v.length);
      });
    }
  }

  // Action buttons
  const btnRow = editor.createDiv();
  btnRow.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';

  const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
  cancelBtn.style.cssText = 'padding: 6px 14px; border-radius: 6px; font-size: 12px; cursor: pointer;';
  cancelBtn.addEventListener('click', async () => {
    if (!tmpl.name && !tmpl.prompt) {
      settings.promptTemplates = settings.promptTemplates.filter(t => t.id !== tmpl.id);
      await saveSettings();
      rerender();
    } else {
      editor.remove();
    }
  });

  const saveBtn = btnRow.createEl('button', { text: 'Save', cls: 'mod-cta' });
  saveBtn.style.cssText = 'padding: 6px 14px; border-radius: 6px; font-size: 12px; cursor: pointer;';
  saveBtn.addEventListener('click', async () => {
    if (!name || !prompt) {
      new Notice('Name and prompt are required');
      return;
    }
    tmpl.name = name;
    tmpl.prompt = prompt;
    tmpl.icon = icon;
    tmpl.category = category;
    tmpl.showInToolbar = showInToolbar;
    if (showInToolbar && !tmpl.toolbarOrder) {
      tmpl.toolbarOrder = Math.max(...settings.promptTemplates.map(t => t.toolbarOrder || 0), 0) + 10;
    }
    await saveSettings();
    rerender();
    new Notice('Prompt saved');
  });

  // Focus name input for new templates
  if (!tmpl.name) setTimeout(() => nameInput.focus(), 50);
  else setTimeout(() => promptEl.focus(), 50);
}

function createPmActionBtn(parent: HTMLElement, title: string, iconName: string): HTMLElement {
  const btn = parent.createEl('button', { cls: 'ag-pm-action-btn', title });
  setIcon(btn, iconName);
  return btn;
}
