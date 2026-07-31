import { describe, expect, it } from 'vitest';
import {
  browserFailureFromFailedLoad,
  browserFailureFromHttpResponse
} from './browser-load-failure';

describe('browser load failures', () => {
  it('turns a refused localhost connection into a readable main-frame failure', () => {
    expect(browserFailureFromFailedLoad({
      errorCode: -102,
      errorDescription: 'ERR_CONNECTION_REFUSED',
      validatedURL: 'http://localhost:4317/',
      isMainFrame: true
    })).toEqual({
      kind: 'network',
      url: 'http://localhost:4317/',
      title: 'localhost refused to connect',
      description: 'The server is not accepting connections. Check that it is running and listening on this address.',
      code: 'ERR_CONNECTION_REFUSED',
      errorCode: -102,
      httpFallbackUrl: null
    });
  });

  it('ignores cancelled and subframe failures', () => {
    expect(browserFailureFromFailedLoad({
      errorCode: -3,
      errorDescription: 'ERR_ABORTED',
      validatedURL: 'http://localhost:4317/',
      isMainFrame: true
    })).toBeNull();
    expect(browserFailureFromFailedLoad({
      errorCode: -102,
      errorDescription: 'ERR_CONNECTION_REFUSED',
      validatedURL: 'https://ads.example.test/',
      isMainFrame: false
    })).toBeNull();
  });

  it('reports an HTTP 502 response but ignores successful responses', () => {
    expect(browserFailureFromHttpResponse({
      url: 'http://localhost:3000/',
      httpResponseCode: 502,
      httpStatusText: 'Bad Gateway',
      isMainFrame: true
    })).toEqual({
      kind: 'http',
      url: 'http://localhost:3000/',
      title: 'HTTP 502 Bad Gateway',
      description: 'The server returned an error response for this page.',
      code: 'HTTP_502',
      errorCode: 502,
      httpFallbackUrl: null
    });
    expect(browserFailureFromHttpResponse({
      url: 'http://localhost:3000/',
      httpResponseCode: 200,
      httpStatusText: 'OK',
      isMainFrame: true
    })).toBeNull();
  });
});
