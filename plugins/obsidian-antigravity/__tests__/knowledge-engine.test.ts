/**
 * Tests for knowledge-engine.ts — pure functions and core logic.
 */
import { describe, it, expect } from 'vitest';
import {
  tokenize,
  extractEntitiesRegex,
  extractTopicsFromMeta,
  simpleHash,
} from '../knowledge-engine';

// ── tokenize ──

describe('tokenize', () => {
  it('splits English text and removes stopwords', () => {
    const tokens = tokenize('The quick brown fox jumps over the lazy dog');
    expect(tokens).not.toContain('the');
    expect(tokens).not.toContain('over');
    expect(tokens).toContain('quick');
    expect(tokens).toContain('brown');
    expect(tokens).toContain('fox');
    expect(tokens).toContain('jumps');
    expect(tokens).toContain('lazy');
    expect(tokens).toContain('dog');
  });

  it('removes code blocks and inline code', () => {
    const tokens = tokenize('Hello ```javascript\nconsole.log("test")\n``` world `inline`');
    expect(tokens).toContain('hello');
    expect(tokens).toContain('world');
    expect(tokens).not.toContain('console');
    expect(tokens).not.toContain('inline');
  });

  it('removes URLs', () => {
    const tokens = tokenize('Visit https://example.com/path for info');
    expect(tokens).not.toContain('https');
    expect(tokens).not.toContain('example');
    expect(tokens).toContain('visit');
    expect(tokens).toContain('info');
  });

  it('extracts wikilink text', () => {
    const tokens = tokenize('See [[My Note]] and [[Another|Display]]');
    // wikilink regex extracts inner text: "My Note" → becomes "my note" after lowercasing
    // then "my" (2 chars) passes length filter but gets split by \s → separate words
    expect(tokens).toContain('note');
    expect(tokens).toContain('see');
    expect(tokens).toContain('another');
  });

  it('deduplicates tokens', () => {
    const tokens = tokenize('apple banana apple cherry banana');
    const counts = tokens.reduce((acc, t) => { acc[t] = (acc[t] || 0) + 1; return acc; }, {} as Record<string, number>);
    expect(counts['apple']).toBe(1);
    expect(counts['banana']).toBe(1);
  });

  it('limits to MAX_TOKENS_PER_NOTE', () => {
    const longText = Array.from({ length: 500 }, (_, i) => `word${i}`).join(' ');
    const tokens = tokenize(longText);
    expect(tokens.length).toBeLessThanOrEqual(200);
  });

  it('filters short tokens (<2 chars)', () => {
    const tokens = tokenize('I a an be do go if no or so up');
    // Most are stopwords; "go" (2 chars, not a stopword) passes through
    // Single-char tokens are filtered. "up" is a stopword.
    expect(tokens.length).toBeLessThanOrEqual(1);
  });

  it('handles Chinese stopwords', () => {
    const tokens = tokenize('我有一个好的想法');
    expect(tokens).not.toContain('的');
    expect(tokens).not.toContain('我');
    expect(tokens).not.toContain('有');
  });
});

// ── extractEntitiesRegex ──

describe('extractEntitiesRegex', () => {
  it('extracts wikilinks', () => {
    const entities = extractEntitiesRegex('See [[Machine Learning]] and [[Deep Learning|DL]]');
    expect(entities).toContain('Machine Learning');
    expect(entities).toContain('Deep Learning');
  });

  it('extracts capitalized multi-word phrases', () => {
    const entities = extractEntitiesRegex('I studied Neural Network Architecture at Stanford University');
    expect(entities).toContain('Neural Network Architecture');
    expect(entities).toContain('Stanford University');
  });

  it('extracts quoted terms', () => {
    const entities = extractEntitiesRegex('The concept of "knowledge atomization" is important');
    expect(entities).toContain('knowledge atomization');
  });

  it('extracts hashtags', () => {
    const entities = extractEntitiesRegex('Tags: #machine-learning #AI #知识管理');
    expect(entities).toContain('machine-learning');
    expect(entities).toContain('AI');
    expect(entities).toContain('知识管理');
  });

  it('limits to 50 entities', () => {
    const text = Array.from({ length: 100 }, (_, i) => `[[Entity${i}]]`).join(' ');
    const entities = extractEntitiesRegex(text);
    expect(entities.length).toBeLessThanOrEqual(50);
  });
});

// ── extractTopicsFromMeta ──

describe('extractTopicsFromMeta', () => {
  it('extracts headings level 1-3', () => {
    const topics = extractTopicsFromMeta({
      headings: [
        { level: 1, heading: 'Introduction', position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } } },
        { level: 2, heading: 'Background', position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } } },
        { level: 3, heading: 'Related Work', position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } } },
        { level: 4, heading: 'Deep Detail', position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } } },
      ],
    } as any);
    expect(topics).toContain('Introduction');
    expect(topics).toContain('Background');
    expect(topics).toContain('Related Work');
    expect(topics).not.toContain('Deep Detail');
  });

  it('returns empty for null cache', () => {
    expect(extractTopicsFromMeta(null)).toEqual([]);
  });

  it('limits to 20 topics', () => {
    const headings = Array.from({ length: 30 }, (_, i) => ({
      level: 2,
      heading: `Topic ${i}`,
      position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } },
    }));
    const topics = extractTopicsFromMeta({ headings } as any);
    expect(topics.length).toBeLessThanOrEqual(20);
  });
});

// ── simpleHash ──

describe('simpleHash', () => {
  it('returns consistent hash for same input', () => {
    expect(simpleHash('hello world')).toBe(simpleHash('hello world'));
  });

  it('returns different hash for different input', () => {
    expect(simpleHash('hello')).not.toBe(simpleHash('world'));
  });

  it('returns a string', () => {
    expect(typeof simpleHash('test')).toBe('string');
  });
});
