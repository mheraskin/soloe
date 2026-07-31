const CACHE_NAME = 'soloe-shell-v1';
const CACHEABLE_DESTINATIONS = new Set(['script', 'style', 'font', 'image', 'manifest']);
const DEVELOPMENT_PREFIXES = ['/src/', '/@vite/', '/@fs/', '/node_modules/'];

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (DEVELOPMENT_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return;
  if (!CACHEABLE_DESTINATIONS.has(request.destination)) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        const cacheControl = response.headers.get('cache-control') ?? '';
        if (response.ok && !cacheControl.includes('no-store')) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
        }
        return response;
      })
      .catch(async () => (await caches.match(request)) ?? Response.error())
  );
});
