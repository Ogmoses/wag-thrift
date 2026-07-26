// sw.js — lives at the repo root so it can control the whole site.
//
// Scope: makes the REPRESENTATIVE pages open even with zero signal, by
// keeping a local copy of the app shell (HTML/CSS/JS + the third-party
// scripts those pages load). Actual data (customers, transactions) is
// handled separately by js/offline-queue.js — this file's only job is
// making sure the app itself is there to open in the first place.
//
// Strategy:
//   - App shell files: cache-first, so opening the app is instant and
//     works offline, falling back to the network only if something's
//     missing from the cache (e.g. right after a fresh install).
//   - HTML pages specifically: network-first with a cache fallback, so
//     you still get the latest version when online, but the last-seen
//     version still opens when you don't have signal.
//   - Supabase API calls are NEVER cached here — those either succeed
//     live or fail and get handled by the offline queue; caching stale
//     financial data would be actively dangerous.

const CACHE_NAME = 'wag-shell-v1';

const APP_SHELL = [
  'representative/dashboard.html',
  'representative/collections.html',
  'representative/customer-search.html',
  'representative/requests.html',
  'representative/settings.html',
  'css/shared.css',
  'css/representative.css',
  'css/polish.css',
  'js/auth.js',
  'js/representative.js',
  'js/supabase.js',
  'js/utils.js',
  'js/offline-queue.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js',
  'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      // addAll fails entirely if even one request fails — cache what we
      // can individually instead, so one bad CDN fetch doesn't block the
      // whole install.
      Promise.allSettled(APP_SHELL.map(url => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Never touch API calls — Supabase, the Cloudflare Worker, Resend, etc.
  // These must always hit the network live, or fail and be handled by
  // the offline queue. Caching them would risk showing stale balances.
  if (url.hostname.includes('supabase.co') || url.hostname.includes('workers.dev')) {
    return;
  }

  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    // Network-first for pages: try live, fall back to the last cached copy.
    event.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Cache-first for everything else (CSS/JS/CDN libraries).
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
      return res;
    }))
  );
});
