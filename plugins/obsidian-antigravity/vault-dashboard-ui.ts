/**
 * Vault Dashboard UI — modal showing vault health, activity, and next actions.
 * Extracted from main.ts for maintainability.
 */

import { App, Modal, TFile, setIcon } from 'obsidian';
import type { AntigravitySettings } from './settings';
import { ChatView, VIEW_TYPE_CHAT } from './chat-view';
import { Notice } from 'obsidian';

export function showVaultDashboard(
  app: App,
  settings: AntigravitySettings,
  activateView: () => Promise<void>,
) {
  const vault = app.vault;
  const metadataCache = app.metadataCache;

  // Parse exclude folders
  const excludeList = (settings.excludeFolders || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  const shouldExclude = (path: string) => {
    const parts = path.toLowerCase().split('/');
    return parts.some(p => excludeList.includes(p));
  };

  const mdFiles = vault.getMarkdownFiles().filter(f => !shouldExclude(f.path));

  // ── Data Collection ──
  const now = Date.now();
  const ONE_DAY = 86_400_000;
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const weekAgo = now - 7 * ONE_DAY;

  // Today's activity
  const todayCreated = mdFiles.filter(f => f.stat.ctime >= todayStart);
  const todayModified = mdFiles.filter(f => f.stat.mtime >= todayStart && f.stat.ctime < todayStart);
  const weekCreated = mdFiles.filter(f => f.stat.ctime >= weekAgo);

  // Stale notes (> 30 days untouched)
  const staleNotes = mdFiles.filter(f => f.stat.mtime < now - 30 * ONE_DAY);

  // Link analysis
  const resolvedLinks = metadataCache.resolvedLinks;
  const incomingCounts = new Map<string, number>();
  const outgoingCounts = new Map<string, number>();
  let totalLinks = 0;

  for (const [source, targets] of Object.entries(resolvedLinks)) {
    const targetMap = targets as Record<string, number>;
    const outCount = Object.values(targetMap).reduce((a, b) => a + b, 0);
    outgoingCounts.set(source, outCount);
    totalLinks += outCount;
    for (const [target, count] of Object.entries(targetMap)) {
      incomingCounts.set(target, (incomingCounts.get(target) || 0) + count);
    }
  }

  const orphans = mdFiles.filter(f => !incomingCounts.has(f.path));

  // Knowledge gaps (unresolved links)
  const unresolvedLinks = app.metadataCache.unresolvedLinks;
  const missingNotes = new Map<string, string[]>();
  for (const [source, targets] of Object.entries(unresolvedLinks)) {
    for (const target of Object.keys(targets as Record<string, number>)) {
      if (!missingNotes.has(target)) missingNotes.set(target, []);
      missingNotes.get(target)!.push(source);
    }
  }
  const topMissing = [...missingNotes.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 5);

  // Tags
  const tagCounts = new Map<string, number>();
  for (const file of mdFiles) {
    const cache = metadataCache.getFileCache(file);
    if (cache?.tags) for (const t of cache.tags) tagCounts.set(t.tag, (tagCounts.get(t.tag) || 0) + 1);
    if (Array.isArray(cache?.frontmatter?.tags)) {
      for (const t of cache.frontmatter.tags) {
        const tag = t.startsWith('#') ? t : `#${t}`;
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    }
  }

  // Health score (0-100)
  const connectedRatio = mdFiles.length > 0 ? (mdFiles.length - orphans.length) / mdFiles.length : 0;
  const linkDensity = mdFiles.length > 0 ? Math.min(totalLinks / mdFiles.length / 3, 1) : 0;
  const freshRatio = mdFiles.length > 0 ? 1 - staleNotes.length / mdFiles.length : 0;
  const tagCoverage = mdFiles.length > 0 ? Math.min(tagCounts.size / (mdFiles.length * 0.3), 1) : 0;
  const healthScore = Math.round((connectedRatio * 40 + linkDensity * 25 + freshRatio * 20 + tagCoverage * 15));
  const healthColor = healthScore >= 70 ? '#4ade80' : healthScore >= 40 ? '#fbbf24' : '#f87171';
  const healthLabel = healthScore >= 70 ? 'Healthy' : healthScore >= 40 ? 'Needs Attention' : 'Critical';

  // ── Build Modal ──
  const modal = new Modal(app);
  modal.titleEl.setText('');
  modal.modalEl.addClass('ag-dashboard-modal');
  const root = modal.contentEl;
  root.empty();
  root.style.cssText = 'max-height: 75vh; overflow-y: auto; padding: 0;';

  // ── Health Ring ──
  const heroEl = root.createDiv({ cls: 'ag-dash-hero' });
  heroEl.style.cssText = 'text-align: center; padding: 24px 16px 16px;';

  const ringSize = 100;
  const ringStroke = 8;
  const radius = (ringSize - ringStroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - healthScore / 100);

  heroEl.innerHTML = `
    <svg width="${ringSize}" height="${ringSize}" style="margin: 0 auto; display: block;">
      <circle cx="${ringSize / 2}" cy="${ringSize / 2}" r="${radius}" fill="none" stroke="var(--background-modifier-border)" stroke-width="${ringStroke}"/>
      <circle cx="${ringSize / 2}" cy="${ringSize / 2}" r="${radius}" fill="none" stroke="${healthColor}" stroke-width="${ringStroke}"
        stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" stroke-linecap="round"
        transform="rotate(-90 ${ringSize / 2} ${ringSize / 2})" style="transition: stroke-dashoffset 0.6s ease;"/>
      <text x="${ringSize / 2}" y="${ringSize / 2 + 8}" text-anchor="middle" fill="${healthColor}" style="font-size: 28px; font-weight: 700;">${healthScore}</text>
    </svg>
    <div style="font-size: 14px; color: ${healthColor}; font-weight: 600; margin-top: 4px;">${healthLabel}</div>
    <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">${mdFiles.length} notes · ${totalLinks} links · ${tagCounts.size} tags</div>
    ${excludeList.length > 0 ? `<div style="font-size: 10px; color: var(--text-faint); margin-top: 2px;">Excluding: ${excludeList.join(', ')}</div>` : ''}
  `;

  // ── 7-Day Activity Spark Line ──
  const sparkData: number[] = [];
  for (let d = 6; d >= 0; d--) {
    const dayStart = todayStart - d * ONE_DAY;
    const dayEnd = dayStart + ONE_DAY;
    const count = mdFiles.filter(f => f.stat.mtime >= dayStart && f.stat.mtime < dayEnd).length;
    sparkData.push(count);
  }
  const sparkMax = Math.max(...sparkData, 1);
  const sparkW = 180;
  const sparkH = 32;
  const sparkPoints = sparkData.map((v, i) => {
    const x = (i / (sparkData.length - 1)) * sparkW;
    const y = sparkH - (v / sparkMax) * (sparkH - 4) - 2;
    return `${x},${y}`;
  }).join(' ');

  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const todayIdx = new Date().getDay(); // 0=Sun
  const orderedLabels: string[] = [];
  for (let d = 6; d >= 0; d--) {
    orderedLabels.push(dayLabels[(todayIdx - d + 7) % 7] || '');
  }

  const sparkEl = heroEl.createDiv();
  sparkEl.style.cssText = 'margin-top: 10px; display: flex; flex-direction: column; align-items: center;';
  sparkEl.innerHTML = `
    <svg width="${sparkW}" height="${sparkH}" style="display: block;">
      <polyline points="${sparkPoints}" fill="none" stroke="${healthColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      ${sparkData.map((v, i) => {
        const x = (i / (sparkData.length - 1)) * sparkW;
        const y = sparkH - (v / sparkMax) * (sparkH - 4) - 2;
        return `<circle cx="${x}" cy="${y}" r="3" fill="${healthColor}" opacity="${i === sparkData.length - 1 ? 1 : 0.5}"/>`;
      }).join('')}
    </svg>
    <div style="display: flex; justify-content: space-between; width: ${sparkW}px; font-size: 9px; color: var(--text-faint); margin-top: 2px;">
      ${orderedLabels.map(l => `<span>${l}</span>`).join('')}
    </div>
  `;

  // ── Today's Activity Card ──
  const activityCard = root.createDiv({ cls: 'ag-dash-card' });
  activityCard.style.cssText = 'margin: 0 16px 12px; padding: 14px; border-radius: 10px; background: var(--background-secondary);';

  const actTitle = activityCard.createDiv();
  actTitle.style.cssText = 'font-weight: 600; font-size: 14px; margin-bottom: 10px;';
  setIcon(actTitle, 'calendar');
  actTitle.createSpan({ text: " Today's Activity" });

  if (todayCreated.length === 0 && todayModified.length === 0) {
    activityCard.createDiv({ text: 'No notes created or edited today.' }).style.cssText = 'color: var(--text-muted); font-size: 13px;';
  } else {
    if (todayCreated.length > 0) {
      const label = activityCard.createDiv({ text: `${todayCreated.length} new` });
      label.style.cssText = 'font-size: 13px; color: #4ade80; margin-bottom: 4px;';
      for (const f of todayCreated.slice(0, 5)) {
        const link = activityCard.createDiv({ text: f.basename });
        link.style.cssText = 'font-size: 12px; padding: 2px 8px; cursor: pointer; color: var(--text-accent); border-radius: 4px;';
        link.addEventListener('click', () => { modal.close(); app.workspace.openLinkText(f.path, '', false); });
        link.addEventListener('mouseenter', () => { link.style.background = 'var(--background-modifier-hover)'; });
        link.addEventListener('mouseleave', () => { link.style.background = ''; });
      }
    }
    if (todayModified.length > 0) {
      const label = activityCard.createDiv({ text: `${todayModified.length} edited` });
      label.style.cssText = 'font-size: 13px; color: #60a5fa; margin: 6px 0 4px;';
      for (const f of todayModified.slice(0, 5)) {
        const link = activityCard.createDiv({ text: f.basename });
        link.style.cssText = 'font-size: 12px; padding: 2px 8px; cursor: pointer; color: var(--text-accent); border-radius: 4px;';
        link.addEventListener('click', () => { modal.close(); app.workspace.openLinkText(f.path, '', false); });
        link.addEventListener('mouseenter', () => { link.style.background = 'var(--background-modifier-hover)'; });
        link.addEventListener('mouseleave', () => { link.style.background = ''; });
      }
    }
  }

  // ── Next Actions Card ──
  const actionsCard = root.createDiv({ cls: 'ag-dash-card' });
  actionsCard.style.cssText = 'margin: 0 16px 12px; padding: 14px; border-radius: 10px; background: var(--background-secondary);';

  const actionsTitle = actionsCard.createDiv();
  actionsTitle.style.cssText = 'font-weight: 600; font-size: 14px; margin-bottom: 10px;';
  setIcon(actionsTitle, 'target');
  actionsTitle.createSpan({ text: ' Suggested Next Actions' });

  const actions: { icon: string; text: string; lucide: boolean; detail: string; onClick: () => void }[] = [];

  // Action: Fill knowledge gaps
  if (topMissing.length > 0) {
    const top = topMissing[0];
    actions.push({
      icon: 'file-plus',
      text: `Create "${top[0]}"`,
      lucide: true,
      detail: `Referenced by ${top[1].length} notes but doesn't exist`,
      onClick: async () => {
        modal.close();
        const path = top[0].endsWith('.md') ? top[0] : `${top[0]}.md`;
        const existing = vault.getAbstractFileByPath(path);
        if (existing) {
          app.workspace.openLinkText(path, '', false);
        } else {
          await vault.create(path, `# ${top[0]}\n\n`);
          app.workspace.openLinkText(path, '', false);
          new Notice(`Created: ${top[0]}`);
        }
      },
    });
  }

  // Action: Link orphans
  if (orphans.length > 0) {
    const top5 = orphans.slice(0, 5).map(f => f.basename).join(', ');
    actions.push({
      icon: 'link',
      text: `Link ${orphans.length} orphan notes`,
      lucide: true,
      detail: `e.g. ${top5}`,
      onClick: async () => {
        modal.close();
        await activateView();
        const chatLeaf = app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
        if (chatLeaf?.view instanceof ChatView) {
          const names = orphans.slice(0, 10).map(f => f.basename).join(', ');
          (chatLeaf.view as ChatView).quickSend(
            `I have ${orphans.length} orphan notes (no incoming links). Help me find connections for these: ${names}. Suggest which existing notes should link to them and draft the [[wikilinks]] I should add.`
          );
        }
      },
    });
  }

  // Action: Review stale notes
  if (staleNotes.length > 10) {
    actions.push({
      icon: 'archive',
      text: `Review ${staleNotes.length} stale notes`,
      lucide: true,
      detail: `Untouched for 30+ days — archive or refresh?`,
      onClick: () => {
        modal.close();
        const staleSorted = staleNotes.sort((a, b) => a.stat.mtime - b.stat.mtime);
        app.workspace.openLinkText(staleSorted[0].path, '', false);
        new Notice(`Oldest untouched: ${staleSorted[0].basename} (${Math.round((now - staleSorted[0].stat.mtime) / ONE_DAY)}d ago)`);
      },
    });
  }

  // Action: Weekly growth
  if (weekCreated.length > 0) {
    actions.push({
      icon: 'trending-up',
      text: `${weekCreated.length} notes this week`,
      lucide: true,
      detail: `Keep going! ${weekCreated.length >= 5 ? 'Great pace!' : 'Try to write more this week.'}`,
      onClick: () => { /* informational */ },
    });
  }

  if (actions.length === 0) {
    actionsCard.createDiv({ text: 'Your vault looks great! No urgent actions.' }).style.cssText = 'color: var(--text-muted); font-size: 13px;';
  }

  for (const action of actions) {
    const row = actionsCard.createDiv({ cls: 'ag-dash-action' });
    row.style.cssText = 'display: flex; align-items: flex-start; gap: 10px; padding: 8px; border-radius: 8px; cursor: pointer; margin-bottom: 4px;';
    row.addEventListener('mouseenter', () => { row.style.background = 'var(--background-modifier-hover)'; });
    row.addEventListener('mouseleave', () => { row.style.background = ''; });
    row.addEventListener('click', action.onClick);

    const iconEl = row.createDiv();
    iconEl.style.cssText = 'flex-shrink: 0; margin-top: 1px; color: var(--text-muted);';
    if (action.lucide) {
      setIcon(iconEl, action.icon);
      const svg = iconEl.querySelector('svg');
      if (svg) { svg.setAttribute('width', '18'); svg.setAttribute('height', '18'); }
    } else {
      iconEl.textContent = action.icon;
      iconEl.style.fontSize = '18px';
    }
    const textCol = row.createDiv();
    textCol.createDiv({ text: action.text }).style.cssText = 'font-size: 13px; font-weight: 500;';
    textCol.createDiv({ text: action.detail }).style.cssText = 'font-size: 11px; color: var(--text-muted); margin-top: 2px;';
  }

  // ── Top Tags (compact) ──
  const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (topTags.length > 0) {
    const tagCard = root.createDiv({ cls: 'ag-dash-card' });
    tagCard.style.cssText = 'margin: 0 16px 12px; padding: 14px; border-radius: 10px; background: var(--background-secondary);';
    const tagTitle = tagCard.createDiv();
    tagTitle.style.cssText = 'font-weight: 600; font-size: 14px; margin-bottom: 10px; display: flex; align-items: center; gap: 6px;';
    setIcon(tagTitle, 'tags');
    tagTitle.createSpan({ text: 'Top Tags' });

    const tagRow = tagCard.createDiv();
    tagRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: 6px;';
    const maxCount = topTags[0][1];
    for (const [tag, count] of topTags) {
      const opacity = 0.4 + 0.6 * (count / maxCount);
      const chip = tagRow.createEl('span', { text: `${tag} ${count}` });
      chip.style.cssText = `font-size: 12px; padding: 3px 10px; border-radius: 12px; background: var(--interactive-accent); color: var(--text-on-accent); opacity: ${opacity}; cursor: pointer;`;
      chip.addEventListener('click', () => {
        modal.close();
        // Open search for tag
        (app as any).internalPlugins?.getPluginById?.('global-search')?.instance?.openGlobalSearch?.(tag);
      });
    }
  }

  // ── AI Analyze Button ──
  const footerEl = root.createDiv();
  footerEl.style.cssText = 'padding: 12px 16px 20px; text-align: center;';

  const aiBtn = footerEl.createEl('button', { text: 'AI Deep Analysis', cls: 'mod-cta' });
  aiBtn.style.cssText = 'width: 100%; border-radius: 8px; padding: 10px;';
  aiBtn.addEventListener('click', async () => {
    modal.close();
    await activateView();
    const chatLeaf = app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
    if (chatLeaf?.view instanceof ChatView) {
      const prompt = [
        `Analyze my Obsidian vault (health score: ${healthScore}/100):`,
        `- ${mdFiles.length} notes, ${totalLinks} links, ${tagCounts.size} tags`,
        `- ${orphans.length} orphan notes (${(orphans.length / mdFiles.length * 100).toFixed(0)}%)`,
        `- ${staleNotes.length} stale notes (30+ days untouched)`,
        topMissing.length > 0 ? `- Knowledge gaps: ${topMissing.map(([n, s]) => `"${n}"(${s.length} refs)`).join(', ')}` : '',
        `- Top tags: ${topTags.slice(0, 5).map(([t, c]) => `${t}(${c})`).join(', ')}`,
        '',
        'Give me 3 specific, actionable improvements. For each one, explain WHY it matters and WHAT to do.',
      ].filter(Boolean).join('\n');
      (chatLeaf.view as ChatView).quickSend(prompt);
    }
  });

  modal.open();
}
