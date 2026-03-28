/**
 * Related Notes View — Sidebar panel showing
 * knowledge relationships for the active note.
 */

import { ItemView, WorkspaceLeaf, TFile, setIcon, Notice, MarkdownView } from 'obsidian';
import type { Relationship, NoteProfile, KnowledgeEngine } from './knowledge-engine';
import type { AtomSuggestions } from './atomization-manager';

export const VIEW_TYPE_RELATED = 'antigravity-related-notes';

export class RelatedNotesView extends ItemView {
  private engine: KnowledgeEngine;
  private rootEl: HTMLElement | null = null;
  private currentPath: string | null = null;
  private profileCollapsed = false;
  private currentSuggestions: AtomSuggestions | null = null;

  // ── Callbacks wired by plugin ──
  /** Callback for executing atom split from suggestion UI */
  onExecuteSplit: ((filePath: string) => void) | null = null;
  /** Callback for executing atom merge from suggestion UI */
  onExecuteMerge: ((pathA: string, pathB: string) => void) | null = null;
  /** Callback for executing atom upgrade from suggestion UI */
  onExecuteUpgrade: ((filePath: string) => void) | null = null;
  /** Callback for AI-enriching the current note */
  onEnrichNote: ((filePath: string) => void) | null = null;
  /** Callback for dismissing suggestions (persisted) */
  onDismissSuggestions: ((filePath: string) => void) | null = null;
  /** Whether Copilot credentials are available */
  copilotConnected = false;
  /** Onboarding step (0 = show welcome, 1+ = dismiss) */
  onboardingStep = 0;
  /** Callback to persist onboarding step */
  onOnboardingAdvance: ((step: number) => void) | null = null;

  constructor(leaf: WorkspaceLeaf, engine: KnowledgeEngine) {
    super(leaf);
    this.engine = engine;
  }

  getViewType() { return VIEW_TYPE_RELATED; }
  getDisplayText() { return 'Related Notes'; }
  getIcon() { return 'link'; }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('ag-related-root');

    this.rootEl = container.createDiv({ cls: 'ag-rel-container' });
    this.renderEmpty();

    // Listen for active file changes
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => this.onActiveFileChanged())
    );

    // Initial render
    this.onActiveFileChanged();
  }

  async onClose() {
    this.rootEl = null;
  }

  /** Called when the engine updates relations for a path */
  onRelationsUpdated(path: string) {
    if (path === this.currentPath) {
      this.renderRelations();
    }
  }

  /** Called when atomization auto-trigger produces suggestions */
  onAtomSuggestions(path: string, suggestions: AtomSuggestions) {
    if (path === this.currentPath) {
      this.currentSuggestions = suggestions;
      this.renderRelations();
    }
  }

  private onActiveFileChanged() {
    const file = this.app.workspace.getActiveFile();
    if (file?.extension === 'md') {
      if (file.path !== this.currentPath) {
        this.currentPath = file.path;
        this.currentSuggestions = null; // clear when switching notes
        this.renderRelations();
      }
    }
  }

  private renderEmpty() {
    if (!this.rootEl) return;
    this.rootEl.empty();
    const emptyEl = this.rootEl.createDiv({ cls: 'ag-rel-empty' });
    const iconEl = emptyEl.createDiv({ cls: 'ag-rel-empty-icon' });
    setIcon(iconEl, 'link');
    emptyEl.createDiv({ cls: 'ag-rel-empty-text', text: 'Open a note to see related notes' });
    emptyEl.createDiv({ cls: 'ag-rel-empty-hint', text: 'The engine will analyze links, tags, and content to find connections across your vault.' });

    // Onboarding hint for new users
    if (this.onboardingStep === 0) {
      const onboarding = emptyEl.createDiv({ cls: 'ag-rel-onboarding' });
      onboarding.createDiv({ cls: 'ag-rel-onboarding-title', text: 'Welcome to Antigravity' });
      onboarding.createDiv({ cls: 'ag-rel-onboarding-text', text: 'This sidebar shows related notes based on links, tags, and content analysis. Open any markdown note to get started.\n\nFor AI-powered features (Enrich, Split, Merge, Upgrade), connect GitHub Copilot in the plugin settings.' });
      const dismissBtn = onboarding.createEl('button', { text: 'Got it', cls: 'ag-rel-onboarding-btn' });
      dismissBtn.addEventListener('click', () => {
        this.onboardingStep = 1;
        if (this.onOnboardingAdvance) this.onOnboardingAdvance(1);
        this.renderEmpty();
      });
    }
  }

  private renderRelations() {
    if (!this.rootEl || !this.currentPath) return;
    this.rootEl.empty();

    const relations = this.engine.getRelations(this.currentPath);
    const profile = this.engine.getProfile(this.currentPath);
    const stats = this.engine.getStats();

    // Header
    const header = this.rootEl.createDiv({ cls: 'ag-rel-header' });
    const titleRow = header.createDiv({ cls: 'ag-rel-title-row' });
    const titleIcon = titleRow.createSpan({ cls: 'ag-rel-title-icon' });
    setIcon(titleIcon, 'brain');
    titleRow.createSpan({ cls: 'ag-rel-title-text', text: 'Related Notes' });

    if (relations.length > 0) {
      const countBadge = titleRow.createSpan({ cls: 'ag-rel-count-badge' });
      countBadge.textContent = `${relations.length}`;
    }

    // Current note name display
    const currentName = this.currentPath.split('/').pop()?.replace(/\.md$/, '') || '';
    const currentEl = header.createDiv({ cls: 'ag-rel-current-note' });
    const currentIcon = currentEl.createSpan();
    setIcon(currentIcon, 'file-text');
    const svg = currentIcon.querySelector('svg');
    if (svg) { svg.setAttribute('width', '12'); svg.setAttribute('height', '12'); }
    currentEl.createSpan({ text: currentName });

    if (relations.length === 0) {
      const emptyEl = this.rootEl.createDiv({ cls: 'ag-rel-no-results' });
      const emptyIcon = emptyEl.createDiv({ cls: 'ag-rel-empty-icon' });
      setIcon(emptyIcon, 'search');
      emptyEl.createDiv({ cls: 'ag-rel-no-results-text', text: 'No related notes found' });

      // AI Actions panel for empty state
      const actionsEl = emptyEl.createDiv({ cls: 'ag-rel-ai-actions' });
      actionsEl.createDiv({ cls: 'ag-rel-ai-actions-title', text: 'AI Actions' });

      // AI Enrich
      const enrichBtn = actionsEl.createDiv({ cls: 'ag-rel-ai-action-btn' });
      const enrichIcon = enrichBtn.createSpan({ cls: 'ag-rel-ai-action-icon' });
      setIcon(enrichIcon, 'sparkles');
      enrichBtn.createSpan({ text: 'AI Enrich Notes' });
      enrichBtn.createDiv({ cls: 'ag-rel-ai-action-desc', text: 'Use AI to discover hidden connections and generate tags, summaries, and links' });
      enrichBtn.addEventListener('click', () => {
        (this.app as any).commands.executeCommandById('obsidian-antigravity:enrich-notes-ai');
      });

      // AI Atom Split
      const splitBtn = actionsEl.createDiv({ cls: 'ag-rel-ai-action-btn' });
      const splitIcon = splitBtn.createSpan({ cls: 'ag-rel-ai-action-icon' });
      setIcon(splitIcon, 'scissors');
      splitBtn.createSpan({ text: 'AI Atom Split' });
      splitBtn.createDiv({ cls: 'ag-rel-ai-action-desc', text: 'Split this note into smaller atomic knowledge notes' });
      splitBtn.addEventListener('click', () => {
        (this.app as any).commands.executeCommandById('obsidian-antigravity:atom-split');
      });

      // Translate
      const translateBtn = actionsEl.createDiv({ cls: 'ag-rel-ai-action-btn' });
      const translateIcon = translateBtn.createSpan({ cls: 'ag-rel-ai-action-icon' });
      setIcon(translateIcon, 'languages');
      translateBtn.createSpan({ text: 'Translate Note' });
      translateBtn.createDiv({ cls: 'ag-rel-ai-action-desc', text: 'View this note in another language' });
      translateBtn.addEventListener('click', () => {
        (this.app as any).commands.executeCommandById('obsidian-antigravity:toggle-translation-reader');
      });

      // Vault Health
      const healthBtn = actionsEl.createDiv({ cls: 'ag-rel-ai-action-btn' });
      const healthIcon = healthBtn.createSpan({ cls: 'ag-rel-ai-action-icon' });
      setIcon(healthIcon, 'activity');
      healthBtn.createSpan({ text: 'Vault Health Check' });
      healthBtn.createDiv({ cls: 'ag-rel-ai-action-desc', text: 'Analyze vault structure, orphans, and knowledge gaps' });
      healthBtn.addEventListener('click', () => {
        (this.app as any).commands.executeCommandById('obsidian-antigravity:vault-health');
      });

      const hintEl = emptyEl.createDiv({ cls: 'ag-rel-hint' });
      hintEl.textContent = 'You can also add [[links]] and #tags to create connections manually.';
      this.renderStats(stats);
      return;
    }

    // Relations list with staggered animation
    const listEl = this.rootEl.createDiv({ cls: 'ag-rel-list' });

    relations.forEach((rel, index) => {
      const item = listEl.createDiv({ cls: 'ag-rel-item' });
      item.style.animationDelay = `${index * 40}ms`;

      item.addEventListener('click', () => {
        const file = this.app.vault.getAbstractFileByPath(rel.target);
        if (file instanceof TFile) {
          this.app.workspace.getLeaf(false).openFile(file);
        }
      });

      // Score ring (circular indicator)
      const scorePercent = Math.min(Math.round(rel.score * 100), 100);
      const scoreRing = item.createDiv({ cls: 'ag-rel-score-ring' });
      const scoreColorClass = scorePercent >= 70 ? 'high' : scorePercent >= 40 ? 'mid' : 'low';
      scoreRing.addClass(`ag-rel-score-${scoreColorClass}`);
      scoreRing.createSpan({ cls: 'ag-rel-score-num', text: `${scorePercent}` });

      // Content
      const content = item.createDiv({ cls: 'ag-rel-item-content' });

      // Top row: name + type badge
      const nameRow = content.createDiv({ cls: 'ag-rel-item-name-row' });
      const basename = rel.target.split('/').pop()?.replace(/\.md$/, '') || rel.target;
      const nameEl = nameRow.createSpan({ cls: 'ag-rel-item-name', text: basename });

      if (rel.type === 'explicit') {
        const badge = nameRow.createSpan({ cls: 'ag-rel-type-badge ag-rel-type-explicit' });
        setIcon(badge, 'link');
      } else {
        const badge = nameRow.createSpan({ cls: 'ag-rel-type-badge ag-rel-type-inferred' });
        setIcon(badge, 'sparkles');
      }

      // Role badge
      const targetProfile = this.engine.getProfile(rel.target);
      if (targetProfile && targetProfile.role !== 'standalone') {
        const roleLabel = targetProfile.role === 'atom' ? '\u{1F539}' : '\u{1F4C4}';
        const roleBadge = nameRow.createSpan({
          cls: `ag-rel-role-badge ag-rel-role-${targetProfile.role}`,
          text: roleLabel,
        });
        if (targetProfile.reuseCount > 0) {
          roleBadge.setAttribute('aria-label', `${targetProfile.role} \u00B7 reused ${targetProfile.reuseCount}\u00D7`);
        }
      }

      // Folder path
      const folder = rel.target.split('/').slice(0, -1).join('/');
      if (folder) {
        const folderEl = content.createDiv({ cls: 'ag-rel-item-folder' });
        const folderIcon = folderEl.createSpan();
        setIcon(folderIcon, 'folder');
        const fSvg = folderIcon.querySelector('svg');
        if (fSvg) { fSvg.setAttribute('width', '10'); fSvg.setAttribute('height', '10'); }
        folderEl.createSpan({ text: folder });
      }

      // Signal chips
      const signalsEl = content.createDiv({ cls: 'ag-rel-signals' });
      const s = rel.signals;

      if (s.linkDistance === 1) {
        this.createSignalChip(signalsEl, 'direct link', 'link', 'link', 'These notes are directly linked with [[link]]');
      } else if (s.linkDistance === 2) {
        this.createSignalChip(signalsEl, '2-hop', 'git-branch', 'hop', 'These notes are connected through an intermediate note');
      }

      if (s.embedDistance === 1) {
        this.createSignalChip(signalsEl, 'embed', 'file-symlink', 'embed', 'One note embeds the other with ![[embed]]');
      }

      if (s.sharedTags && s.sharedTags > 0) {
        this.createSignalChip(signalsEl, `${s.sharedTags} tag${s.sharedTags > 1 ? 's' : ''}`, 'tag', 'tag', `${s.sharedTags} shared #tag${s.sharedTags > 1 ? 's' : ''} between these notes`);
      }

      if (s.entityOverlap && s.entityOverlap > 0) {
        this.createSignalChip(signalsEl, `${s.entityOverlap} concept${s.entityOverlap > 1 ? 's' : ''}`, 'box', 'entity', `${s.entityOverlap} shared concept${s.entityOverlap > 1 ? 's' : ''} (names, terms, key ideas)`);
      }

      if (s.tokenSim && s.tokenSim > 0.1) {
        this.createSignalChip(signalsEl, `${Math.round(s.tokenSim * 100)}%`, 'text', 'token', `${Math.round(s.tokenSim * 100)}% word similarity based on content analysis`);
      }

      if (s.titleSim && s.titleSim > 0.1) {
        this.createSignalChip(signalsEl, 'title', 'type', 'title', 'These notes have similar titles');
      }

      // Insert Link button (appears on hover)
      const insertBtn = item.createDiv({ cls: 'ag-rel-insert-btn' });
      const insertIcon = insertBtn.createSpan();
      setIcon(insertIcon, 'link');
      const iSvg = insertIcon.querySelector('svg');
      if (iSvg) { iSvg.setAttribute('width', '12'); iSvg.setAttribute('height', '12'); }
      insertBtn.createSpan({ text: 'Insert' });
      insertBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.insertLinkAtCursor(basename);
      });

      // Hover tooltip
      item.setAttribute('aria-label', this.buildTooltip(rel));
    });

    // Atom suggestions section (auto-trigger): split + merge + upgrade
    if (this.currentSuggestions && !this.currentSuggestions.dismissed) {
      const s = this.currentSuggestions;
      const hasSplit = s.splitPlan && s.splitPlan.atoms.length > 0;
      const hasMerge = s.mergeCandidates && s.mergeCandidates.length > 0;
      const hasUpgrade = s.upgradeAvailable;
      if (hasSplit || hasMerge || hasUpgrade) {
        this.renderAtomSuggestions(this.currentSuggestions);
      }
    }

    // Quick Actions bar
    if (this.currentPath) {
      this.renderQuickActions();
    }

    // Copilot hint (no-AI degradation)
    if (!this.copilotConnected) {
      this.renderCopilotHint();
    }

    // Profile section (collapsible)
    if (profile) {
      this.renderProfile(profile);
    }

    // Stats
    this.renderStats(stats);
  }

  private renderAtomSuggestions(suggestions: AtomSuggestions) {
    if (!this.rootEl || !this.currentPath) return;
    const section = this.rootEl.createDiv({ cls: 'ag-rel-suggestions' });

    // ── Split suggestions ──
    const plan = suggestions.splitPlan;
    if (plan && plan.atoms.length > 0) {
      const splitSection = section.createDiv({ cls: 'ag-rel-suggestions-group' });
      const header = splitSection.createDiv({ cls: 'ag-rel-suggestions-header' });
      const headerIcon = header.createSpan({ cls: 'ag-rel-suggestions-icon' });
      setIcon(headerIcon, 'scissors');
      const svg = headerIcon.querySelector('svg');
      if (svg) { svg.setAttribute('width', '14'); svg.setAttribute('height', '14'); }
      header.createSpan({ text: `Split Suggestion (${plan.atoms.length} atoms)` });

      const helpText = splitSection.createDiv({ cls: 'ag-rel-suggestions-help' });
      helpText.textContent = 'AI detected multiple topics in this knowledge note:';

      const list = splitSection.createDiv({ cls: 'ag-rel-suggestions-list' });
      for (const atom of plan.atoms) {
        const item = list.createDiv({ cls: 'ag-rel-suggestion-item' });
        const icon = item.createSpan({ cls: 'ag-rel-suggestion-atom-icon' });
        icon.textContent = '\u{1F539}';
        const info = item.createDiv({ cls: 'ag-rel-suggestion-info' });
        info.createDiv({ cls: 'ag-rel-suggestion-title', text: atom.title });
        const meta = info.createDiv({ cls: 'ag-rel-suggestion-meta' });
        const lineCount = atom.endLine - atom.startLine + 1;
        meta.textContent = `Lines ${atom.startLine}\u2013${atom.endLine} (${lineCount} lines)`;
        if (atom.tags.length > 0) {
          meta.textContent += ` \u00B7 ${atom.tags.map((t: string) => '#' + t).join(' ')}`;
        }
      }

      const splitBtn = splitSection.createEl('button', { text: 'Execute Split', cls: 'mod-cta ag-rel-suggestion-btn' });
      splitBtn.addEventListener('click', () => {
        if (this.onExecuteSplit && this.currentPath) {
          this.onExecuteSplit(this.currentPath);
        }
      });
    }

    // ── Merge candidates ──
    if (suggestions.mergeCandidates && suggestions.mergeCandidates.length > 0) {
      const mergeSection = section.createDiv({ cls: 'ag-rel-suggestions-group' });
      const header = mergeSection.createDiv({ cls: 'ag-rel-suggestions-header' });
      const headerIcon = header.createSpan({ cls: 'ag-rel-suggestions-icon' });
      setIcon(headerIcon, 'merge');
      const svg = headerIcon.querySelector('svg');
      if (svg) { svg.setAttribute('width', '14'); svg.setAttribute('height', '14'); }
      header.createSpan({ text: `Merge Candidates (${suggestions.mergeCandidates.length})` });

      const helpText = mergeSection.createDiv({ cls: 'ag-rel-suggestions-help' });
      helpText.textContent = 'High content overlap detected with other notes:';

      for (const mc of suggestions.mergeCandidates) {
        const item = mergeSection.createDiv({ cls: 'ag-rel-suggestion-item' });
        const icon = item.createSpan({ cls: 'ag-rel-suggestion-atom-icon' });
        setIcon(icon, 'git-merge');
        const iSvg = icon.querySelector('svg');
        if (iSvg) { iSvg.setAttribute('width', '14'); iSvg.setAttribute('height', '14'); }
        const info = item.createDiv({ cls: 'ag-rel-suggestion-info' });
        const otherPath = mc.pathA === this.currentPath ? mc.pathB : mc.pathA;
        const otherName = otherPath.split('/').pop()?.replace(/\.md$/, '') || otherPath;
        info.createDiv({ cls: 'ag-rel-suggestion-title', text: otherName });
        info.createDiv({ cls: 'ag-rel-suggestion-meta', text: `${Math.round(mc.overlapScore * 100)}% overlap` });

        const mergeBtn = item.createEl('button', { text: 'Merge', cls: 'ag-rel-suggestion-btn ag-rel-suggestion-inline-btn' });
        mergeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.onExecuteMerge) this.onExecuteMerge(mc.pathA, mc.pathB);
        });
      }
    }

    // ── Upgrade available ──
    if (suggestions.upgradeAvailable) {
      const upgradeSection = section.createDiv({ cls: 'ag-rel-suggestions-group' });
      const header = upgradeSection.createDiv({ cls: 'ag-rel-suggestions-header' });
      const headerIcon = header.createSpan({ cls: 'ag-rel-suggestions-icon' });
      setIcon(headerIcon, 'arrow-up-circle');
      const svg = headerIcon.querySelector('svg');
      if (svg) { svg.setAttribute('width', '14'); svg.setAttribute('height', '14'); }
      header.createSpan({ text: 'Upgrade Available' });

      const helpText = upgradeSection.createDiv({ cls: 'ag-rel-suggestions-help' });
      helpText.textContent = 'Related notes contain supplementary information that could enhance this note.';

      const upgradeBtn = upgradeSection.createEl('button', { text: 'Run Upgrade', cls: 'mod-cta ag-rel-suggestion-btn' });
      upgradeBtn.addEventListener('click', () => {
        if (this.onExecuteUpgrade && this.currentPath) this.onExecuteUpgrade(this.currentPath);
      });
    }

    // ── Dismiss all suggestions ──
    const actions = section.createDiv({ cls: 'ag-rel-suggestions-actions' });
    const dismissBtn = actions.createEl('button', { text: 'Dismiss All', cls: 'ag-rel-suggestion-btn' });
    dismissBtn.addEventListener('click', () => {
      if (this.onDismissSuggestions && this.currentPath) {
        this.onDismissSuggestions(this.currentPath);
      }
      this.currentSuggestions = null;
      this.renderRelations();
    });
  }

  /** Quick action buttons for the current note */
  private renderQuickActions() {
    if (!this.rootEl || !this.currentPath) return;

    const bar = this.rootEl.createDiv({ cls: 'ag-rel-quick-actions' });
    bar.createDiv({ cls: 'ag-rel-quick-actions-label', text: 'Quick Actions' });
    const btns = bar.createDiv({ cls: 'ag-rel-quick-actions-row' });

    // AI Enrich
    const enrichBtn = btns.createEl('button', { cls: 'ag-rel-quick-btn', attr: { 'aria-label': 'AI Enrich this note' } });
    const enrichIcon = enrichBtn.createSpan();
    setIcon(enrichIcon, 'sparkles');
    enrichBtn.createSpan({ text: 'Enrich' });
    enrichBtn.addEventListener('click', () => {
      if (this.onEnrichNote && this.currentPath) this.onEnrichNote(this.currentPath);
    });
    if (!this.copilotConnected) enrichBtn.addClass('ag-rel-quick-btn-disabled');

    // Atom Split
    const splitBtn = btns.createEl('button', { cls: 'ag-rel-quick-btn', attr: { 'aria-label': 'AI Atom Split' } });
    const splitIcon = splitBtn.createSpan();
    setIcon(splitIcon, 'scissors');
    splitBtn.createSpan({ text: 'Split' });
    splitBtn.addEventListener('click', () => {
      if (this.currentPath) {
        (this.app as any).commands.executeCommandById('antigravity:atom-split');
      }
    });
    if (!this.copilotConnected) splitBtn.addClass('ag-rel-quick-btn-disabled');

    // Atom Upgrade
    const upgradeBtn = btns.createEl('button', { cls: 'ag-rel-quick-btn', attr: { 'aria-label': 'AI Atom Upgrade' } });
    const upgradeIcon = upgradeBtn.createSpan();
    setIcon(upgradeIcon, 'arrow-up-circle');
    upgradeBtn.createSpan({ text: 'Upgrade' });
    upgradeBtn.addEventListener('click', () => {
      if (this.currentPath) {
        (this.app as any).commands.executeCommandById('antigravity:atom-upgrade');
      }
    });
    if (!this.copilotConnected) upgradeBtn.addClass('ag-rel-quick-btn-disabled');
  }

  /** Shown when Copilot is not connected — no-AI degradation hint */
  private renderCopilotHint() {
    if (!this.rootEl) return;
    const hint = this.rootEl.createDiv({ cls: 'ag-rel-copilot-hint' });
    const hintIcon = hint.createSpan({ cls: 'ag-rel-copilot-hint-icon' });
    setIcon(hintIcon, 'alert-triangle');
    const hintSvg = hintIcon.querySelector('svg');
    if (hintSvg) { hintSvg.setAttribute('width', '14'); hintSvg.setAttribute('height', '14'); }
    const hintText = hint.createDiv();
    hintText.createDiv({ cls: 'ag-rel-copilot-hint-title', text: 'Copilot not connected' });
    hintText.createDiv({ cls: 'ag-rel-copilot-hint-desc', text: 'L0 local analysis is active. Connect GitHub Copilot in settings to enable AI Enrich, Split, Merge, and Upgrade.' });
  }

  private buildTooltip(rel: Relationship): string {
    const s = rel.signals;
    const lines: string[] = [];
    lines.push(`Score: ${Math.round(rel.score * 100)}%`);
    lines.push(`Type: ${rel.type}`);
    if (s.linkDistance) lines.push(`Link: ${s.linkDistance === 1 ? 'direct' : '2-hop'}`);
    if (s.embedDistance) lines.push('Embed: direct');
    if (s.sharedTags) lines.push(`Tags: ${s.sharedTags} shared`);
    if (s.entityOverlap) lines.push(`Concepts: ${s.entityOverlap} overlap`);
    if (s.tokenSim) lines.push(`Content: ${Math.round(s.tokenSim * 100)}% similar`);
    if (s.titleSim) lines.push(`Title: ${Math.round(s.titleSim * 100)}% match`);
    return lines.join('\n');
  }

  private createSignalChip(parent: HTMLElement, text: string, iconName: string, signalType: string, tooltip?: string) {
    const chip = parent.createSpan({ cls: `ag-rel-signal-chip ag-rel-signal-${signalType}` });
    if (tooltip) chip.setAttribute('aria-label', tooltip);
    const chipIcon = chip.createSpan({ cls: 'ag-rel-signal-icon' });
    setIcon(chipIcon, iconName);
    const svg = chipIcon.querySelector('svg');
    if (svg) { svg.setAttribute('width', '10'); svg.setAttribute('height', '10'); }
    chip.createSpan({ text });
  }

  private insertLinkAtCursor(noteName: string) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice('No active editor');
      return;
    }
    const editor = view.editor;
    const cursor = editor.getCursor();
    const linkText = `[[${noteName}]]`;
    editor.replaceRange(linkText, cursor);
    editor.setCursor({ line: cursor.line, ch: cursor.ch + linkText.length });
    new Notice(`Inserted [[${noteName}]]`);
  }

  private renderProfile(profile: NoteProfile) {
    if (!this.rootEl) return;

    const section = this.rootEl.createDiv({ cls: 'ag-rel-profile' });

    // Collapsible header
    const headerEl = section.createDiv({ cls: 'ag-rel-profile-header' });
    const chevron = headerEl.createSpan({ cls: 'ag-rel-profile-chevron' });
    setIcon(chevron, this.profileCollapsed ? 'chevron-right' : 'chevron-down');
    const sSvg = chevron.querySelector('svg');
    if (sSvg) { sSvg.setAttribute('width', '12'); sSvg.setAttribute('height', '12'); }
    headerEl.createSpan({ text: 'Note Profile' });
    headerEl.setAttribute('aria-label', 'Extracted metadata: tags, concepts, and topics identified in this note');

    if (profile.enrichedByAI) {
      const aiBadge = headerEl.createSpan({ cls: 'ag-rel-ai-badge' });
      setIcon(aiBadge, 'sparkles');
      const aiSvg = aiBadge.querySelector('svg');
      if (aiSvg) { aiSvg.setAttribute('width', '10'); aiSvg.setAttribute('height', '10'); }
      aiBadge.createSpan({ text: 'AI' });
    }

    const body = section.createDiv({ cls: 'ag-rel-profile-body' });
    if (this.profileCollapsed) body.addClass('ag-rel-collapsed');

    headerEl.addEventListener('click', () => {
      this.profileCollapsed = !this.profileCollapsed;
      body.toggleClass('ag-rel-collapsed', this.profileCollapsed);
      chevron.empty();
      setIcon(chevron, this.profileCollapsed ? 'chevron-right' : 'chevron-down');
      const svgEl = chevron.querySelector('svg');
      if (svgEl) { svgEl.setAttribute('width', '12'); svgEl.setAttribute('height', '12'); }
    });

    // Word count
    const metaRow = body.createDiv({ cls: 'ag-rel-profile-meta' });
    metaRow.createSpan({ text: `${profile.wordCount} words` });
    metaRow.createSpan({ cls: 'ag-rel-meta-sep', text: '·' });
    metaRow.createSpan({ text: `${profile.outLinks.length} links` });
    metaRow.createSpan({ cls: 'ag-rel-meta-sep', text: '·' });
    metaRow.createSpan({ text: `${profile.entities.length} concepts` });    metaRow.createSpan({ cls: 'ag-rel-meta-sep', text: '\u00B7' });
    const roleLabel = profile.role === 'atom' ? '\u{1F539} atom' : profile.role === 'composite' ? '\u{1F4C4} composite' : '\u{1F4DD} standalone';
    metaRow.createSpan({ text: roleLabel });
    if (profile.reuseCount > 0) {
      metaRow.createSpan({ cls: 'ag-rel-meta-sep', text: '\u00B7' });
      metaRow.createSpan({ cls: 'ag-rel-reuse-count', text: `reused ${profile.reuseCount}\u00D7` });
    }
    if (profile.tags.length > 0) {
      const tagsRow = body.createDiv({ cls: 'ag-rel-profile-row' });
      tagsRow.createSpan({ cls: 'ag-rel-profile-label', text: 'Tags' });
      const tagsChips = tagsRow.createDiv({ cls: 'ag-rel-chips' });
      for (const tag of profile.tags.slice(0, 8)) {
        tagsChips.createSpan({ cls: 'ag-rel-chip ag-rel-chip-tag', text: `#${tag}` });
      }
    }

    if (profile.entities.length > 0) {
      const entRow = body.createDiv({ cls: 'ag-rel-profile-row' });
      entRow.createSpan({ cls: 'ag-rel-profile-label', text: 'Concepts' });
      const entChips = entRow.createDiv({ cls: 'ag-rel-chips' });
      for (const ent of profile.entities.slice(0, 8)) {
        entChips.createSpan({ cls: 'ag-rel-chip ag-rel-chip-entity', text: ent });
      }
    }

    if (profile.topics.length > 0) {
      const topicRow = body.createDiv({ cls: 'ag-rel-profile-row' });
      topicRow.createSpan({ cls: 'ag-rel-profile-label', text: 'Topics' });
      const topicChips = topicRow.createDiv({ cls: 'ag-rel-chips' });
      for (const topic of profile.topics.slice(0, 5)) {
        topicChips.createSpan({ cls: 'ag-rel-chip ag-rel-chip-topic', text: topic });
      }
    }
  }

  private renderStats(stats: { totalNotes: number; totalRelations: number; indexTokens: number; indexEntities: number; enrichedNotes?: number }) {
    if (!this.rootEl) return;
    const statsEl = this.rootEl.createDiv({ cls: 'ag-rel-stats' });

    const statsLabel = statsEl.createDiv({ cls: 'ag-rel-stats-label' });
    statsLabel.textContent = 'Index Overview';

    const statsGrid = statsEl.createDiv({ cls: 'ag-rel-stats-grid' });
    this.createStatItem(statsGrid, 'file-text', `${stats.totalNotes}`, 'notes', 'Total indexed notes in your vault');
    this.createStatItem(statsGrid, 'link', `${stats.totalRelations}`, 'relations', 'Discovered connections between notes');
    this.createStatItem(statsGrid, 'text', `${stats.indexTokens}`, 'tokens', 'Unique words tracked for content similarity');
    this.createStatItem(statsGrid, 'box', `${stats.indexEntities}`, 'concepts', 'Key concepts identified across notes');
    if (stats.enrichedNotes && stats.enrichedNotes > 0) {
      this.createStatItem(statsGrid, 'sparkles', `${stats.enrichedNotes}`, 'AI-enriched', 'Notes enhanced by AI analysis');
    }
  }

  private createStatItem(parent: HTMLElement, iconName: string, value: string, label: string, tooltip?: string) {
    const item = parent.createDiv({ cls: 'ag-rel-stat-item' });
    if (tooltip) item.setAttribute('aria-label', tooltip);
    const iconEl = item.createSpan({ cls: 'ag-rel-stat-icon' });
    setIcon(iconEl, iconName);
    const svg = iconEl.querySelector('svg');
    if (svg) { svg.setAttribute('width', '11'); svg.setAttribute('height', '11'); }
    item.createSpan({ cls: 'ag-rel-stat-value', text: value });
    item.createSpan({ cls: 'ag-rel-stat-label', text: label });
  }
}
