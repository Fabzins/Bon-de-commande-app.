const CACHE_NAME = 'bc-app-v20-android';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './fonts.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/jspdf.umd.min.js',
  './vendor/jspdf.plugin.autotable.min.js',
  './fonts/inter-latin-400-normal.woff2',
  './fonts/inter-latin-500-normal.woff2',
  './fonts/inter-latin-600-normal.woff2',
  './fonts/inter-latin-700-normal.woff2',
  './fonts/fraunces-latin-500-normal.woff2',
  './fonts/fraunces-latin-600-normal.woff2',
  './fonts/fraunces-latin-700-normal.woff2',
  './fonts/jetbrains-mono-latin-500-normal.woff2',
  './fonts/jetbrains-mono-latin-600-normal.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.all(
        ASSETS.map((url) => cache.add(url).catch(() => {}))
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request).then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
      // App shell: cached version first for reliable offline startup.
      if (event.request.mode === 'navigate') return cached || network;
      return cached || network;
    })
  );
});
