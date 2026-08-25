import { describe, expect, it } from 'vitest';
import {
  browserUrlPort,
  isLoopbackBrowserHostname,
  normalizeBrowserUrl
} from './browser-navigation';

describe('normalizeBrowserUrl', () => {
  it.each([
    ['localhost:3000', 'http://localhost:3000'],
    ['localhost:3000/login', 'http://localhost:3000/login'],
    [':5173', 'http://localhost:5173'],
    ['xps:8877', 'http://xps:8877'],
    ['127.0.0.1:4173', 'http://127.0.0.1:4173'],
    ['[::1]:8080', 'http://[::1]:8080'],
    ['192.168.1.20:8080', 'http://192.168.1.20:8080']
  ])('keeps the local address %s inside the embedded browser', (input, expected) => {
    expect(normalizeBrowserUrl(input)).toBe(expected);
  });

  it('defaults public hosts to HTTPS and plain words to search', () => {
    expect(normalizeBrowserUrl('example.com/docs')).toBe('https://example.com/docs');
    expect(normalizeBrowserUrl('xps.example.ts.net:3000')).toBe(
      'http://xps.example.ts.net:3000'
    );
    expect(normalizeBrowserUrl('svelte runes')).toBe(
      'https://www.google.com/search?q=svelte%20runes'
    );
  });

  it('preserves explicit supported browser schemes', () => {
    expect(normalizeBrowserUrl('https://localhost:3000')).toBe('https://localhost:3000');
    expect(normalizeBrowserUrl('about:blank')).toBe('about:blank');
  });
});

describe('Device-aware browser navigation helpers', () => {
  it.each(['localhost', 'app.localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])(
    'recognizes %s as loopback',
    (hostname) => expect(isLoopbackBrowserHostname(hostname)).toBe(true)
  );

  it('uses explicit and default HTTP ports', () => {
    expect(browserUrlPort(new URL('http://localhost:3000'))).toBe(3000);
    expect(browserUrlPort(new URL('http://localhost'))).toBe(80);
    expect(browserUrlPort(new URL('https://localhost'))).toBe(443);
  });
});
