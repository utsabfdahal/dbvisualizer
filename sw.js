/* Service worker: cache the app shell so the tools work fully offline. */
var CACHE = 'dbv-cache-v2';

var ASSETS = [
  'index.html',
  'data-viewer.html',
  'json-viewer.html',
  'css/style.css',
  'css/data-viewer.css',
  'css/json-viewer.css',
  'js/parser.js',
  'js/layout.js',
  'js/graph-tools.js',
  'js/diagram.js',
  'js/main.js',
  'js/data-viewer.js',
  'js/sql-data-parser.js',
  'js/json-viewer.js',
  'js/pwa.js',
  'manifest.webmanifest',
  'icon.svg'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // Cache best-effort: a single 404 shouldn't abort the whole install.
      return Promise.all(ASSETS.map(function (url) {
        return cache.add(url).catch(function () { /* ignore missing */ });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  // Only handle same-origin requests; let the CDN (e.g. AlaSQL) go to network.
  if (url.origin !== self.location.origin) return;

  // Navigation requests: network-first so updates show, fall back to cache offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () {
        return caches.match(req).then(function (m) { return m || caches.match('index.html'); });
      })
    );
    return;
  }

  // Other assets: stale-while-revalidate — serve cache instantly for speed,
  // refresh it from the network in the background so updates arrive next load.
  event.respondWith(
    caches.match(req).then(function (cached) {
      var networkFetch = fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || networkFetch;
    })
  );
});
