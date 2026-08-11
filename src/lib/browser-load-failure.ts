export interface BrowserLoadFailure {
  kind: 'network' | 'http';
  url: string;
  title: string;
  description: string;
  code: string;
  errorCode: number;
  httpFallbackUrl: string | null;
}

export interface FailedLoadDetails {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
  isMainFrame: boolean;
}

export interface HttpResponseDetails {
  url: string;
  httpResponseCode: number;
  httpStatusText: string;
  isMainFrame: boolean;
}

export function browserFailureFromFailedLoad(
  event: FailedLoadDetails
): BrowserLoadFailure | null {
  if (event.errorCode === -3 || !event.isMainFrame) return null;
  const url = event.validatedURL;
  const host = displayHost(url);
  const known = NETWORK_FAILURES[event.errorCode];
  const code = event.errorDescription || `NETWORK_ERROR_${Math.abs(event.errorCode)}`;
  return {
    kind: 'network',
    url,
    title: known?.title(host) ?? `${host || 'This page'} could not be reached`,
    description: known?.description
      ?? 'The browser could not complete the connection. Check the address and try again.',
    code,
    errorCode: event.errorCode,
    httpFallbackUrl: url.startsWith('https://')
      ? `http://${url.slice('https://'.length)}`
      : null
  };
}

export function browserFailureFromHttpResponse(
  event: HttpResponseDetails
): BrowserLoadFailure | null {
  if (!event.isMainFrame || event.httpResponseCode < 400) return null;
  const status = event.httpStatusText.trim();
  return {
    kind: 'http',
    url: event.url,
    title: `HTTP ${event.httpResponseCode}${status ? ` ${status}` : ''}`,
    description: 'The server returned an error response for this page.',
    code: `HTTP_${event.httpResponseCode}`,
    errorCode: event.httpResponseCode,
    httpFallbackUrl: null
  };
}

const NETWORK_FAILURES: Record<number, {
  title: (host: string) => string;
  description: string;
}> = {
  [-102]: {
    title: (host) => `${host || 'The server'} refused to connect`,
    description: 'The server is not accepting connections. Check that it is running and listening on this address.'
  },
  [-105]: {
    title: (host) => `${host || 'The server'} could not be found`,
    description: 'Check the hostname for typing errors and verify your network or DNS configuration.'
  },
  [-106]: {
    title: () => 'No internet connection',
    description: 'Check your network connection, cables, router, or proxy settings.'
  },
  [-118]: {
    title: (host) => `${host || 'The server'} took too long to respond`,
    description: 'The connection timed out before the server returned a response.'
  },
  [-202]: {
    title: (host) => `${host || 'This site'} has an invalid certificate`,
    description: 'The certificate authority is not trusted by Chromium.'
  }
};

function displayHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
