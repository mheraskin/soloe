import { describe, expect, it, vi } from 'vitest';
import type { DeviceDescriptor } from '@shared/types/devices.js';
import {
  SoloeDeviceDescriptionError,
  describeSoloeEndpoint,
  probeSoloeEndpoint
} from './SoloeEndpointProbe.js';

const DESCRIPTOR: DeviceDescriptor = {
  schemaVersion: 1,
  deviceId: '11111111-1111-4111-8111-111111111111',
  name: 'Alpha',
  platform: 'linux',
  serverEpoch: '22222222-2222-4222-8222-222222222222',
  service: { name: 'soloe-server', version: '0.1.0' },
  protocol: { current: 1, minimum: 1, maximum: 1 },
  capabilities: { revision: 'revision-1', features: ['device.describe.v1'] }
};

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

  it('fetches and negotiates an authenticated bounded Device descriptor', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(DESCRIPTOR), {
      status: 200,
      headers: { 'content-type': 'application/json' }
      })
    );

    await expect(describeSoloeEndpoint(
      'https://alpha.tail1234.ts.net',
      fetchImpl,
      { token: 'secret-token' }
    )).resolves.toEqual({
      descriptor: DESCRIPTOR,
      compatibility: { status: 'compatible', negotiatedVersion: 1 }
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'https://alpha.tail1234.ts.net/api/device/describe'
    );
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'include',
      headers: {
        accept: 'application/json',
        authorization: 'Bearer secret-token'
      }
    });
  });

  it('rejects malformed and oversized Device descriptors', async () => {
    const malformed = describeSoloeEndpoint(
      'https://alpha.tail1234.ts.net',
      async () => new Response(JSON.stringify({ ...DESCRIPTOR, deviceId: 'alpha' }))
    );
    await expect(malformed).rejects.toMatchObject({
      code: 'malformed_descriptor'
    } satisfies Partial<SoloeDeviceDescriptionError>);

    const oversized = describeSoloeEndpoint(
      'https://alpha.tail1234.ts.net',
      async () => new Response('x'.repeat(32 * 1024 + 1))
    );
    await expect(oversized).rejects.toMatchObject({
      code: 'descriptor_too_large'
    } satisfies Partial<SoloeDeviceDescriptionError>);
  });

  it('reports protocol incompatibility without trusting the endpoint as compatible', async () => {
    const result = await describeSoloeEndpoint(
      'https://alpha.tail1234.ts.net',
      async () => new Response(JSON.stringify({
        ...DESCRIPTOR,
        protocol: { current: 3, minimum: 3, maximum: 3 }
      })),
      { clientProtocol: { current: 1, minimum: 1, maximum: 1 } }
    );
    expect(result.compatibility).toEqual({
      status: 'client-upgrade-required',
      negotiatedVersion: null
    });
  });

  it('can bootstrap the Tailscale identity cookie before describing a Device', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      if (fetchImpl.mock.calls.length === 1) return new Response(null, { status: 401 });
      if (init?.method === 'POST') {
        return new Response(null, {
          status: 204,
          headers: { 'set-cookie': 'soloe_token=opaque; HttpOnly; Secure; Path=/' }
        });
      }
      return new Response(JSON.stringify(DESCRIPTOR));
    });

    await expect(describeSoloeEndpoint(
      'https://alpha.tail1234.ts.net',
      fetchImpl,
      { bootstrapTailscale: true }
    )).resolves.toMatchObject({ descriptor: DESCRIPTOR });
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe(
      'https://alpha.tail1234.ts.net/__soloe/auth/tailscale'
    );
    expect(fetchImpl.mock.calls[2]?.[1]?.headers).toMatchObject({
      cookie: 'soloe_token=opaque'
    });
  });
});
