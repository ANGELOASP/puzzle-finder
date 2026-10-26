const CACHE_NAME = 'puzzlefinder-v27';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/app.js',
  '/grid.js',
  '/workspace.js',
  '/camera.js',
  '/search.js',
  '/session.js',
  '/learn.js',
  '/shot.js',
  '/collab.js',
  '/atlas.js',
  '/multi.js',
  '/bank.js',
  '/manifest.json',
  '/favicon.png',
  '/favicon-32.png',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/logo.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Rede primeiro para os arquivos do app (cada deploy chega na hora); cache só quando offline.
// Requisições de outros domínios (API, Supabase, CDNs) passam direto.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match('/index.html')))
  );
});
