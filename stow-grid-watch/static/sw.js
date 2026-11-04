// App-shell cache only. Status data is never served from this cache;
// app.js keeps its own last copy and labels it "offline".
const SHELL = "sgw-shell-v14";
const FILES = ["./", "index.html", "styles.css", "app.js", "manifest.webmanifest", "icons/icon.svg", "icons/apple-touch-icon.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || url.pathname.includes("/api/")) return; // network only
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request)));
});
