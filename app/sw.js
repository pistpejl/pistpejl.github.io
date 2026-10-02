/*
 * Pistpejl service worker — offline-karta för webben.
 *
 * Scope = appens bas ("/app/" på pistpejl.github.io, "/" lokalt). Strategier:
 *  - Sidnavigering (/, /map, /chat …): nätet först (4 s timeout), annars
 *    cachad HTML för rutten, annars index.html (SPA-fallback).
 *  - /_expo/** och /assets/** (hashade bundlar, kartbilden): cache först.
 *  - Övriga filer på samma origin: stale-while-revalidate.
 *  - Andra origins (t.ex. Supabase realtid) rörs aldrig.
 */
const VERSION = 'v16'; // v16: engelska (i18n). v15: Hitta (mat/afterski/shops). v14: lösenordsspärr (webb). v13: PistPejl-logga, ikoner och manifest (v12: appen flyttad till /app). Höj vid varje deploy
const PAGES = `pistpejl-pages-${VERSION}`;
const ASSETS = `pistpejl-assets-${VERSION}`;
const BASE = new URL(self.registration.scope).pathname; // "/app/"
const ROUTE_FILES = ['index.html', 'map.html', 'home.html', 'join.html', 'create.html', 'chat.html', 'admin.html'];
const NAV_TIMEOUT_MS = 4000;
const MAX_ENTRY_BUNDLES = 3;

function htmlKey(url) {
  let p = url.pathname;
  if (p.endsWith('/')) p += 'index.html';
  else if (!/\.[a-z0-9]+$/i.test(p)) p += '.html';
  return p;
}

function isAsset(url) {
  return url.pathname.startsWith(BASE + '_expo/') || url.pathname.startsWith(BASE + 'assets/');
}

async function putIfOk(cacheName, key, res) {
  if (!res || !res.ok || res.type === 'opaque') return;
  const cache = await caches.open(cacheName);
  await cache.put(key, res);
}

async function cacheUrl(url) {
  try {
    const u = new URL(url, self.location.href);
    if (u.origin !== self.location.origin) return;
    const name = isAsset(u) ? ASSETS : PAGES;
    const key = isAsset(u) ? u.href : htmlKey(u).endsWith('.html') ? htmlKey(u) : u.href;
    const cache = await caches.open(name);
    if (await cache.match(key)) return;
    const res = await fetch(u.href, { cache: 'no-cache' });
    await putIfOk(name, key, res);
  } catch (e) {
    // offline under förcachning — försök igen senare
  }
}

/** Hitta skript/länkar i en HTML-sida (entry-bundle, favicon …). */
function assetUrlsFromHtml(html) {
  const out = [];
  const re = /(?:src|href)="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const v = m[1];
    if (v.startsWith(BASE + '_expo/') || v.startsWith(BASE + 'assets/') || v === BASE + 'favicon.ico') out.push(v);
  }
  return out;
}

async function trimOldBundles() {
  const cache = await caches.open(ASSETS);
  const keys = await cache.keys();
  const entries = keys.filter((r) => /\/_expo\/static\/js\/web\/entry-[^/]+\.js$/.test(r.url));
  const excess = entries.length - MAX_ENTRY_BUNDLES;
  for (let i = 0; i < excess; i++) await cache.delete(entries[i]);
}

async function precache() {
  const cache = await caches.open(PAGES);
  await Promise.all(
    ROUTE_FILES.map(async (f) => {
      try {
        const res = await fetch(BASE + f, { cache: 'no-cache' });
        if (!res.ok) return;
        if (f === 'index.html') {
          const html = await res.clone().text();
          await Promise.all(assetUrlsFromHtml(html).map(cacheUrl));
        }
        await cache.put(BASE + f, res);
      } catch (e) {
        // ignore
      }
    })
  );
  await cacheUrl(BASE + 'favicon.ico');
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([PAGES, ASSETS]);
      for (const name of await caches.keys()) {
        if (name.startsWith('pistpejl-') && !keep.has(name)) await caches.delete(name);
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'CACHE_URLS' && Array.isArray(data.urls)) {
    event.waitUntil(Promise.all(data.urls.map(cacheUrl)).then(trimOldBundles));
  }
});

async function handleNavigate(req, url) {
  const key = htmlKey(url);
  const cache = await caches.open(PAGES);
  const network = fetch(req).then(async (res) => {
    if (res && res.ok) {
      await cache.put(key, res.clone());
      // Ny deploy → cacha den nya entry-bundlen direkt
      if (key === BASE + 'index.html' || key === BASE + 'map.html') {
        res
          .clone()
          .text()
          .then((html) => Promise.all(assetUrlsFromHtml(html).map(cacheUrl)))
          .then(trimOldBundles)
          .catch(() => {});
      }
    }
    return res;
  });
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NAV_TIMEOUT_MS));
  try {
    const res = await Promise.race([network, timeout]);
    if (res) return res;
  } catch (e) {
    // offline
  }
  const cached = (await cache.match(key)) || (await cache.match(BASE + 'index.html'));
  if (cached) return cached;
  try {
    return await network; // ingen cache än — vänta på nätet
  } catch (e) {
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Pistpejl</title><p style="font-family:sans-serif;padding:24px">Ingen täckning och sidan är inte sparad offline än. Öppna Pistpejl en gång med täckning.</p>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(ASSETS);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && res.ok) await cache.put(req, res.clone());
    return res;
  } catch (e) {
    return Response.error();
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(PAGES);
  const hit = await cache.match(req);
  const network = fetch(req)
    .then(async (res) => {
      if (res && res.ok) await cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  if (hit) return hit;
  const res = await network;
  return res || Response.error();
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === BASE + 'sw.js') return;
  if (req.mode === 'navigate') {
    event.respondWith(handleNavigate(req, url));
    return;
  }
  if (isAsset(url)) {
    event.respondWith(cacheFirst(req));
    return;
  }
  event.respondWith(staleWhileRevalidate(req));
});
