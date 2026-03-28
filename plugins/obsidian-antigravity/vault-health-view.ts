/**
 * Vault Health View — Dashboard for knowledge health metrics.
 *
 * Shows overall vault score, orphan notes, stale content,
 * duplication warnings, knowledge gaps, and split suggestions.
 */

import { ItemView, WorkspaceLeaf, TFile, setIcon, Notice } from 'obsidian';
import type { KnowledgeSteward, VaultHealthReport, NoteHealth } from './knowledge-steward';
import type { KnowledgeEngine } from './knowledge-engine';
import { scanBrokenLinks, applyFix, type BrokenLink } from './broken-link-fixer';
import { analyzeMerge, executeMerge } from './atom-operations';
import type { CopilotCredentials } from './copilot-auth';

export const VIEW_TYPE_VAULT_HEALTH = 'antigravity-vault-health';

export class VaultHealthView extends ItemView {
  private steward: KnowledgeSteward;
  private engine: KnowledgeEngine;
  private rootEl: HTMLElement | null = null;
  private report: VaultHealthReport | null = null;
  private brokenLinks: BrokenLink[] = [];
  private isLoading = false;
  private getCredentials: () => CopilotCredentials | null;
  private onCredentialsRefreshed: (c: CopilotCredentials) => void;

  constructor(
    leaf: WorkspaceLeaf,
    steward: KnowledgeSteward,
    engine: KnowledgeEngine,
    getCredentials: () => CopilotCredentials | null,
    onCredentialsRefreshed: (c: CopilotCredentials) => void,
  ) {
    super(leaf);
    this.steward = steward;
    this.engine = engine;
    this.getCredentials = getCredentials;
    this.onCredentialsRefreshed = onCredentialsRefreshed;
  }

  getViewType() { return VIEW_TYPE_VAULT_HEALTH; }
  getDisplayText() { return 'Vault Health'; }
  getIcon() { return 'heart-pulse'; }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('ag-health-root');
    this.rootEl = container.createDiv({ cls: 'ag-health-container' });
    this.renderEmpty();
  }

  async onClose() {
    this.rootEl = null;
  }

  async runAnalysis() {
    if (this.isLoading) return;
    this.isLoading = true;
    this.renderLoading();

    try {
      this.report = await this.steward.analyze();
      this.brokenLinks = scanBrokenLinks(this.app, this.engine);
      this.renderReport();
    } catch (e) {
      console.warn('[VaultHealth] Analysis failed:', e);
      new Notice('Vault health analysis failed');
      this.renderEmpty();
    } finally {
      this.isLoading = false;
    }
  }

  // ── Rendering ──

  private renderEmpty() {
    if (!this.rootEl) return;
    this.rootEl.empty();

    const empty = this.rootEl.createDiv({ cls: 'ag-health-empty' });
    const icon = empty.createDiv({ cls: 'ag-health-empty-icon' });
    setIcon(icon, 'heart-pulse');
    empty.createDiv({ cls: 'ag-health-empty-text', text: 'Analyze your vault\'s knowledge health' });
    empty.createDiv({ cls: 'ag-health-empty-hint', text: 'Discover orphan notes, broken links, content overlaps, and splitting opportunities. Click below to start.' });

    const btn = empty.createEl('button', { cls: 'ag-health-analyze-btn', text: 'Run Analysis' });
    btn.addEventListener('click', () => this.runAnalysis());
  }

  private renderLoading() {
    if (!this.rootEl) return;
    this.rootEl.empty();
    const loading = this.rootEl.createDiv({ cls: 'ag-health-loading' });
    const spinner = loading.createDiv({ cls: 'ag-health-spinner' });
    loading.createDiv({ text: 'Analyzing vault...' });
  }

  private renderReport() {
    if (!this.rootEl || !this.report) return;
    this.rootEl.empty();
    const r = this.report;

    // Header with score
    const header = this.rootEl.createDiv({ cls: 'ag-health-header' });
    const scoreRing = header.createDiv({ cls: 'ag-health-score-ring' });
    const scoreClass = r.healthScore >= 70 ? 'high' : r.healthScore >= 40 ? 'mid' : 'low';
    scoreRing.addClass(`ag-health-score-${scoreClass}`);
    scoreRing.createSpan({ cls: 'ag-health-score-num', text: `${r.healthScore}` });
    scoreRing.createSpan({ cls: 'ag-health-score-label', text: '/100' });

    const headerInfo = header.createDiv({ cls: 'ag-health-header-info' });
    headerInfo.createDiv({ cls: 'ag-health-title', text: 'Vault Health' });
    const meta = headerInfo.createDiv({ cls: 'ag-health-meta' });
    meta.textContent = `${r.totalNotes} notes · ${r.avgWordCount} avg words · ${r.densityScore} rel/note`;

    // Re-analyze button
    const reBtn = header.createDiv({ cls: 'ag-health-refresh-btn' });
    setIcon(reBtn, 'refresh-cw');
    reBtn.setAttribute('aria-label', 'Re-analyze');
    reBtn.addEventListener('click', () => this.runAnalysis());

    // Action buttons row
    const actionsRow = this.rootEl.createDiv({ cls: 'ag-health-actions-row' });

    const enrichBtn = actionsRow.createEl('button', { cls: 'ag-health-action-btn', text: '' });
    const enrichIcon = enrichBtn.createSpan();
    setIcon(enrichIcon, 'sparkles');
    enrichBtn.createSpan({ text: 'AI Enrich Notes' });
    enrichBtn.addEventListener('click', () => {
      (this.app as any).commands.executeCommandById('antigravity:enrich-notes-ai');
    });

    const rebuildBtn = actionsRow.createEl('button', { cls: 'ag-health-action-btn', text: '' });
    const rebuildIcon = rebuildBtn.createSpan();
    setIcon(rebuildIcon, 'database');
    rebuildBtn.createSpan({ text: 'Rebuild Index' });
    rebuildBtn.addEventListener('click', async () => {
      rebuildBtn.disabled = true;
      new Notice('Rebuilding knowledge index...');
      try {
        await this.engine.initialize();
        new Notice('Knowledge index rebuilt');
        this.runAnalysis();
      } catch (e) {
        new Notice('Rebuild failed: ' + (e as Error).message);
      } finally {
        rebuildBtn.disabled = false;
      }
    });

    // Stats grid
    const statsGrid = this.rootEl.createDiv({ cls: 'ag-health-stats-grid' });
    this.createStatCard(statsGrid, 'file-text', `${r.totalNotes}`, 'Notes', 'Total markdown notes indexed in your vault');
    this.createStatCard(statsGrid, 'alert-circle', `${r.orphanCount}`, 'Orphans', 'Notes with no links or connections — consider linking them');
    this.createStatCard(statsGrid, 'clock', `${r.staleCount}`, 'Stale', 'Notes not updated for a long time and never referenced');
    this.createStatCard(statsGrid, 'copy', `${r.duplications.length}`, 'Overlaps', 'Note pairs with highly similar content — candidates for merging');

    // Role distribution
    const roleSection = this.rootEl.createDiv({ cls: 'ag-health-section' });
    this.createSectionHeader(roleSection, 'layers', 'Role Distribution');
    const roleHelp = roleSection.createDiv({ cls: 'ag-health-help' });
    roleHelp.textContent = '🔹 atom = reusable knowledge unit · 📄 composite = assembled from atoms · 📝 standalone = regular note';
    const roleGrid = roleSection.createDiv({ cls: 'ag-health-role-grid' });
    for (const [role, count] of Object.entries(r.roleDistribution)) {
      const roleItem = roleGrid.createDiv({ cls: `ag-health-role-item ag-health-role-${role}` });
      const emoji = role === 'atom' ? '\u{1F539}' : role === 'composite' ? '\u{1F4C4}' : '\u{1F4DD}';
      roleItem.createSpan({ text: `${emoji} ${role}` });
      roleItem.createSpan({ cls: 'ag-health-role-count', text: `${count}` });
    }

    // Knowledge Network mini-graph
    this.renderNetworkGraph(this.rootEl);

    // Orphan notes
    const orphans = r.noteHealth.filter(n => n.isOrphan);
    if (orphans.length > 0) {
      const section = this.rootEl.createDiv({ cls: 'ag-health-section' });
      this.createSectionHeader(section, 'alert-circle', `Orphan Notes (${orphans.length})`);
      const helpText = section.createDiv({ cls: 'ag-health-help' });
      helpText.textContent = 'These notes have no links to or from other notes. Consider adding [[links]] or #tags to connect them.';
      const list = section.createDiv({ cls: 'ag-health-note-list' });
      for (const n of orphans.slice(0, 8)) {
        this.createNoteItem(list, n, 'No links or meaningful relations');
      }
    }

    // Broken links
    if (this.brokenLinks.length > 0) {
      const section = this.rootEl.createDiv({ cls: 'ag-health-section' });
      this.createSectionHeader(section, 'unlink', `Broken Links (${this.brokenLinks.length})`);
      const helpText = section.createDiv({ cls: 'ag-health-help' });
      helpText.textContent = 'These [[links]] point to notes that don\'t exist. Click "Fix" to replace with a suggested match.';
      const list = section.createDiv({ cls: 'ag-health-broken-list' });
      for (const bl of this.brokenLinks.slice(0, 10)) {
        const item = list.createDiv({ cls: 'ag-health-broken-item' });

        const header = item.createDiv({ cls: 'ag-health-broken-header' });
        header.createSpan({ cls: 'ag-health-broken-link', text: `[[${bl.linkText}]]` });
        header.createSpan({ cls: 'ag-health-broken-sources', text: `in ${bl.sources.length} note${bl.sources.length > 1 ? 's' : ''}` });

        if (bl.suggestions.length > 0) {
          const sugList = item.createDiv({ cls: 'ag-health-broken-suggestions' });
          for (const sug of bl.suggestions.slice(0, 3)) {
            const sugItem = sugList.createDiv({ cls: 'ag-health-broken-sug' });
            const pct = Math.round(sug.similarity * 100);
            sugItem.createSpan({ cls: 'ag-health-broken-sug-name', text: sug.targetName });
            sugItem.createSpan({ cls: 'ag-health-broken-sug-pct', text: `${pct}%` });

            const fixBtn = sugItem.createEl('button', { cls: 'ag-health-broken-fix-btn', text: 'Fix' });
            fixBtn.addEventListener('click', async () => {
              const count = await applyFix(this.app, bl.linkText, sug.targetName, bl.sources);
              new Notice(`Fixed ${count} link${count > 1 ? 's' : ''}: [[${bl.linkText}]] → [[${sug.targetName}]]`);
              // Re-scan broken links and re-render
              this.brokenLinks = scanBrokenLinks(this.app, this.engine);
              this.renderReport();
            });
          }
        } else {
          item.createDiv({ cls: 'ag-health-broken-no-fix', text: 'No suggestions found' });
        }
      }
    }

    // Duplications
    if (r.duplications.length > 0) {
      const section = this.rootEl.createDiv({ cls: 'ag-health-section' });
      this.createSectionHeader(section, 'copy', `Content Overlaps (${r.duplications.length})`);
      const helpText = section.createDiv({ cls: 'ag-health-help' });
      helpText.textContent = 'These note pairs have very similar content. Use "AI Merge" to combine them into one (requires Copilot login).';
      const list = section.createDiv({ cls: 'ag-health-dup-list' });
      for (const dup of r.duplications.slice(0, 8)) {
        const item = list.createDiv({ cls: 'ag-health-dup-item' });
        const nameA = dup.noteA.split('/').pop()?.replace(/\.md$/, '') || dup.noteA;
        const nameB = dup.noteB.split('/').pop()?.replace(/\.md$/, '') || dup.noteB;
        const pct = Math.round(dup.overlapScore * 100);

        const row = item.createDiv({ cls: 'ag-health-dup-row' });
        const linkA = row.createSpan({ cls: 'ag-health-dup-name', text: nameA });
        linkA.addEventListener('click', () => this.openNote(dup.noteA));
        row.createSpan({ cls: 'ag-health-dup-arrow', text: '\u2194' });
        const linkB = row.createSpan({ cls: 'ag-health-dup-name', text: nameB });
        linkB.addEventListener('click', () => this.openNote(dup.noteB));
        row.createSpan({ cls: 'ag-health-dup-pct', text: `${pct}%` });

        if (dup.sharedEntities.length > 0) {
          const chips = item.createDiv({ cls: 'ag-health-dup-chips' });
          for (const e of dup.sharedEntities.slice(0, 5)) {
            chips.createSpan({ cls: 'ag-health-chip', text: e });
          }
        }

        // AI Merge button
        if (this.getCredentials()) {
          const mergeBtn = item.createEl('button', { cls: 'ag-health-merge-btn', text: 'AI Merge' });
          mergeBtn.addEventListener('click', async () => {
            mergeBtn.disabled = true;
            mergeBtn.textContent = 'Analyzing...';
            try {
              const plan = await analyzeMerge(
                this.app, dup.noteA, dup.noteB,
                this.getCredentials, this.onCredentialsRefreshed,
              );
              if (!plan) {
                new Notice('Merge analysis returned no result');
                return;
              }
              new Notice(`Merging into "${plan.title}"...`);
              const mergedPath = await executeMerge(this.app, plan);
              if (mergedPath) {
                new Notice(`Merged! Created "${plan.title}", originals archived.`);
                this.openNote(mergedPath);
                // Re-run analysis
                this.report = await this.steward.analyze();
                this.brokenLinks = scanBrokenLinks(this.app, this.engine);
                this.renderReport();
              }
            } catch (err: any) {
              new Notice(`Merge failed: ${err?.message}`);
            } finally {
              mergeBtn.disabled = false;
              mergeBtn.textContent = 'AI Merge';
            }
          });
        }
      }
    }

    // Knowledge gaps
    if (r.knowledgeGaps.length > 0) {
      const section = this.rootEl.createDiv({ cls: 'ag-health-section' });
      this.createSectionHeader(section, 'search', `Knowledge Gaps (${r.knowledgeGaps.length})`);
      const helpText = section.createDiv({ cls: 'ag-health-help' });
      helpText.textContent = 'Concepts mentioned in multiple notes but without their own dedicated note';
      const list = section.createDiv({ cls: 'ag-health-gap-list' });
      for (const gap of r.knowledgeGaps.slice(0, 10)) {
        const item = list.createDiv({ cls: 'ag-health-gap-item' });
        item.createSpan({ cls: 'ag-health-gap-concept', text: gap.concept });
        item.createSpan({ cls: 'ag-health-gap-count', text: `${gap.mentionCount} notes` });
      }
    }

    // Split suggestions
    if (r.splitSuggestions.length > 0) {
      const section = this.rootEl.createDiv({ cls: 'ag-health-section' });
      this.createSectionHeader(section, 'scissors', `Split Suggestions (${r.splitSuggestions.length})`);
      const helpText = section.createDiv({ cls: 'ag-health-help' });
      helpText.textContent = 'These long notes cover multiple topics and could be split into smaller, reusable atoms. Open a note and use "AI Atom Split" from the command palette.';
      const list = section.createDiv({ cls: 'ag-health-split-list' });
      for (const sug of r.splitSuggestions.slice(0, 6)) {
        const item = list.createDiv({ cls: 'ag-health-split-item' });
        const name = sug.path.split('/').pop()?.replace(/\.md$/, '') || sug.path;
        const nameEl = item.createDiv({ cls: 'ag-health-split-name', text: name });
        nameEl.addEventListener('click', () => this.openNote(sug.path));

        const meta = item.createDiv({ cls: 'ag-health-split-meta' });
        meta.textContent = `${sug.wordCount} words · ${sug.topicCount} topics`;

        const chips = item.createDiv({ cls: 'ag-health-split-topics' });
        for (const topic of sug.topics.slice(0, 5)) {
          chips.createSpan({ cls: 'ag-health-chip', text: topic });
        }
      }
    }

    // Stale notes
    const stale = r.noteHealth.filter(n => n.isStale);
    if (stale.length > 0) {
      const section = this.rootEl.createDiv({ cls: 'ag-health-section' });
      this.createSectionHeader(section, 'clock', `Stale Notes (${stale.length})`);
      const helpText = section.createDiv({ cls: 'ag-health-help' });
      helpText.textContent = 'These notes haven\'t been updated in a while and are not referenced by other notes. They may need review or archiving.';
      const list = section.createDiv({ cls: 'ag-health-note-list' });
      for (const n of stale.slice(0, 6)) {
        this.createNoteItem(list, n, `${n.freshnessDays} days old, never reused`);
      }
    }
  }

  // ── Network Graph ──

  private renderNetworkGraph(parent: HTMLElement) {
    if (!this.report) return;

    const section = parent.createDiv({ cls: 'ag-health-section' });
    this.createSectionHeader(section, 'git-branch', 'Knowledge Network');
    const helpText = section.createDiv({ cls: 'ag-health-help' });
    helpText.textContent = 'Visual map of your notes and their connections. Click any node to open that note. Blue = atom, amber = composite, gray = standalone.';

    const WIDTH = 300;
    const HEIGHT = 220;
    const canvas = section.createDiv({ cls: 'ag-health-network' });

    // Build graph data from engine profiles and relations
    const profiles = Object.values(this.report.noteHealth);
    let allPaths = profiles.map(n => n.path);
    if (allPaths.length === 0) return;

    // Cap at 100 nodes to prevent O(n²) force simulation from freezing UI
    const MAX_GRAPH_NODES = 100;
    if (allPaths.length > MAX_GRAPH_NODES) {
      // Prioritize notes with more connections
      allPaths.sort((a, b) => {
        const pa = this.engine.getProfile(a);
        const pb = this.engine.getProfile(b);
        return ((pb?.outLinks.length || 0) + (pb?.outEmbeds.length || 0))
             - ((pa?.outLinks.length || 0) + (pa?.outEmbeds.length || 0));
      });
      allPaths = allPaths.slice(0, MAX_GRAPH_NODES);
    }

    // Deterministic seeded random (based on note count for stability)
    let seed = allPaths.length * 2654435761;
    function seededRandom(): number {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    }

    // Get relations from the engine
    type NodeData = { path: string; x: number; y: number; vx: number; vy: number; role: string };
    type EdgeData = { source: number; target: number; score: number };

    const nodes: NodeData[] = [];
    const edges: EdgeData[] = [];
    const pathIndex = new Map<string, number>();

    for (let i = 0; i < allPaths.length; i++) {
      const profile = this.engine.getProfile(allPaths[i]);
      const role = profile?.role || 'standalone';
      nodes.push({
        path: allPaths[i],
        x: WIDTH / 2 + (seededRandom() - 0.5) * WIDTH * 0.7,
        y: HEIGHT / 2 + (seededRandom() - 0.5) * HEIGHT * 0.7,
        vx: 0, vy: 0,
        role,
      });
      pathIndex.set(allPaths[i], i);
    }

    // Collect edges from profiles' outLinks
    for (let i = 0; i < allPaths.length; i++) {
      const profile = this.engine.getProfile(allPaths[i]);
      if (!profile) continue;
      for (const link of profile.outLinks) {
        const j = pathIndex.get(link);
        if (j !== undefined && j !== i) {
          edges.push({ source: i, target: j, score: 0.5 });
        }
      }
      for (const embed of profile.outEmbeds) {
        const j = pathIndex.get(embed);
        if (j !== undefined && j !== i) {
          edges.push({ source: i, target: j, score: 0.8 });
        }
      }
    }

    // Simple force simulation (10 iterations)
    for (let iter = 0; iter < 30; iter++) {
      // Repulsion between all pairs
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          let dx = nodes[j].x - nodes[i].x;
          let dy = nodes[j].y - nodes[i].y;
          const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
          const force = 300 / (dist * dist);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          nodes[i].vx -= fx; nodes[i].vy -= fy;
          nodes[j].vx += fx; nodes[j].vy += fy;
        }
      }
      // Attraction along edges
      for (const edge of edges) {
        const a = nodes[edge.source];
        const b = nodes[edge.target];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const force = (dist - 40) * 0.02;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
      // Center gravity
      for (const node of nodes) {
        node.vx += (WIDTH / 2 - node.x) * 0.005;
        node.vy += (HEIGHT / 2 - node.y) * 0.005;
        node.x += node.vx * 0.3;
        node.y += node.vy * 0.3;
        node.vx *= 0.85;
        node.vy *= 0.85;
        // Clamp to bounds
        node.x = Math.max(12, Math.min(WIDTH - 12, node.x));
        node.y = Math.max(12, Math.min(HEIGHT - 12, node.y));
      }
    }

    // Render as SVG
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', `${WIDTH}`);
    svg.setAttribute('height', `${HEIGHT}`);
    svg.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`);
    svg.classList.add('ag-health-network-svg');

    // Edges
    for (const edge of edges) {
      const a = nodes[edge.source];
      const b = nodes[edge.target];
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', `${a.x}`);
      line.setAttribute('y1', `${a.y}`);
      line.setAttribute('x2', `${b.x}`);
      line.setAttribute('y2', `${b.y}`);
      line.setAttribute('stroke', 'var(--text-faint)');
      line.setAttribute('stroke-width', `${edge.score > 0.6 ? '1.5' : '0.8'}`);
      line.setAttribute('stroke-opacity', '0.4');
      svg.appendChild(line);
    }

    // Nodes
    for (const node of nodes) {
      const circle = document.createElementNS(svgNS, 'circle');
      circle.setAttribute('cx', `${node.x}`);
      circle.setAttribute('cy', `${node.y}`);
      const radius = node.role === 'atom' ? 4 : node.role === 'composite' ? 6 : 5;
      circle.setAttribute('r', `${radius}`);
      const color = node.role === 'atom' ? 'var(--text-accent)' : node.role === 'composite' ? '#f59e0b' : 'var(--text-muted)';
      circle.setAttribute('fill', color);
      circle.setAttribute('stroke', 'var(--background-primary)');
      circle.setAttribute('stroke-width', '1');
      circle.style.cursor = 'pointer';

      // Tooltip
      const title = document.createElementNS(svgNS, 'title');
      const name = node.path.split('/').pop()?.replace(/\.md$/, '') || node.path;
      title.textContent = `${name} (${node.role})`;
      circle.appendChild(title);

      circle.addEventListener('click', () => this.openNote(node.path));
      svg.appendChild(circle);
    }

    canvas.appendChild(svg);

    // Legend
    const legend = section.createDiv({ cls: 'ag-health-network-legend' });
    const items = [
      { color: 'var(--text-accent)', label: 'Atom' },
      { color: '#f59e0b', label: 'Composite' },
      { color: 'var(--text-muted)', label: 'Standalone' },
    ];
    for (const item of items) {
      const el = legend.createSpan({ cls: 'ag-health-legend-item' });
      const dot = el.createSpan({ cls: 'ag-health-legend-dot' });
      dot.style.backgroundColor = item.color;
      el.createSpan({ text: item.label });
    }
  }

  // ── UI Helpers ──

  private createSectionHeader(parent: HTMLElement, iconName: string, title: string) {
    const header = parent.createDiv({ cls: 'ag-health-section-header' });
    const icon = header.createSpan();
    setIcon(icon, iconName);
    const svg = icon.querySelector('svg');
    if (svg) { svg.setAttribute('width', '13'); svg.setAttribute('height', '13'); }
    header.createSpan({ text: title });
  }

  private createStatCard(parent: HTMLElement, iconName: string, value: string, label: string, tooltip?: string) {
    const card = parent.createDiv({ cls: 'ag-health-stat-card' });
    if (tooltip) card.setAttribute('aria-label', tooltip);
    const iconEl = card.createSpan({ cls: 'ag-health-stat-icon' });
    setIcon(iconEl, iconName);
    const svg = iconEl.querySelector('svg');
    if (svg) { svg.setAttribute('width', '14'); svg.setAttribute('height', '14'); }
    card.createSpan({ cls: 'ag-health-stat-value', text: value });
    card.createSpan({ cls: 'ag-health-stat-label', text: label });
  }

  private createNoteItem(parent: HTMLElement, note: NoteHealth, detail: string) {
    const item = parent.createDiv({ cls: 'ag-health-note-item' });
    const name = note.path.split('/').pop()?.replace(/\.md$/, '') || note.path;
    const nameEl = item.createSpan({ cls: 'ag-health-note-name', text: name });
    nameEl.addEventListener('click', () => this.openNote(note.path));
    item.createSpan({ cls: 'ag-health-note-detail', text: detail });
  }

  private openNote(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      this.app.workspace.getLeaf(false).openFile(file);
    }
  }
}
