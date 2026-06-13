const cacheName = "medicinlogg-v10";
const filesToCache = ["./manifest.webmanifest", "./icon.svg"];

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
    event.respondWith(fetch(event.request, { cache: "reload" }));
    return;
  }

  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
