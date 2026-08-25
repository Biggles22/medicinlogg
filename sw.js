const cacheName = "medicinlogg-v15";
const filesToCache = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg", "./config.js", "./cloud-sync.js", "./privacy/", "./oauth/consent/", "./oauth/consent/consent.js"];

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
            caches.open(cacheName).then((cache) => cache.put("./index.html", copy));
          }
          return response;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
