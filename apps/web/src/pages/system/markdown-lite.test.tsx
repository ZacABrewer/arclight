import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarkdownLite, parseBlocks } from './markdown-lite.js';

describe('MarkdownLite', () => {
  it('parses headings, lists, code fences and paragraphs', () => {
    expect(parseBlocks('## What changed\n- one\n- two\n\n1. first\n\nPlain\ntext\n```\ncode\n```')).toEqual([
      { kind: 'h', level: 2, text: 'What changed' },
      { kind: 'ul', items: ['one', 'two'] },
      { kind: 'ol', items: ['first'] },
      { kind: 'p', text: 'Plain text' },
      { kind: 'pre', text: 'code' },
    ]);
  });

  it('renders inline code, bold and safe links only, never raw HTML', () => {
    render(<MarkdownLite source={'Use `x` **now** [docs](https://example.com) [bad](javascript:alert(1)) <img src=x onerror=alert(1)>'} />);
    expect(screen.getByText('x').tagName).toBe('CODE');
    expect(screen.getByText('now').tagName).toBe('STRONG');
    expect(screen.getByRole('link', { name: 'docs' }).getAttribute('href')).toBe('https://example.com');
    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });
});
