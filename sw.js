// sw.js — lives at the repo root so it can control the whole site.
//
// Scope: makes the REPRESENTATIVE and CUSTOMER pages open even with zero
// signal, by keeping a local copy of the app shell (HTML/CSS/JS + the
// third-party scripts those pages load). Actual data (customers,
// transactions) is handled separately by js/offline-queue.js — this
// file's only job is making sure the app itself is there to open in the
// first place.
//
// Strategy:
//   - HTML pages: network-first with a cache fallback, so you get the
//     latest version when online, but the last-seen version still opens
//     when you don't have signal.
//   - Our OWN JS/CSS (same origin): also network-first with a cache
//     fallback, for the same reason — these change on every deploy, and
//     cache-first here previously meant deployed fixes could silently
//     never reach devices that had already opened the app.
//   - Third-party CDN scripts (different origin, version-pinned in their
//     URLs already): cache-first, since a pinned URL never changes and
//     this is what makes the app open instantly / work offline.
//   - Supabase API calls are NEVER cached here — those either succeed
//     live or fail and get handled by the offline queue; caching stale
//     financial data would be actively dangerous.

const CACHE_NAME = 'wag-shell-v3'; // bumped again: v2 already had JS cached
// before THIS deploy's changes (Add Email/Address, mandatory payment PIN,
// the customer/agent delete fix) existed. See the fetch handler below —
// this version has also been changed so this stops being a recurring
// problem: same-origin JS/CSS is now network-first (was cache-first),
// so future deploys of OUR OWN files take effect immediately without
// needing another version bump. Only third-party CDN scripts (which
// rarely change) still use cache-first.

const APP_SHELL = [
  'index.html',
  'login.html',
  'register.html',
  'representative/dashboard.html',
  'representative/collections.html',
  'representative/customer-search.html',
  'representative/requests.html',
  'representative/settings.html',
  'customer/dashboard.html',
  'customer/calendar.html',
  'customer/settings.html',
  'customer/transactions.html',
  'css/shared.css',
  'css/shared.css?v=cal5',
  'css/representative.css',
  'css/customer.css',
  'css/polish.css',
  'js/auth.js',
  'js/representative.js',
  'js/customer.js',
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
    // Network-first for pages: try live, fall back to the last cached copy,
    // and if we truly have nothing for this page, hand back an actual
    // offline page rather than nothing — returning "nothing" from a fetch
    // handler crashes the browser with a "response is null" error instead
    // of just failing gracefully.
    event.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        return res;
      }).catch(async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        return new Response(
          '<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px 20px;color:#666;">' +
          '<h2>No connection</h2><p>This page hasn\'t been opened on this device before, so it needs an internet ' +
          'connection to load the first time. Please reconnect and try again.</p></body></html>',
          { status: 200, headers: { 'Content-Type': 'text/html' } }
        );
      })
    );
    return;
  }

  // Third-party CDN libraries (supabase-js, emailjs, html2canvas): cache-first.
  // These are pinned to specific versions in the <script> tags themselves,
  // so they never change under a given URL — safe to cache aggressively,
  // and doing so is what makes the app load instantly / work offline.
  if (url.origin !== self.location.origin) {
    event.respondWith(
      caches.match(req).then(cached => cached || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        return res;
      }).catch(() => new Response('', { status: 408, statusText: 'Offline and not cached' })))
    );
    return;
  }

  // Our OWN JS/CSS: network-first with a cache fallback — same strategy as
  // HTML above, and for the same reason. These files change on every
  // deploy; cache-first here is what caused several rounds of "I shipped a
  // fix but the phone is still running the old code" bugs, because a
  // static CACHE_NAME never invalidates itself. Network-first means a new
  // deploy is visible immediately for anyone online, while still falling
  // back to the last-cached copy when truly offline.
  event.respondWith(
    fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
      return res;
    }).catch(() => caches.match(req).then(cached => cached || new Response('', { status: 408, statusText: 'Offline and not cached' })))
  );
});
