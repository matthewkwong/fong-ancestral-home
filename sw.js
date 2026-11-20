// Keeps the big splat file on the visitor's device after the first download (Cache Storage).
// Change the splat's file name (for example scene-hq-v2.spz) whenever you replace it, and the old copy is dropped automatically.
const CACHE = "splat-v1";
const BIG = /\.(spz|sog|ply|splat|ksplat)(\?|$)/i;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || req.headers.has("range") || !BIG.test(req.url)) return;
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req.url);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && res.status === 200) {
        // keep a copy once the whole file has arrived (an interrupted download is never stored)
        e.waitUntil(
          cache
            .put(req.url, res.clone())
            .then(async () => {
              for (const k of await cache.keys()) if (k.url !== req.url) await cache.delete(k);
            })
            .catch(() => {})
        );
      }
      return res;
    })()
  );
});
