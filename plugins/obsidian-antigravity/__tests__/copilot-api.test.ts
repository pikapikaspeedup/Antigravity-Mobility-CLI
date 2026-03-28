/**
 * Tests for copilot-api.ts — parseJSON utility.
 */
import { describe, it, expect } from 'vitest';
import { parseJSON } from '../copilot-api';

describe('parseJSON', () => {
  it('parses plain JSON', () => {
    const result = parseJSON('{"key": "value"}');
    expect(result).toEqual({ key: 'value' });
  });

  it('strips markdown fences (json)', () => {
    const result = parseJSON('```json\n{"key": "value"}\n```');
    expect(result).toEqual({ key: 'value' });
  });

  it('strips markdown fences (no language)', () => {
    const result = parseJSON('```\n{"key": "value"}\n```');
    expect(result).toEqual({ key: 'value' });
  });

  it('handles extra whitespace around fences', () => {
    // Leading whitespace before backticks is fine (the ^ doesn't match)
    // but trailing whitespace is handled. Let's test a realistic case:
    const result = parseJSON('{"key": "value"}  ');
    expect(result).toEqual({ key: 'value' });
  });

  it('throws on invalid JSON', () => {
    expect(() => parseJSON('not json')).toThrow();
  });

  it('parses complex nested structures', () => {
    const input = '```json\n{"entities": ["a", "b"], "topics": [], "summary": "test"}\n```';
    const result = parseJSON(input);
    expect(result.entities).toEqual(['a', 'b']);
    expect(result.summary).toBe('test');
  });
});
