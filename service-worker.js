/* ═══════════════════════════════════════════════════════════════
   PROTOCOL 90 — Service Worker  (v5-stable)
   Strategy: Lifecycle-safe, Android-optimized, update-aware.

   Design principles:
   ─────────────────
   • Navigation (HTML page) → NETWORK-FIRST, with offline fallback.
     Prevents Android Chrome from restoring a frozen/stale painted
     snapshot when the PWA relaunches from the home screen.

   • Static assets (fonts, images from CDN) → CACHE-FIRST.
     These never change between launches; cache them for speed.

   • Dynamic/API requests → NETWORK-FIRST, no caching.
     Ensures gamification state, XP, streaks are never served stale.

   • On update → skipWaiting + clients.claim for instant activation.
     Sends a message to open clients so they can reload cleanly.

   • Aggressive old-cache pruning on activate prevents disk bloat
     and stale-asset serving after app updates.
═══════════════════════════════════════════════════════════════ */

const CACHE_NAME   = 'p90-shell-v5';
const FONT_CACHE   = 'p90-fonts-v1';   // fonts cache; long-lived
const ASSET_CACHE  = 'p90-assets-v1';  // other static assets

/* Fonts to precache on install (loaded by the app's <link> tag) */
const PRECACHE_FONTS = [
  'https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Barlow+Condensed:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@300;400;500;700&display=swap'
];

/* All known caches — used during activation to prune stale ones */
const KNOWN_CACHES = [CACHE_NAME, FONT_CACHE, ASSET_CACHE];

/* ─── INSTALL ─────────────────────────────────────────────── */
self.addEventListener('install', event => {
  /*
   * Skip waiting immediately so the new SW takes over as soon as
   * it installs — no need for user to close all tabs first.
   * Safe here because our navigation requests are network-first,
   * so a fresh SW won't serve stale HTML.
   */
  self.skipWaiting();

  event.waitUntil(
    caches.open(FONT_CACHE).then(cache => {
      /* Best-effort font precache; don't fail install if offline */
      return cache.addAll(PRECACHE_FONTS).catch(() => {});
    })
  );
});

/* ─── ACTIVATE ────────────────────────────────────────────── */
self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      /* 1. Prune any old/unknown caches to prevent stale data */
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(key => !KNOWN_CACHES.includes(key))
          .map(key => caches.delete(key))
      );

      /* 2. Immediately take control of all open clients.
            Combined with skipWaiting above, this means the new SW
            handles every open tab/window from this moment forward —
            critical for correct Android resume behavior. */
      await self.clients.claim();

      /* 3. Notify open clients that a new SW is now active.
            The app listens for this and can trigger a safe reload. */
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach(client => {
        client.postMessage({ type: 'SW_ACTIVATED', cache: CACHE_NAME });
      });
    })()
  );
});

/* ─── FETCH ───────────────────────────────────────────────── */
self.addEventListener('fetch', event => {
  const req = event.request;

  /* Only handle GET requests */
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  /* ── 1. Navigation requests (the HTML app shell) ──────────
   *  ALWAYS network-first. This is the most important rule for
   *  Android PWA stability:
   *  - Prevents Chrome from replaying a stale painted snapshot
   *  - Ensures the app always loads fresh JS/CSS on relaunch
   *  - Falls back to cache only if truly offline
   */
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(response => {
          /* Cache a fresh copy for offline fallback */
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
          }
          return response;
        })
        .catch(async () => {
          /* Offline fallback: serve cached shell if available */
          const cached = await caches.match(req);
          return cached || new Response(
            '<html><body style="background:#07080D;color:#7DF9FF;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center"><div><div style="font-size:3rem;margin-bottom:16px">🔥</div><div style="font-size:1.2rem;margin-bottom:8px">PROTOCOL 90</div><div style="font-size:.75rem;opacity:.6">You\'re offline. Reconnect to resume your mission.</div></div></body></html>',
            { headers: { 'Content-Type': 'text/html' } }
          );
        })
    );
    return;
  }

  /* ── 2. Google Fonts (CSS + woff2) → cache-first ─────────
   *  Fonts never change for a given request URL. Cache them
   *  aggressively to avoid FOUT and speed up cold starts.
   */
  if (
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'
  ) {
    event.respondWith(
      caches.open(FONT_CACHE).then(async cache => {
        const cached = await cache.match(req);
        if (cached) return cached;
        const response = await fetch(req);
        if (response.ok) cache.put(req, response.clone());
        return response;
      })
    );
    return;
  }

  /* ── 3. Other same-origin static assets → cache-first ────
   *  Images, icons, etc. served from the same origin.
   */
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(ASSET_CACHE).then(async cache => {
        const cached = await cache.match(req);
        if (cached) return cached;
        const response = await fetch(req);
        if (response.ok) cache.put(req, response.clone());
        return response;
      })
    );
    return;
  }

  /* ── 4. Everything else → network only ───────────────────
   *  Cross-origin requests not covered above (analytics, APIs,
   *  etc.) go straight to network. Never cache dynamic data.
   */
  /* fall through — browser handles it normally */
});

/* ─── MESSAGE HANDLER ─────────────────────────────────────── */
self.addEventListener('message', event => {
  const data = event.data;
  if (!data) return;

  /* Allow the app to manually trigger skipWaiting if it detects
     a waiting SW (e.g. after a controllerchange prompt) */
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  /* PING → PONG: lets the app verify the SW is alive after resume */
  if (data.type === 'PING') {
    event.source && event.source.postMessage({
      type: 'PONG',
      cache: CACHE_NAME,
      ts: Date.now()
    });
  }
});
