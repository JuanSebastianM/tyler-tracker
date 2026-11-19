// Service worker part for push notifications, loaded by sw.js with importScripts (classic script,
// no modules). Sent by supabase/functions/push; payload: { title, body, path, tag }.
//
//  - Every push shows a notification, whatever it carries: Safari has no invisible pushes and
//    revokes the permission when a push shows nothing ("Safari doesn't support invisible push
//    notifications"), and WebKit revokes subscriptions that break the userVisibleOnly promise.
//    https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
//    https://webkit.org/blog/12945/meet-web-push/
//  - Badge: navigator.setAppBadge works while handling a push on iOS 16.4+ Home Screen apps
//    (https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/); the app clears it.
//  - A tap opens the app on the notification's screen, reusing an open window when there is one.
(() => {
  /** @type {any} */
  const sw = self;
  const FALLBACK = { title: 'Tyler', body: 'Abre la app para ver el aviso. / Open the app to see the alert.', path: '/today', tag: 'tt' };

  /** Keep the worker alive for `p`. Synthetic events (tests) cannot be extended; `p` still runs. */
  const keepAlive = (/** @type {any} */ event, /** @type {Promise<any>} */ p) => {
    try {
      event.waitUntil(p);
    } catch {
      /* untrusted event */
    }
  };

  /** @param {any} data */
  function toNotification(data) {
    const d = data && typeof data === 'object' ? data : {};
    const str = (/** @type {any} */ v, /** @type {string} */ f) => (typeof v === 'string' && v.trim() ? v.slice(0, 200) : f);
    const path = typeof d.path === 'string' && d.path.startsWith('/') ? d.path : FALLBACK.path;
    return {
      title: str(d.title, FALLBACK.title),
      options: {
        body: str(d.body, FALLBACK.body),
        tag: str(d.tag, FALLBACK.tag),
        // A replaced notification (second meal reminder) alerts again.
        renotify: true,
        icon: new URL('./assets/icons/icon-192.png', sw.registration.scope).href,
        badge: new URL('./assets/icons/favicon-32.png', sw.registration.scope).href,
        data: { path },
      },
    };
  }

  sw.addEventListener('push', (/** @type {any} */ event) => {
    let data = null;
    try {
      data = event.data ? event.data.json() : null;
    } catch {
      data = null; // unreadable payload: still show something
    }
    const n = toNotification(data);
    keepAlive(
      event,
      (async () => {
        try {
          await sw.registration.showNotification(n.title, n.options);
        } catch (e) {
          // Only without notification permission; nothing else could be shown. Visible in Web Inspector.
          console.warn('push: showNotification failed', String(e));
          throw e;
        }
        if (typeof sw.navigator?.setAppBadge === 'function') {
          const shown = await sw.registration.getNotifications().catch(() => []);
          await sw.navigator.setAppBadge(shown.length || 1).catch(() => {});
        }
      })(),
    );
  });

  sw.addEventListener('notificationclick', (/** @type {any} */ event) => {
    const path = event.notification?.data?.path || FALLBACK.path;
    event.notification?.close();
    const url = new URL(`./#${path}`, sw.registration.scope).href;
    keepAlive(
      event,
      (async () => {
        const all = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const mine = all.filter((/** @type {any} */ c) => c.url.startsWith(sw.registration.scope));
        const client = mine.find((/** @type {any} */ c) => c.focused) || mine[0];
        if (client) {
          // The app routes in place (src/lib/push.js), so nothing typed or open is lost.
          client.postMessage({ type: 'tt-push-open', path });
          await client.focus().catch(() => {});
          return;
        }
        await sw.clients.openWindow(url);
      })(),
    );
  });
})();
