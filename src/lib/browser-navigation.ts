function looksLocalBrowserHost(host: string): boolean {
  if (!host) return false;
  if (host.startsWith(':')) return true;
  if (host.startsWith('[')) {
    const closing = host.indexOf(']');
    if (closing < 0) return false;
    return host.slice(1, closing).toLowerCase() === '::1';
  }
  const hostname = (host.toLowerCase().split(':')[0] ?? '').trim();
  if (!hostname) return false;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (/^127\./.test(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  return /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
}

export function normalizeBrowserUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return 'about:blank';

  // A hostname followed by a port resembles a custom URI scheme. Resolve
  // local addresses first so `localhost:3000` stays inside Chromium instead
  // of being handed to the operating system as a `localhost:` protocol.
  if (trimmed.startsWith(':')) return `http://localhost${trimmed}`;
  const hostPart = trimmed.split(/[\/?#]/, 1)[0] ?? '';
  if (looksLocalBrowserHost(hostPart)) return `http://${trimmed}`;
  if (/^[a-z0-9-]+(?:(?:\.[a-z0-9-]+)+)?:\d{1,5}$/iu.test(hostPart)) {
    return `http://${trimmed}`;
  }

  if (/^[a-z][a-z0-9+\-.]*:/i.test(trimmed)) return trimmed;
  if (!/[.:/]/.test(trimmed)) {
    return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
  }
  return `https://${trimmed}`;
}

export function isLoopbackBrowserHostname(hostname: string): boolean {
  const normalized = hostname.trim().replace(/^\[|\]$/gu, '').toLowerCase();
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '0.0.0.0';
}

export function browserUrlPort(url: URL): number | null {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.port) {
    const port = Number(url.port);
    return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : null;
  }
  return url.protocol === 'https:' ? 443 : 80;
}
