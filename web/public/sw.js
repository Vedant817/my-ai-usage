/* Usage PWA service worker: app-shell + cache-first for GET /v1/summary. */
const SHELL = "usage-shell-v1";
const API = "usage-api-v1";
const SHELL_URLS = ["/", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(SHELL_URLS).catch(() => {})).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL && k !== API).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Cache-first for same-origin navigation / shell
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((m) => m || caches.match("/"))),
    );
    return;
  }

  // Cache-first for API summary (cross-origin allowed): serve cache, revalidate in background
  if (url.pathname.includes("/v1/summary")) {
    event.respondWith(
      caches.open(API).then((cache) =>
        cache.match(req).then((cached) => {
          const net = fetch(req)
            .then((res) => {
              if (res.ok) cache.put(req, res.clone()).catch(() => {});
              return res;
            })
            .catch(() => cached);
          return cached || net;
        }),
      ),
    );
  }
});
