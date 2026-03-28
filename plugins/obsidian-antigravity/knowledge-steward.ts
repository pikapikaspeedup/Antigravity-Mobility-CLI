/**
 * Knowledge Steward — Vault analysis and health monitoring.
 *
 * Provides passive analysis to help users maintain vault quality:
 * - Duplication Detection: find content overlap between notes
 * - Knowledge Gap Discovery: concepts mentioned often but not atomized
 * - Atom Health Report: freshness, reuse, isolation tracking
 * - Split Suggestion: detect multi-topic notes that could be split
 */

import { App, TFile } from 'obsidian';
import type { KnowledgeEngine, NoteProfile, Relationship } from './knowledge-engine';

// ── Result Types ──

export interface DuplicationPair {
  noteA: string;
  noteB: string;
  overlapScore: number; // 0-1
  sharedEntities: string[];
  sharedTokenCount: number;
}

export interface KnowledgeGap {
  concept: string;
  mentionedIn: string[]; // paths of notes mentioning this concept
  mentionCount: number;
  hasOwnNote: boolean; // true if a note with this name exists
}

export interface NoteHealth {
  path: string;
  role: string;
  wordCount: number;
  freshnessDays: number; // days since last modified
  reuseCount: number;
  outLinkCount: number;
  inLinkCount: number;
  relationCount: number;
  isOrphan: boolean; // no links in/out and no relations
  isStale: boolean; // not modified in 90+ days and low reuse
}

export interface SplitSuggestion {
  path: string;
  reason: string;
  topicCount: number;
  wordCount: number;
  topics: string[];
}

export interface VaultHealthReport {
  timestamp: number;
  totalNotes: number;
  roleDistribution: Record<string, number>;
  avgWordCount: number;
  duplications: DuplicationPair[];
  knowledgeGaps: KnowledgeGap[];
  noteHealth: NoteHealth[];
  splitSuggestions: SplitSuggestion[];
  // Derived scores
  healthScore: number; // 0-100
  orphanCount: number;
  staleCount: number;
  avgReuse: number;
  densityScore: number; // connections per note
}

export class KnowledgeSteward {
  private app: App;
  private engine: KnowledgeEngine;

  constructor(app: App, engine: KnowledgeEngine) {
    this.app = app;
    this.engine = engine;
  }

  /**
   * Run a full vault health analysis.
   * This is a compute-heavy operation; call on-demand (not on every edit).
   */
  async analyze(): Promise<VaultHealthReport> {
    const profiles = this.getAllProfiles();
    const now = Date.now();

    // 1. Note health
    const noteHealth = this.computeNoteHealth(profiles, now);

    // 2. Duplication detection
    const duplications = this.detectDuplications(profiles);

    // 3. Knowledge gap discovery
    const knowledgeGaps = this.discoverKnowledgeGaps(profiles);

    // 4. Split suggestions
    const splitSuggestions = this.suggestSplits(profiles);

    // 5. Derive scores
    const roleDistribution: Record<string, number> = {};
    for (const p of profiles) {
      roleDistribution[p.role] = (roleDistribution[p.role] || 0) + 1;
    }

    const orphanCount = noteHealth.filter(n => n.isOrphan).length;
    const staleCount = noteHealth.filter(n => n.isStale).length;
    const totalWordCount = profiles.reduce((s, p) => s + p.wordCount, 0);
    const avgWordCount = profiles.length > 0 ? Math.round(totalWordCount / profiles.length) : 0;
    const totalReuse = profiles.reduce((s, p) => s + p.reuseCount, 0);
    const avgReuse = profiles.length > 0 ? Math.round(totalReuse / profiles.length * 100) / 100 : 0;

    const totalRelations = noteHealth.reduce((s, n) => s + n.relationCount, 0);
    const densityScore = profiles.length > 0
      ? Math.round(totalRelations / profiles.length * 100) / 100
      : 0;

    // Health score: 0-100 composite
    const orphanPenalty = profiles.length > 0 ? (orphanCount / profiles.length) * 30 : 0;
    const stalePenalty = profiles.length > 0 ? (staleCount / profiles.length) * 20 : 0;
    const dupPenalty = Math.min(duplications.length * 3, 20);
    const gapPenalty = Math.min(knowledgeGaps.length * 2, 15);
    const densityBonus = Math.min(densityScore * 3, 15);
    const healthScore = Math.max(0, Math.min(100,
      Math.round(100 - orphanPenalty - stalePenalty - dupPenalty - gapPenalty + densityBonus)
    ));

    return {
      timestamp: now,
      totalNotes: profiles.length,
      roleDistribution,
      avgWordCount,
      duplications,
      knowledgeGaps,
      noteHealth,
      splitSuggestions,
      healthScore,
      orphanCount,
      staleCount,
      avgReuse,
      densityScore,
    };
  }

  // ── Note Health ──

  private computeNoteHealth(profiles: NoteProfile[], now: number): NoteHealth[] {
    const STALE_DAYS = 90;
    const DAY_MS = 24 * 60 * 60 * 1000;

    // Build inlink counts
    const inLinkCounts = new Map<string, number>();
    for (const p of profiles) {
      for (const link of p.outLinks) {
        inLinkCounts.set(link, (inLinkCounts.get(link) || 0) + 1);
      }
    }

    return profiles.map(p => {
      const freshnessDays = Math.round((now - p.lastModified) / DAY_MS);
      const inLinkCount = inLinkCounts.get(p.path) || 0;
      const relations = this.engine.getRelations(p.path);
      const relationCount = relations.length;
      const isOrphan = p.outLinks.length === 0 && inLinkCount === 0 && relationCount <= 1;
      const isStale = freshnessDays >= STALE_DAYS && p.reuseCount === 0;

      return {
        path: p.path,
        role: p.role,
        wordCount: p.wordCount,
        freshnessDays,
        reuseCount: p.reuseCount,
        outLinkCount: p.outLinks.length,
        inLinkCount,
        relationCount,
        isOrphan,
        isStale,
      };
    });
  }

  // ── Duplication Detection ──

  private detectDuplications(profiles: NoteProfile[]): DuplicationPair[] {
    const pairs: DuplicationPair[] = [];
    const OVERLAP_THRESHOLD = 0.4;

    // Use entity overlap as primary signal (cheaper than full token comparison)
    for (let i = 0; i < profiles.length; i++) {
      const a = profiles[i];
      if (a.entities.length < 3) continue;

      for (let j = i + 1; j < profiles.length; j++) {
        const b = profiles[j];
        if (b.entities.length < 3) continue;

        // Quick check: do they share enough entities?
        const aSet = new Set(a.entities.map(e => e.toLowerCase()));
        const bSet = new Set(b.entities.map(e => e.toLowerCase()));
        const shared: string[] = [];
        for (const e of aSet) {
          if (bSet.has(e)) shared.push(e);
        }

        const minEntities = Math.min(aSet.size, bSet.size);
        if (minEntities === 0) continue;
        const entityOverlap = shared.length / minEntities;
        if (entityOverlap < OVERLAP_THRESHOLD) continue;

        // Token overlap for confirmation
        const aTokens = new Set(a.tokens);
        const bTokens = new Set(b.tokens);
        let sharedTokenCount = 0;
        for (const t of aTokens) {
          if (bTokens.has(t)) sharedTokenCount++;
        }
        const tokenOverlap = sharedTokenCount / Math.min(aTokens.size, bTokens.size);

        // Combined overlap score
        const overlapScore = Math.round((entityOverlap * 0.6 + tokenOverlap * 0.4) * 1000) / 1000;
        if (overlapScore >= OVERLAP_THRESHOLD) {
          pairs.push({
            noteA: a.path,
            noteB: b.path,
            overlapScore,
            sharedEntities: shared.slice(0, 10),
            sharedTokenCount,
          });
        }
      }
    }

    // Sort by overlap score descending
    pairs.sort((a, b) => b.overlapScore - a.overlapScore);
    return pairs.slice(0, 20); // top 20
  }

  // ── Knowledge Gap Discovery ──

  private discoverKnowledgeGaps(profiles: NoteProfile[]): KnowledgeGap[] {
    // Find entities that appear in many notes but don't have their own note
    const entityMentions = new Map<string, Set<string>>(); // entity → Set<path>
    const noteTitles = new Set<string>();

    for (const p of profiles) {
      const basename = p.path.split('/').pop()?.replace(/\.md$/, '').toLowerCase() || '';
      noteTitles.add(basename);

      for (const entity of p.entities) {
        const key = entity.toLowerCase();
        if (!entityMentions.has(key)) {
          entityMentions.set(key, new Set());
        }
        entityMentions.get(key)!.add(p.path);
      }
    }

    const gaps: KnowledgeGap[] = [];
    for (const [concept, paths] of entityMentions) {
      if (paths.size < 3) continue; // must appear in 3+ notes to be significant
      const hasOwnNote = noteTitles.has(concept);

      if (!hasOwnNote) {
        gaps.push({
          concept,
          mentionedIn: [...paths],
          mentionCount: paths.size,
          hasOwnNote: false,
        });
      }
    }

    // Sort by mention count descending
    gaps.sort((a, b) => b.mentionCount - a.mentionCount);
    return gaps.slice(0, 15); // top 15
  }

  // ── Split Suggestions ──

  private suggestSplits(profiles: NoteProfile[]): SplitSuggestion[] {
    const suggestions: SplitSuggestion[] = [];
    const WORD_THRESHOLD = 800;
    const TOPIC_THRESHOLD = 3;

    for (const p of profiles) {
      // Only suggest for standalone notes (not atoms or composites)
      if (p.role !== 'standalone') continue;
      if (p.wordCount < WORD_THRESHOLD) continue;
      if (p.topics.length < TOPIC_THRESHOLD) continue;

      // Filter meaningful topics (not generic)
      const meaningfulTopics = p.topics.filter(t => t.length >= 3);
      if (meaningfulTopics.length < TOPIC_THRESHOLD) continue;

      suggestions.push({
        path: p.path,
        reason: `${p.wordCount} words with ${meaningfulTopics.length} topics — consider splitting into focused atoms`,
        topicCount: meaningfulTopics.length,
        wordCount: p.wordCount,
        topics: meaningfulTopics.slice(0, 8),
      });
    }

    // Sort by word count * topic count (bigger = more urgently needs split)
    suggestions.sort((a, b) => (b.wordCount * b.topicCount) - (a.wordCount * a.topicCount));
    return suggestions.slice(0, 10);
  }

  // ── Helpers ──

  private getAllProfiles(): NoteProfile[] {
    return (this.engine as any).index?.profiles
      ? Object.values((this.engine as any).index.profiles)
      : [];
  }
}
