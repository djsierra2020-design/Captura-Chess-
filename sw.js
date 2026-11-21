// Guarda la app para que funcione sin internet (el reconocimiento de fotos sí necesita internet).
// Cambia VERSION cada vez que publiques cambios para que los celulares descarguen lo nuevo.
const VERSION = "captura-chess-v6";
const ARCHIVOS = ["./", "index.html", "app.js", "manifest.webmanifest", "vendor/chess.js", "vendor/stockfish-19-lite-single.js", "vendor/stockfish-19-lite-single.wasm",
  "vendor/anthropic.js", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // Claude y demás: siempre a la red
  // Red primero (para recibir cambios) y, sin conexión, la copia guardada.
  e.respondWith(fetch(e.request)
    .then((r) => { if (r.ok) { const copia = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copia)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
