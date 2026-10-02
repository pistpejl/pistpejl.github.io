/*
 * Rot-service-worker (v14): Appen ligger nu under /app med egen service worker
 * (/app/sw.js, scope /app/). Den här ersätter den gamla rot-SW:n (scope /) som
 * annars kunde visa den gamla appen på /. Den rensar gamla cacher, avregistrerar
 * sig och laddar om öppna flikar en gång. Inga fetch-anrop fångas.
 */
const VERSION = 'v14';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        const m = /^pistpejl-(pages|assets)-v(\d+)$/.exec(name);
        if (m && Number(m[2]) < 14) await caches.delete(name);
      }
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const c of clients) {
        try {
          c.navigate(c.url);
        } catch (e) {
          // ignore
        }
      }
    })()
  );
});
