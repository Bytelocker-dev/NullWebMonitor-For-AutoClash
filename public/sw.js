const CACHE_NAME = "xor-cache-v3";
self.addEventListener("install", (event) => { self.skipWaiting(); });
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => { event.respondWith(fetch(event.request)); });
