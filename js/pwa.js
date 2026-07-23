/* Register the service worker for offline / installable (PWA) support. */
(function () {
  'use strict';
  if (!('serviceWorker' in navigator)) return;
  // Service workers require http(s); skip when opened via file://
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function (err) {
      console.warn('Service worker registration failed:', err);
    });
  });
})();
