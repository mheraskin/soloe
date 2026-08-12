type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

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
