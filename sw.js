importScripts("./version.js?v=25");

const cacheName = `medicinlogg-v${globalThis.MEDICINKOLL_VERSION}`;
const filesToCache = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg", "./version.js?v=25", "./config.js?v=25", "./cloud-sync.js?v=25", "./push-notifications.js?v=25", "./privacy/", "./oauth/consent/", "./oauth/consent/consent.js?v=20"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(filesToCache)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== cacheName).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const requestUrl = new URL(event.request.url);
  const acceptsHtml = event.request.headers.get("accept")?.includes("text/html");
  const isAppPage =
    event.request.mode === "navigate" ||
    acceptsHtml ||
    requestUrl.pathname.endsWith("/") ||
    requestUrl.pathname.endsWith("/index.html");

  if (isAppPage) {
    event.respondWith(
      fetch(event.request, { cache: "no-cache" })
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(cacheName).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(async () => (await caches.match(event.request)) || caches.match("./index.html"))
    );
    return;
  }

  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});

self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch (_) { payload = {}; }
  const title = typeof payload.title === "string" ? payload.title : "Medicinkoll";
  const body = typeof payload.body === "string" ? payload.body : "Planerad medicinering om 5 minuter.";
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: "./icon.svg",
    badge: "./icon.svg",
    tag: "medicinlogg-planned-dose",
    renotify: false,
    data: { url: typeof payload.url === "string" ? payload.url : "./" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL(event.notification.data?.url || "./", self.location.origin).href;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.navigate(target);
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  })());
});
