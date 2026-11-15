const C = 'rp-v37'
const SHELL = ['/report', '/report/manifest.json', '/report/icon.svg']
self.addEventListener('install', (e) => e.waitUntil(caches.open(C).then((c) => c.addAll(SHELL))))
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== C).map((k) => caches.delete(k)))).then(() => self.clients.claim())
))
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return
  const u = new URL(e.request.url)
  if (u.origin !== self.location.origin) return
  const p = u.pathname
  const shell = p === '/report' || p === '/report/manifest.json' || p === '/report/icon.svg' || p === '/report/sw.js'
  if (!shell) return
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)))
})