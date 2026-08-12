import { describe, expect, it, vi } from 'vitest';
import { probeSoloeEndpoint } from './SoloeEndpointProbe.js';

describe('probeSoloeEndpoint', () => {
  it('accepts only a ready Soloe browser host response', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL) =>
      new Response(JSON.stringify({ ready: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    await expect(
      probeSoloeEndpoint('https://alpha.tail1234.ts.net', fetchImpl)
    ).resolves.toBe(true);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'https://alpha.tail1234.ts.net/__soloe/ready'
    );
  });

  it('treats invalid, failed, and non-ready responses as unavailable', async () => {
    await expect(probeSoloeEndpoint(
      'https://alpha.tail1234.ts.net',
      async () => new Response(JSON.stringify({ ready: false }))
    )).resolves.toBe(false);
    await expect(probeSoloeEndpoint(
      'https://alpha.tail1234.ts.net',
      async () => new Response(JSON.stringify({ ready: true, backend: null }))
    )).resolves.toBe(false);
    await expect(probeSoloeEndpoint(
      'https://alpha.tail1234.ts.net',
      async () => { throw new Error('offline'); }
    )).resolves.toBe(false);
  });
});
