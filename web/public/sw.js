// Twofold service worker: push notifications and opening the right page on tap.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = { title: "Twofold", body: "", link: "#/today" };
  try { data = { ...data, ...event.data.json() }; } catch (_) { /* plain push */ }
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body, icon: "/icon-192.png", badge: "/icon-192.png", data: { link: data.link },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = "/" + (event.notification.data?.link ?? "#/today");
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if ("focus" in c) { c.navigate(url); return c.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});
