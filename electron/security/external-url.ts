const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:']);

export function assertSafeExternalUrl(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('External URL must be a string');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('External URL must be absolute');
  }

  if (!ALLOWED_EXTERNAL_PROTOCOLS.has(url.protocol)) {
    throw new Error(`External URL protocol is not allowed: ${url.protocol}`);
  }

  return url.toString();
}
