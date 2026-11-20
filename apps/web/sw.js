// Personal-use offline shell. API and token-bearing requests are never cached.
const CACHE = 'msc-shell-v2';
const ASSETS = [
    '/',
    '/index.html',
    '/app.js',
    '/style.css',
    '/manifest.webmanifest',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
];
const SHELL_PATHS = new Set(ASSETS);

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()),
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => Promise.all(
            keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
        )).then(() => self.clients.claim()),
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith('/v1/')) return;

    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    if (response.ok) {
                        const copy = response.clone();
                        caches.open(CACHE).then((cache) => cache.put('/', copy)).catch(() => {});
                    }
                    return response;
                })
                .catch(() => caches.match('/')),
        );
        return;
    }

    if (!SHELL_PATHS.has(url.pathname)) return;
    // Network-first so a deployed update reaches an installed client; the
    // cached copy is only the offline fallback.
    event.respondWith(
        fetch(request)
            .then((response) => {
                if (response.ok) {
                    const copy = response.clone();
                    caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
                }
                return response;
            })
            .catch(() => caches.match(request)),
    );
});
