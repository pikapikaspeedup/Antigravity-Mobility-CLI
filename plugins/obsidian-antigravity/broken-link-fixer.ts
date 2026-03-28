/**
 * Broken Link Fixer — Detect unresolved [[links]] and suggest fixes.
 *
 * Uses Obsidian's unresolvedLinks + fuzzy title matching + entity overlap
 * from KnowledgeEngine to suggest the best replacement for each broken link.
 */

import { App, TFile } from 'obsidian';
import type { KnowledgeEngine } from './knowledge-engine';
import { tokenize } from './knowledge-engine';

export interface BrokenLink {
  /** The unresolved link text (e.g. "My Nte" when [[My Nte]] doesn't resolve) */
  linkText: string;
  /** Source files containing this broken link */
  sources: string[];
  /** Suggested fix candidates, sorted by similarity. Empty if none found. */
  suggestions: LinkSuggestion[];
}

export interface LinkSuggestion {
  /** Path to the existing note that could replace the broken link */
  targetPath: string;
  /** Display name (basename without extension) */
  targetName: string;
  /** Similarity score 0–1 */
  similarity: number;
  /** How the match was found */
  matchType: 'exact-case' | 'fuzzy' | 'entity';
}

/**
 * Scan the vault for broken links and generate fix suggestions.
 */
export function scanBrokenLinks(app: App, engine: KnowledgeEngine): BrokenLink[] {
  const unresolvedLinks = app.metadataCache.unresolvedLinks || {};
  // Aggregate: linkText → source paths
  const broken = new Map<string, Set<string>>();
  for (const [source, targets] of Object.entries(unresolvedLinks)) {
    for (const target of Object.keys(targets as Record<string, number>)) {
      if (!broken.has(target)) broken.set(target, new Set());
      broken.get(target)!.add(source);
    }
  }

  if (broken.size === 0) return [];

  // Build a lookup of existing note names for matching
  const mdFiles = app.vault.getMarkdownFiles();
  const nameToPath = new Map<string, string>(); // lowercase basename → path
  const allNames: { name: string; path: string; tokens: Set<string> }[] = [];
  for (const f of mdFiles) {
    const name = f.basename;
    nameToPath.set(name.toLowerCase(), f.path);
    allNames.push({
      name,
      path: f.path,
      tokens: new Set(tokenize(name)),
    });
  }

  const results: BrokenLink[] = [];

  for (const [linkText, sources] of broken.entries()) {
    const suggestions: LinkSuggestion[] = [];
    const linkLower = linkText.toLowerCase();
    const linkTokens = new Set(tokenize(linkText));

    // 1. Case-insensitive exact match (shouldn't happen since Obsidian resolves these, but be safe)
    if (nameToPath.has(linkLower)) {
      const path = nameToPath.get(linkLower)!;
      suggestions.push({
        targetPath: path,
        targetName: path.replace(/\.md$/, '').split('/').pop()!,
        similarity: 1.0,
        matchType: 'exact-case',
      });
    }

    // 2. Fuzzy title matching (Levenshtein-based)
    for (const note of allNames) {
      const sim = titleSimilarity(linkLower, note.name.toLowerCase());
      if (sim >= 0.5 && sim < 1.0) { // skip exact matches (already handled)
        suggestions.push({
          targetPath: note.path,
          targetName: note.name,
          similarity: sim,
          matchType: 'fuzzy',
        });
      }
    }

    // 3. Token overlap matching (catches semantic near-misses)
    if (linkTokens.size > 0) {
      for (const note of allNames) {
        if (note.tokens.size === 0) continue;
        const overlap = intersection(linkTokens, note.tokens);
        if (overlap === 0) continue;
        const tokenSim = overlap / Math.max(linkTokens.size, note.tokens.size);
        if (tokenSim >= 0.3) {
          // Avoid duplicates — only add if not already found with better score
          const existing = suggestions.find(s => s.targetPath === note.path);
          if (!existing || existing.similarity < tokenSim) {
            if (existing) {
              existing.similarity = Math.max(existing.similarity, tokenSim);
            } else {
              suggestions.push({
                targetPath: note.path,
                targetName: note.name,
                similarity: tokenSim,
                matchType: 'entity',
              });
            }
          }
        }
      }
    }

    // Sort by similarity descending, keep top 5
    suggestions.sort((a, b) => b.similarity - a.similarity);
    const deduped = dedup(suggestions).slice(0, 5);

    results.push({
      linkText,
      sources: [...sources],
      suggestions: deduped,
    });
  }

  // Sort by source count descending (most impactful first)
  results.sort((a, b) => b.sources.length - a.sources.length);
  return results;
}

/**
 * Apply a fix: replace all occurrences of [[brokenLink]] with [[fixedLink]] in the source files.
 */
export async function applyFix(
  app: App,
  brokenLinkText: string,
  fixTargetName: string,
  sourcePaths: string[],
): Promise<number> {
  let fixedCount = 0;

  // Match [[brokenLinkText]] and [[brokenLinkText|alias]] patterns
  const escapedLink = escapeRegex(brokenLinkText);
  const pattern = new RegExp(
    `\\[\\[${escapedLink}(\\|[^\\]]*)?\\]\\]`,
    'g'
  );

  for (const sourcePath of sourcePaths) {
    const file = app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) continue;

    const content = await app.vault.read(file);
    const replaced = content.replace(pattern, (match, alias) => {
      fixedCount++;
      // Preserve alias if it exists
      if (alias) return `[[${fixTargetName}${alias}]]`;
      return `[[${fixTargetName}]]`;
    });

    if (replaced !== content) {
      await app.vault.modify(file, replaced);
    }
  }

  return fixedCount;
}

// ── Helpers ──

function titleSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  const dist = levenshtein(a, b);
  return 1 - dist / maxLen;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // Use single-row optimization
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,       // deletion
        curr[j - 1] + 1,   // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function intersection(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const item of a) {
    if (b.has(item)) count++;
  }
  return count;
}

function dedup(suggestions: LinkSuggestion[]): LinkSuggestion[] {
  const seen = new Set<string>();
  return suggestions.filter(s => {
    if (seen.has(s.targetPath)) return false;
    seen.add(s.targetPath);
    return true;
  });
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
