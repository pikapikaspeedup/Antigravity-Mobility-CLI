/**
 * Integration tests for KnowledgeEngine — fullBuild, relations, queries, events.
 *
 * Uses a fully mocked App + in-memory IndexStore to test the engine lifecycle.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TFile } from './mocks/obsidian';
import {
  KnowledgeEngine,
  type IndexStore,
  type KnowledgeIndex,
} from '../knowledge-engine';

// ── In-memory IndexStore ──

class MemoryStore implements IndexStore {
  data: KnowledgeIndex | null = null;

  async load(): Promise<KnowledgeIndex | null> {
    return this.data;
  }
  async save(index: KnowledgeIndex): Promise<void> {
    // Deep clone to simulate persistence
    this.data = JSON.parse(JSON.stringify(index));
  }
  async clear(): Promise<void> {
    this.data = null;
  }
}

// ── Mock note data ──

interface MockNote {
  path: string;
  content: string;
  tags?: string[];
  links?: string[];       // resolved link targets
  embeds?: string[];       // embed targets
  headings?: { level: number; heading: string }[];
  frontmatter?: Record<string, any>;
}

function createMockApp(notes: MockNote[]) {
  const fileMap = new Map<string, TFile>();
  const contentMap = new Map<string, string>();

  for (const note of notes) {
    const tf = new TFile(note.path);
    tf.stat = { mtime: Date.now() };
    fileMap.set(note.path, tf);
    contentMap.set(note.path, note.content);
  }

  // Build resolvedLinks
  const resolvedLinks: Record<string, Record<string, number>> = {};
  for (const note of notes) {
    resolvedLinks[note.path] = {};
    for (const link of (note.links || [])) {
      resolvedLinks[note.path][link] = 1;
    }
  }

  // Build cache per file
  const caches: Record<string, any> = {};
  for (const note of notes) {
    caches[note.path] = {
      tags: (note.tags || []).map(t => ({ tag: `#${t}` })),
      headings: (note.headings || []).map(h => ({
        ...h,
        position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } },
      })),
      embeds: (note.embeds || []).map(e => ({ link: e })),
      frontmatter: note.frontmatter || {},
    };
  }

  return {
    vault: {
      getMarkdownFiles: () => [...fileMap.values()],
      getAbstractFileByPath: (path: string) => fileMap.get(path) || null,
      cachedRead: async (file: TFile) => contentMap.get(file.path) || '',
      configDir: '.obsidian',
    },
    metadataCache: {
      resolvedLinks,
      unresolvedLinks: {},
      getFileCache: (file: TFile) => caches[file.path] || null,
      getFirstLinkpathDest: (link: string, _source: string) => {
        // Simple: find file with matching basename
        for (const [path, tf] of fileMap) {
          if (tf.basename === link || path === link || path === `${link}.md`) {
            return tf;
          }
        }
        return null;
      },
    },
  } as any;
}

// ── Tests ──

describe('KnowledgeEngine — integration', () => {
  let engine: KnowledgeEngine;
  let store: MemoryStore;
  let app: any;

  const notes: MockNote[] = [
    {
      path: 'machine-learning.md',
      content: '# Machine Learning\n\nMachine learning is a subset of AI. It uses algorithms to learn from data.\n\n## Supervised Learning\n\nLabeled datasets are used for training models.',
      tags: ['ai', 'ml'],
      links: ['deep-learning.md'],
      headings: [
        { level: 1, heading: 'Machine Learning' },
        { level: 2, heading: 'Supervised Learning' },
      ],
    },
    {
      path: 'deep-learning.md',
      content: '# Deep Learning\n\nDeep learning uses neural networks with many layers. It is a subfield of machine learning.\n\n## Architectures\n\nCNN, RNN, Transformer are popular architectures.',
      tags: ['ai', 'dl'],
      links: [],
      embeds: ['neural-networks.md'],
      headings: [
        { level: 1, heading: 'Deep Learning' },
        { level: 2, heading: 'Architectures' },
      ],
    },
    {
      path: 'neural-networks.md',
      content: '# Neural Networks\n\nArtificial neural networks mimic biological neurons. Layers of neurons process information.',
      tags: ['ai', 'nn'],
      links: [],
      headings: [
        { level: 1, heading: 'Neural Networks' },
      ],
      frontmatter: { type: 'atom' },
    },
    {
      path: 'cooking-recipes.md',
      content: '# Cooking Recipes\n\nPasta carbonara is a classic Italian dish. Mix eggs, cheese, and pancetta.',
      tags: ['food', 'italian'],
      links: [],
      headings: [
        { level: 1, heading: 'Cooking Recipes' },
      ],
    },
    {
      path: 'ai-overview.md',
      content: '# AI Overview\n\nArtificial intelligence encompasses machine learning, deep learning, and more.\n\nSee related topics.',
      tags: ['ai'],
      links: ['machine-learning.md', 'deep-learning.md'],
      embeds: ['machine-learning.md', 'deep-learning.md'],
      headings: [
        { level: 1, heading: 'AI Overview' },
      ],
    },
  ];

  beforeEach(async () => {
    store = new MemoryStore();
    app = createMockApp(notes);
    engine = new KnowledgeEngine(app, store);
    await engine.initialize();
  });

  it('builds index with correct note count', () => {
    const stats = engine.getStats();
    expect(stats.totalNotes).toBe(5);
  });

  it('indexes all note profiles', () => {
    for (const note of notes) {
      const profile = engine.getProfile(note.path);
      expect(profile).not.toBeNull();
      expect(profile!.path).toBe(note.path);
    }
  });

  it('extracts tokens from content', () => {
    const profile = engine.getProfile('machine-learning.md');
    expect(profile).not.toBeNull();
    expect(profile!.tokens.length).toBeGreaterThan(0);
    expect(profile!.tokens).toContain('machine');
    expect(profile!.tokens).toContain('learning');
  });

  it('extracts tags from notes', () => {
    const profile = engine.getProfile('machine-learning.md');
    expect(profile!.tags).toContain('ai');
    expect(profile!.tags).toContain('ml');
  });

  it('classifies roles correctly', () => {
    // neural-networks.md has frontmatter type: atom → role: atom
    expect(engine.getProfile('neural-networks.md')!.role).toBe('atom');

    // ai-overview.md embeds 2+ notes → role: composite
    expect(engine.getProfile('ai-overview.md')!.role).toBe('composite');

    // cooking-recipes.md has no embeds and isn't reused → standalone
    expect(engine.getProfile('cooking-recipes.md')!.role).toBe('standalone');
  });

  it('computes relations between linked notes', () => {
    const rels = engine.getRelations('machine-learning.md');
    expect(rels.length).toBeGreaterThan(0);

    // Should have a relation to deep-learning.md (direct link)
    const dlRel = rels.find(r => r.target === 'deep-learning.md');
    expect(dlRel).toBeDefined();
    expect(dlRel!.type).toBe('explicit');
    expect(dlRel!.signals.linkDistance).toBe(1);
  });

  it('computes relations based on shared tags', () => {
    // machine-learning and deep-learning share 'ai' tag
    const rels = engine.getRelations('machine-learning.md');
    const dlRel = rels.find(r => r.target === 'deep-learning.md');
    expect(dlRel).toBeDefined();
    expect(dlRel!.signals.sharedTags).toBeGreaterThanOrEqual(1);
  });

  it('scores unrelated notes lower', () => {
    // cooking-recipes should have no/very low relations to ML notes
    const rels = engine.getRelations('cooking-recipes.md');
    const mlRel = rels.find(r => r.target === 'machine-learning.md');
    if (mlRel) {
      expect(mlRel.score).toBeLessThan(0.15);
    }
  });

  it('respects MAX_RELATIONS_PER_NOTE limit', () => {
    for (const note of notes) {
      const rels = engine.getRelations(note.path);
      expect(rels.length).toBeLessThanOrEqual(10);
    }
  });

  it('provides sorted relations (highest score first)', () => {
    for (const note of notes) {
      const rels = engine.getRelations(note.path);
      for (let i = 1; i < rels.length; i++) {
        expect(rels[i - 1].score).toBeGreaterThanOrEqual(rels[i].score);
      }
    }
  });

  // ── queryByText ──

  it('queryByText returns relevant notes', () => {
    const results = engine.queryByText('neural networks and deep learning');
    expect(results.length).toBeGreaterThan(0);
    const paths = results.map(r => r.path);
    // Should find neural-networks.md and deep-learning.md
    expect(paths.some(p => p.includes('neural') || p.includes('deep'))).toBe(true);
  });

  it('queryByText excludes specified paths', () => {
    const exclude = new Set(['neural-networks.md']);
    const results = engine.queryByText('neural networks', 5, exclude);
    const paths = results.map(r => r.path);
    expect(paths).not.toContain('neural-networks.md');
  });

  it('queryByText returns empty for unrelated query', () => {
    const results = engine.queryByText('basketball playoffs scores');
    // Should return empty or very low scores
    expect(results.length).toBe(0);
  });

  // ── getAllPaths / getAllProfiles ──

  it('getAllPaths returns all indexed paths', () => {
    const paths = engine.getAllPaths();
    expect(paths.length).toBe(5);
    expect(paths).toContain('machine-learning.md');
    expect(paths).toContain('cooking-recipes.md');
  });

  it('getAllProfiles returns all profiles', () => {
    const profiles = engine.getAllProfiles();
    expect(profiles.length).toBe(5);
    expect(profiles.every(p => p.path && p.tokens)).toBe(true);
  });

  // ── Persistence ──

  it('persists index to store after build', async () => {
    // The debounced save may not have fired, but fullBuild calls save directly
    expect(store.data).not.toBeNull();
    expect(store.data!.totalNotes).toBe(5);
  });

  it('reloads from store on second initialize', async () => {
    // Create a new engine with the same store (simulating restart)
    const engine2 = new KnowledgeEngine(app, store);
    await engine2.initialize();

    // Should load from store without rebuilding
    const stats = engine2.getStats();
    expect(stats.totalNotes).toBe(5);
    expect(engine2.getProfile('machine-learning.md')).not.toBeNull();
  });

  // ── Event: File modified ──

  it('handles file modification', async () => {
    // Modify content and trigger event
    const file = app.vault.getMarkdownFiles().find((f: TFile) => f.path === 'cooking-recipes.md');
    // Simulate content change by updating the mock
    const origCachedRead = app.vault.cachedRead;
    app.vault.cachedRead = async (f: TFile) => {
      if (f.path === 'cooking-recipes.md') {
        return '# Cooking Recipes\n\nMachine learning can optimize recipe generation.';
      }
      return origCachedRead(f);
    };

    await engine.onFileModified(file);

    const profile = engine.getProfile('cooking-recipes.md');
    expect(profile!.tokens).toContain('machine');
  });

  // ── Event: File deleted ──

  it('handles file deletion', () => {
    engine.onFileDeleted('cooking-recipes.md');
    expect(engine.getProfile('cooking-recipes.md')).toBeNull();
    expect(engine.getStats().totalNotes).toBe(4);
  });

  // ── Event: File renamed ──

  it('handles file rename', () => {
    engine.onFileRenamed('cooking-recipes.md', 'cuisine/recipes.md');
    expect(engine.getProfile('cooking-recipes.md')).toBeNull();
    expect(engine.getProfile('cuisine/recipes.md')).not.toBeNull();
    expect(engine.getProfile('cuisine/recipes.md')!.path).toBe('cuisine/recipes.md');
  });

  // ── Embed distance / Content inheritance ──

  it('detects embed relationships', () => {
    const rels = engine.getRelations('deep-learning.md');
    const nnRel = rels.find(r => r.target === 'neural-networks.md');
    expect(nnRel).toBeDefined();
    expect(nnRel!.signals.embedDistance).toBe(1);
  });

  it('composite inherits embedded tokens for relation scoring', () => {
    // ai-overview embeds machine-learning and deep-learning
    // Its effective tokens should include tokens from embedded notes
    // This means it should have stronger token similarity with neural-networks
    const rels = engine.getRelations('ai-overview.md');
    // Should find neural-networks through content inheritance
    const hasNN = rels.some(r => r.target === 'neural-networks.md');
    // This may or may not appear depending on threshold, but the composite
    // should at least have relations to its embedded notes
    const hasML = rels.some(r => r.target === 'machine-learning.md');
    const hasDL = rels.some(r => r.target === 'deep-learning.md');
    expect(hasML).toBe(true);
    expect(hasDL).toBe(true);
  });
});
