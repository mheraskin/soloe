import {
  MAX_DEVICE_DESCRIPTOR_BYTES,
  negotiateDeviceProtocol,
  parseDeviceDescriptor,
  type DeviceDescriptor,
  type DeviceProtocolCompatibility,
  type DeviceProtocolRange
} from '@shared/types/devices.js';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface DescribeSoloeEndpointOptions {
  token?: string;
  timeoutMs?: number;
  clientProtocol?: DeviceProtocolRange;
  bootstrapTailscale?: boolean;
}

export interface DescribedSoloeEndpoint {
  descriptor: DeviceDescriptor;
  compatibility: DeviceProtocolCompatibility;
}

export async function probeSoloeEndpoint(
  endpoint: string,
  fetchImpl: FetchLike,
  timeoutMs = 2_000
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(new URL('/__soloe/ready', endpoint), {
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal
    });
    if (!response.ok) return false;
    const payload = await response.json() as { ready?: unknown; backend?: unknown };
    return payload.ready === true
      && (!('backend' in payload) || typeof payload.backend === 'string');
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function describeSoloeEndpoint(
  endpoint: string,
  fetchImpl: FetchLike,
  options: DescribeSoloeEndpointOptions = {}
): Promise<DescribedSoloeEndpoint> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 2_000);
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    let response = await fetchDescription(endpoint, fetchImpl, headers, controller.signal);
    if (response.status === 401 && options.bootstrapTailscale) {
      const authenticated = await fetchImpl(new URL('/__soloe/auth/tailscale', endpoint), {
        method: 'POST',
        cache: 'no-store',
        credentials: 'include',
        redirect: 'error',
        signal: controller.signal
      });
      if (authenticated.ok) {
        const cookie = authenticated.headers.get('set-cookie')?.split(';', 1)[0];
        response = await fetchDescription(
          endpoint,
          fetchImpl,
          cookie ? { ...headers, cookie } : headers,
          controller.signal
        );
      }
    }
    if (!response.ok) {
      throw new SoloeDeviceDescriptionError(
        response.status === 401 ? 'unauthorized' : 'http_error',
        `Soloe Device description returned HTTP ${response.status}.`
      );
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_DEVICE_DESCRIPTOR_BYTES) {
      throw descriptorTooLarge();
    }
    const source = await readBoundedBody(response, MAX_DEVICE_DESCRIPTOR_BYTES);
    let rawDescriptor: unknown;
    try {
      rawDescriptor = JSON.parse(source);
    } catch {
      throw new SoloeDeviceDescriptionError(
        'malformed_descriptor',
        'Soloe Device description is not valid JSON.'
      );
    }
    let descriptor: DeviceDescriptor;
    try {
      descriptor = parseDeviceDescriptor(rawDescriptor);
    } catch (error) {
      throw new SoloeDeviceDescriptionError(
        'malformed_descriptor',
        error instanceof Error ? error.message : 'Soloe Device description is invalid.'
      );
    }
    return {
      descriptor,
      compatibility: negotiateDeviceProtocol(
        descriptor.protocol,
        options.clientProtocol
      )
    };
  } catch (error) {
    if (error instanceof SoloeDeviceDescriptionError) throw error;
    if (controller.signal.aborted) {
      throw new SoloeDeviceDescriptionError(
        'timeout',
        'Soloe Device description timed out.'
      );
    }
    throw new SoloeDeviceDescriptionError(
      'unavailable',
      error instanceof Error ? error.message : 'Soloe Device description failed.'
    );
  } finally {
    clearTimeout(timeout);
  }
}

function fetchDescription(
  endpoint: string,
  fetchImpl: FetchLike,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<Response> {
  return fetchImpl(new URL('/api/device/describe', endpoint), {
    method: 'GET',
    cache: 'no-store',
    credentials: 'include',
    redirect: 'error',
    headers,
    signal
  });
}

export class SoloeDeviceDescriptionError extends Error {
  constructor(
    readonly code:
      | 'unauthorized'
      | 'http_error'
      | 'timeout'
      | 'unavailable'
      | 'descriptor_too_large'
      | 'malformed_descriptor',
    message: string
  ) {
    super(message);
    this.name = 'SoloeDeviceDescriptionError';
  }
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) throw descriptorTooLarge();
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

function descriptorTooLarge(): SoloeDeviceDescriptionError {
  return new SoloeDeviceDescriptionError(
    'descriptor_too_large',
    `Soloe Device description exceeds ${MAX_DEVICE_DESCRIPTOR_BYTES} bytes.`
  );
}
