// tab OS service worker: keeps the shell's fonts and images on hand so the installed app
// opens fast. The page itself is fetched fresh every time (it carries a per-response nonce),
// and nothing under /api is ever cached.
const CACHE = 'tab-os-v2';
const SHELL = ['/inter.woff2', '/geist-mono.woff2', '/os-icon-64.png', '/os-icon-192.png', '/os-wallpaper.jpg', ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `/os-agent-${i}.png`), ...['home', 'agents', 'tasks', 'inbox', 'wallet', 'receipts', 'plug', 'settings', 'card', 'alert', 'doc', 'search', 'key', 'building'].map((n) => `/os-ic-${n}.png`)];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || !SHELL.includes(u.pathname)) return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
