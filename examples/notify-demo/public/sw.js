// Minimal Web Push service worker for the notify-demo. Renders an incoming push
// as a system notification; focuses/opens the app when it is clicked.

globalThis.addEventListener("push", (event) => {
    const payload = event.data ? event.data.json() : {};

    event.waitUntil(
        globalThis.registration.showNotification(payload.title ?? "Notification", {
            body: payload.body ?? "",
            data: payload.data ?? {},
        }),
    );
});

globalThis.addEventListener("notificationclick", (event) => {
    event.notification.close();
    event.waitUntil(globalThis.clients.openWindow("/"));
});
