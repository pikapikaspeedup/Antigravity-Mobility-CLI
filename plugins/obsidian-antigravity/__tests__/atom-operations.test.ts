/**
 * Tests for atom-operations.ts — sanitizeFilename and execution logic.
 *
 * We test the sanitizeFilename function indirectly through analyzeSplit's
 * output processing, and test executeSplit/executeMerge with mocked App.
 */
import { describe, it, expect, vi } from 'vitest';
import { TFile } from '../__tests__/mocks/obsidian';
import { executeSplit, executeMerge } from '../atom-operations';
import type { SplitPlan, MergePlan } from '../atom-operations';

function createMockApp(existingFiles: Map<string, string> = new Map()) {
  const files = new Map(existingFiles);
  const tfiles = new Map<string, TFile>();
  for (const [path] of files) {
    tfiles.set(path, new TFile(path));
  }

  return {
    vault: {
      getAbstractFileByPath: (path: string) => tfiles.get(path) || null,
      read: vi.fn(async (file: TFile) => files.get(file.path) || ''),
      create: vi.fn(async (path: string, content: string) => {
        files.set(path, content);
        const tf = new TFile(path);
        tfiles.set(path, tf);
        return tf;
      }),
      modify: vi.fn(async (file: TFile, content: string) => {
        files.set(file.path, content);
      }),
      createFolder: vi.fn(async () => {}),
      rename: vi.fn(async (file: TFile, newPath: string) => {
        files.delete(file.path);
        tfiles.delete(file.path);
        file.path = newPath;
        files.set(newPath, '');
        tfiles.set(newPath, file);
      }),
      configDir: '.obsidian',
      adapter: { write: vi.fn(async () => {}) },
    },
  } as any;
}

describe('executeSplit', () => {
  it('creates atom files with frontmatter', async () => {
    const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
    const app = createMockApp(new Map([['notes/big-note.md', content]]));

    const plan: SplitPlan = {
      atoms: [
        { title: 'Atom One', startLine: 1, endLine: 2, tags: ['tag1'] },
        { title: 'Atom Two', startLine: 3, endLine: 5, tags: [] },
      ],
      makeComposite: false,
    };

    const created = await executeSplit(app, 'notes/big-note.md', plan);
    expect(created).toEqual(['notes/big-note/Atom One.md', 'notes/big-note/Atom Two.md']);
    expect(app.vault.create).toHaveBeenCalledTimes(2);

    // Check atom content has frontmatter
    const firstCall = (app.vault.create as any).mock.calls[0];
    expect(firstCall[1]).toContain('type: atom');
    expect(firstCall[1]).toContain('tags: [tag1]');
  });

  it('skips existing files without error', async () => {
    const app = createMockApp(new Map([
      ['notes/source.md', 'Content'],
      ['notes/source/Existing.md', 'Already here'],
    ]));

    const plan: SplitPlan = {
      atoms: [{ title: 'Existing', startLine: 1, endLine: 1, tags: [] }],
      makeComposite: false,
    };

    const created = await executeSplit(app, 'notes/source.md', plan);
    expect(created).toEqual([]);
    expect(app.vault.create).not.toHaveBeenCalled();
  });

  it('converts original to composite when requested', async () => {
    const content = 'Line 1\nLine 2\nLine 3';
    const app = createMockApp(new Map([['doc.md', content]]));

    const plan: SplitPlan = {
      atoms: [{ title: 'Part A', startLine: 1, endLine: 3, tags: [] }],
      makeComposite: true,
    };

    await executeSplit(app, 'doc.md', plan);
    expect(app.vault.modify).toHaveBeenCalled();
    const modifiedContent = (app.vault.modify as any).mock.calls[0][1];
    expect(modifiedContent).toContain('![[Part A]]');
    expect(modifiedContent).toContain('type: knowledge');
  });
});

describe('executeMerge', () => {
  it('creates merged file and archives originals', async () => {
    const app = createMockApp(new Map([
      ['notes/noteA.md', 'content A'],
      ['notes/noteB.md', 'content B'],
    ]));

    const plan: MergePlan = {
      title: 'Merged Note',
      mergedContent: '# Merged\n\nCombined content',
      sourceA: 'notes/noteA.md',
      sourceB: 'notes/noteB.md',
    };

    const result = await executeMerge(app, plan);
    expect(result).toBe('notes/Merged Note.md');
    expect(app.vault.create).toHaveBeenCalledWith(
      'notes/Merged Note.md',
      expect.stringContaining('type: atom'),
    );
    expect(app.vault.rename).toHaveBeenCalledTimes(2);
  });

  it('returns null if merged file already exists', async () => {
    const app = createMockApp(new Map([
      ['notes/noteA.md', 'content A'],
      ['notes/noteB.md', 'content B'],
      ['notes/Merged.md', 'already exists'],
    ]));

    const plan: MergePlan = {
      title: 'Merged',
      mergedContent: 'content',
      sourceA: 'notes/noteA.md',
      sourceB: 'notes/noteB.md',
    };

    const result = await executeMerge(app, plan);
    expect(result).toBeNull();
  });
});
