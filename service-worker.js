/* HEAL-SL Health Quick Checkup — offline app shell */
const CACHE = "heal-sl-v9";
const SHELL = [
  "./",
  "index.html",
  "qrcode.min.js",
  "manifest.webmanifest",
  "healsl.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return; // never cache POST/sync calls

  const url = new URL(req.url);
  // App navigations → serve cached shell (works fully offline)
  if (req.mode === "navigate") {
    e.respondWith(caches.match("index.html").then((r) => r || fetch(req)));
    return;
  }
  // Only manage same-origin assets; let Google Sheet/JSONP calls pass through
  if (url.origin !== self.location.origin) return;

  // Cache-first, then network; cache new same-origin GETs
  e.respondWith(
    caches.match(req).then((cached) =>
      cached ||
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => cached)
    )
  );
});
