const C = 'rp-v4'
self.addEventListener('install', (e) =&gt; e.waitUntil(caches.open(C).then((c) =&gt; c.addAll(['/report', '/report/manifest.json', '/report/icon.svg']))))
self.addEventListener('activate', (e) =&gt; e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (e) =&gt; {
  const u = e.request.url
  if (u.includes('/report/') &amp;&amp; !u.endsWith('/report')) return
  e.respondWith(caches.match(e.request).then((r) =&gt; r || fetch(e.request)))
})