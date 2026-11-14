const C = 'rp-v4'
self.addEventListener('install', (e) => e.waitUntil(caches.open(C).then((c) => c.addAll(['/report', '/report/manifest.json', '/report/icon.svg']))))
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (e) => {
  const u = e.request.url
  if (u.includes('/report/') && !u.endsWith('/report')) return
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)))
})