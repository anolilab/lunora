// Minimal Web Push service worker for the notify-demo. Renders an incoming push
// as a system notification; focuses/opens the app when it is clicked.
/* eslint-disable no-undef -- service-worker global scope (self, clients) */
self.addEventListener("push", (event) => {
    const payload = event.data ? event.data.json() : {};

    event.waitUntil(
        self.registration.showNotification(payload.title ?? "Notification", {
            body: payload.body ?? "",
            data: payload.data ?? {},
        }),
    );
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    event.waitUntil(self.clients.openWindow("/"));
});
