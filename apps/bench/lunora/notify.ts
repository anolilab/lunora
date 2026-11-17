/**
 * Notifications — codegen wires `ctx.notify` / `ctx.push` from this file.
 * Web Push and FCM resolve to `undefined` while their keys are unset, so local
 * dev runs with no credentials (sends are counted as skipped).
 */
import type { D1Like } from "@lunora/notify";
import { d1SubscriptionStore, defineNotify, fcmFromEnv, webPushFromEnv } from "@lunora/notify";

export default defineNotify({
    fcm: (env) => fcmFromEnv(env),
    store: (env) => d1SubscriptionStore((env as { DB: D1Like }).DB),
    webPush: (env) => webPushFromEnv(env),
});
