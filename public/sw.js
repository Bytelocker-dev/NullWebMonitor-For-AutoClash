// Network-only service worker.
//
// It exists purely so Android Chrome offers "Install app" — that requires a
// service worker with a fetch handler. It deliberately caches nothing: this
// panel shows live bot state, and a stale cached shell would be worse than
// useless. iOS does not need this file at all for Add to Home Screen.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => event.respondWith(fetch(event.request)));
