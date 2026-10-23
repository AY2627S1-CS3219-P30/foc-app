const CACHE_NAME = "nuquest-shell-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Network-first, falling back to cache (and, for a page, to the login shell)
// so a page you've already visited still loads offline. Only this origin's
// page loads and the build's static assets are handled; anything else, an API
// call included, goes to the network untouched, whichever origin the APIs are
// on. So data is never served stale, and a JSON caller never gets a page.
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const page = request.mode === "navigate";
  if (!page && !url.pathname.startsWith("/_next/static/")) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        return page ? ((await caches.match("/login")) ?? Response.error()) : Response.error();
      })
  );
});
