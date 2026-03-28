/**
 * Tests for broken-link-fixer.ts — scanning and fixing logic.
 *
 * We test the exported helper functions indirectly via scanBrokenLinks
 * by mocking the Obsidian App object.
 */
import { describe, it, expect, vi } from 'vitest';
import { TFile } from '../__tests__/mocks/obsidian';

// We need to test the internal helpers. Since they're not exported,
// we'll import the module and test via scanBrokenLinks with mocked App.
import { scanBrokenLinks, applyFix } from '../broken-link-fixer';
import type { KnowledgeEngine } from '../knowledge-engine';

function createMockApp(files: string[], unresolvedLinks: Record<string, Record<string, number>>) {
  const mdFiles = files.map(f => {
    const tf = new TFile(f);
    return tf;
  });

  return {
    vault: {
      getMarkdownFiles: () => mdFiles,
      getAbstractFileByPath: (path: string) => mdFiles.find(f => f.path === path) || null,
      read: vi.fn(async (file: TFile) => ''),
      modify: vi.fn(async () => {}),
    },
    metadataCache: {
      unresolvedLinks,
    },
  } as any;
}

function createMockEngine(): KnowledgeEngine {
  return {} as any;
}

describe('scanBrokenLinks', () => {
  it('returns empty array when no unresolved links', () => {
    const app = createMockApp(['note-a.md', 'note-b.md'], {});
    const result = scanBrokenLinks(app, createMockEngine());
    expect(result).toEqual([]);
  });

  it('detects broken links and suggests fuzzy matches', () => {
    const app = createMockApp(
      ['Machine Learning.md', 'Deep Learning.md', 'notes/AI.md'],
      {
        'notes/AI.md': { 'Machne Learning': 1 }, // typo
      },
    );
    const result = scanBrokenLinks(app, createMockEngine());
    expect(result.length).toBe(1);
    expect(result[0].linkText).toBe('Machne Learning');
    expect(result[0].sources).toContain('notes/AI.md');
    // Should suggest "Machine Learning" as a fuzzy match
    const hasMachineLearning = result[0].suggestions.some(
      s => s.targetName === 'Machine Learning',
    );
    expect(hasMachineLearning).toBe(true);
  });

  it('finds exact case-insensitive matches', () => {
    const app = createMockApp(
      ['my-note.md', 'Important Topic.md'],
      {
        'my-note.md': { 'important topic': 1 }, // case mismatch
      },
    );
    const result = scanBrokenLinks(app, createMockEngine());
    expect(result.length).toBe(1);
    const exactMatch = result[0].suggestions.find(s => s.matchType === 'exact-case');
    expect(exactMatch).toBeDefined();
    expect(exactMatch?.targetName).toBe('Important Topic');
  });

  it('aggregates sources for the same broken link', () => {
    const app = createMockApp(
      ['note-a.md', 'note-b.md', 'note-c.md', 'Target.md'],
      {
        'note-a.md': { 'Traget': 1 },
        'note-b.md': { 'Traget': 1 },
      },
    );
    const result = scanBrokenLinks(app, createMockEngine());
    expect(result.length).toBe(1);
    expect(result[0].sources.length).toBe(2);
  });

  it('limits suggestions to 5', () => {
    // Create many similar note names
    const files = Array.from({ length: 20 }, (_, i) => `Note Variant ${i}.md`);
    const app = createMockApp(
      files,
      { 'Note Variant 0.md': { 'Note Variant': 1 } },
    );
    const result = scanBrokenLinks(app, createMockEngine());
    if (result.length > 0) {
      expect(result[0].suggestions.length).toBeLessThanOrEqual(5);
    }
  });
});

describe('applyFix', () => {
  it('replaces broken links in source files', async () => {
    const app = createMockApp(['note-a.md'], {});
    (app.vault.read as any).mockResolvedValue('See [[Broken Link]] and [[Broken Link|alias]] here');

    const count = await applyFix(app, 'Broken Link', 'Fixed Link', ['note-a.md']);
    expect(count).toBe(2);
    expect(app.vault.modify).toHaveBeenCalledWith(
      expect.anything(),
      'See [[Fixed Link]] and [[Fixed Link|alias]] here',
    );
  });

  it('preserves alias text', async () => {
    const app = createMockApp(['note-a.md'], {});
    (app.vault.read as any).mockResolvedValue('Check [[Old Name|custom display]]');

    await applyFix(app, 'Old Name', 'New Name', ['note-a.md']);
    expect(app.vault.modify).toHaveBeenCalledWith(
      expect.anything(),
      'Check [[New Name|custom display]]',
    );
  });

  it('handles special regex characters in link text', async () => {
    const app = createMockApp(['note-a.md'], {});
    (app.vault.read as any).mockResolvedValue('Link [[C++ Guide]] here');

    const count = await applyFix(app, 'C++ Guide', 'CPP Guide', ['note-a.md']);
    expect(count).toBe(1);
    expect(app.vault.modify).toHaveBeenCalledWith(
      expect.anything(),
      'Link [[CPP Guide]] here',
    );
  });
});
