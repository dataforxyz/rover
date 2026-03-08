import { describe, it, expect } from 'vitest';
import {
  truncateFileContent,
  MAX_INJECTED_FILE_CHARS,
} from '../placeholders.js';

describe('truncateFileContent', () => {
  it('returns content unchanged when under limit', () => {
    const content = 'short content';
    const { text, truncated } = truncateFileContent(content, 'test');
    expect(text).toBe(content);
    expect(truncated).toBe(false);
  });

  it('returns content unchanged when exactly at limit', () => {
    const content = 'x'.repeat(MAX_INJECTED_FILE_CHARS);
    const { text, truncated } = truncateFileContent(content, 'test');
    expect(text).toBe(content);
    expect(truncated).toBe(false);
  });

  it('truncates content exceeding the limit', () => {
    const content = 'x'.repeat(MAX_INJECTED_FILE_CHARS + 50_000);
    const { text, truncated } = truncateFileContent(content, 'plan.md');
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThan(content.length);
    expect(text).toContain('[truncated 50000 chars');
    expect(text).toContain('plan.md too large for prompt');
  });

  it('keeps the beginning of the content', () => {
    const prefix = 'IMPORTANT_START_';
    const content = prefix + 'y'.repeat(MAX_INJECTED_FILE_CHARS + 1000);
    const { text } = truncateFileContent(content, 'test');
    expect(text.startsWith(prefix)).toBe(true);
  });
});
