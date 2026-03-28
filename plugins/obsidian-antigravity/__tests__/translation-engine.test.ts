/**
 * Tests for translation-engine.ts — Block splitting, hashing, language detection.
 */
import { describe, it, expect } from 'vitest';
import {
  splitIntoBlocks,
  assembleBlocks,
  hashString,
  detectLanguage,
} from '../translation-engine';

// ── splitIntoBlocks ──

describe('splitIntoBlocks', () => {
  it('splits paragraphs by empty lines', () => {
    const content = 'First paragraph.\n\nSecond paragraph.';
    const blocks = splitIntoBlocks(content);
    const translatable = blocks.filter(b => b.translatable && b.text.trim());
    expect(translatable.length).toBe(2);
    expect(translatable[0].text).toBe('First paragraph.');
    expect(translatable[1].text).toBe('Second paragraph.');
  });

  it('preserves frontmatter as non-translatable', () => {
    const content = '---\ntitle: Hello\ntags: [a, b]\n---\n\nContent here.';
    const blocks = splitIntoBlocks(content);
    const frontmatter = blocks.find(b => b.text.includes('title: Hello'));
    expect(frontmatter).toBeDefined();
    expect(frontmatter!.translatable).toBe(false);
  });

  it('preserves code blocks as non-translatable', () => {
    const content = 'Before code.\n\n```js\nconst x = 1;\nconsole.log(x);\n```\n\nAfter code.';
    const blocks = splitIntoBlocks(content);
    const codeBlock = blocks.find(b => b.text.includes('const x = 1'));
    expect(codeBlock).toBeDefined();
    expect(codeBlock!.translatable).toBe(false);

    const before = blocks.find(b => b.text === 'Before code.');
    expect(before).toBeDefined();
    expect(before!.translatable).toBe(true);

    const after = blocks.find(b => b.text === 'After code.');
    expect(after).toBeDefined();
    expect(after!.translatable).toBe(true);
  });

  it('splits headings into separate blocks', () => {
    const content = 'Some text.\n# Heading\nMore text.';
    const blocks = splitIntoBlocks(content);
    const headingBlock = blocks.find(b => b.text.startsWith('#'));
    expect(headingBlock).toBeDefined();
    expect(headingBlock!.text).toContain('# Heading');
  });

  it('handles empty content', () => {
    const blocks = splitIntoBlocks('');
    expect(blocks.length).toBe(0);
  });

  it('handles content with only frontmatter', () => {
    const content = '---\ntitle: Test\n---';
    const blocks = splitIntoBlocks(content);
    const fm = blocks.find(b => !b.translatable);
    expect(fm).toBeDefined();
  });

  it('handles nested code fences', () => {
    const content = 'Text.\n\n```\nline 1\nline 2\n```\n\nMore text.';
    const blocks = splitIntoBlocks(content);
    const code = blocks.find(b => b.text.includes('line 1'));
    expect(code!.translatable).toBe(false);
  });
});

// ── assembleBlocks ──

describe('assembleBlocks', () => {
  it('reassembles blocks preserving structure', () => {
    const content = 'First.\n\nSecond.\n\nThird.';
    const blocks = splitIntoBlocks(content);
    const assembled = assembleBlocks(blocks);
    expect(assembled).toBe(content);
  });

  it('reassembles with frontmatter and code blocks', () => {
    const content = '---\ntitle: Hello\n---\n\nText.\n\n```js\ncode();\n```\n\nEnd.';
    const blocks = splitIntoBlocks(content);
    const assembled = assembleBlocks(blocks);
    expect(assembled).toBe(content);
  });
});

// ── hashString ──

describe('hashString', () => {
  it('produces consistent hash for same input', () => {
    const h1 = hashString('hello world');
    const h2 = hashString('hello world');
    expect(h1).toBe(h2);
  });

  it('produces different hash for different input', () => {
    const h1 = hashString('hello');
    const h2 = hashString('world');
    expect(h1).not.toBe(h2);
  });

  it('returns a string', () => {
    const h = hashString('test');
    expect(typeof h).toBe('string');
    expect(h.length).toBeGreaterThan(0);
  });
});

// ── detectLanguage ──

describe('detectLanguage', () => {
  it('detects Chinese text', () => {
    expect(detectLanguage('这是一段中文内容，用于测试语言检测功能。')).toBe('zh');
  });

  it('detects English text', () => {
    expect(detectLanguage('This is an English paragraph for testing language detection.')).toBe('en');
  });

  it('detects Japanese text (hiragana/katakana)', () => {
    expect(detectLanguage('これは日本語のテキストです。テストのためです。')).toBe('ja');
  });

  it('detects Korean text', () => {
    expect(detectLanguage('이것은 한국어 텍스트입니다. 테스트용입니다.')).toBe('ko');
  });

  it('defaults to English for mixed/ambiguous content', () => {
    expect(detectLanguage('Hello world 123 test')).toBe('en');
  });

  it('handles empty string', () => {
    expect(detectLanguage('')).toBe('en');
  });
});
