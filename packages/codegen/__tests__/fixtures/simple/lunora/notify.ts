import { defineNotify, fcmFromEnv, webPushFromEnv } from "@lunora/notify";

// Coverage file — exercises `defineNotify(...)` so the emitted `ctx.notify` +
// `ctx.push` wiring (the `../notify.js` import, `createNotify(notifyConfig, env)`
// build, and the every-ctx `notify,` / `push,` fields) is asserted by the golden
// fixture. Both push channels are wired (VAPID + FCM read from env secrets).
export default defineNotify({
    fcm: (env) => fcmFromEnv(env),
    webPush: (env) => webPushFromEnv(env),
});
