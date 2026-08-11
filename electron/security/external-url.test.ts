import { describe, expect, it } from 'vitest';
import { assertSafeExternalUrl } from './external-url.js';

describe('assertSafeExternalUrl', () => {
  it.each(['https://example.com/path', 'http://127.0.0.1:4173/'])(
    'allows %s',
    (value) => {
      expect(assertSafeExternalUrl(value)).toBe(value);
    }
  );

  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,unsafe',
    'mailto:test@example.com',
    '/relative/path'
  ])('rejects %s', (value) => {
    expect(() => assertSafeExternalUrl(value)).toThrow();
  });

  it('rejects non-string input', () => {
    expect(() => assertSafeExternalUrl(undefined)).toThrow('must be a string');
  });
});
