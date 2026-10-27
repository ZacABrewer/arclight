import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard.js';

const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

afterEach(() => {
  if (original) Object.defineProperty(navigator, 'clipboard', original);
  else Reflect.deleteProperty(navigator, 'clipboard');
  Reflect.deleteProperty(document, 'execCommand');
  vi.restoreAllMocks();
});

describe('copyText', () => {
  it('uses the async clipboard when there is one', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    expect(await copyText('hello')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to execCommand over plain http (no navigator.clipboard)', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    let copied = '';
    const exec = vi.fn((cmd: string) => {
      copied = (document.activeElement as HTMLTextAreaElement).value;
      return cmd === 'copy';
    });
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    expect(await copyText('line 1\nline 2')).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    expect(copied).toBe('line 1\nline 2');
    // The helper textarea is gone again.
    expect(document.querySelectorAll('textarea')).toHaveLength(0);
  });

  it('falls back when the async clipboard rejects, and reports failure when both fail', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) }, configurable: true });
    Object.defineProperty(document, 'execCommand', { value: vi.fn(() => false), configurable: true });
    expect(await copyText('x')).toBe(false);
  });
});
