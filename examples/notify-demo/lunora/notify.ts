import type { D1Like } from "@lunora/notify";
import { d1SubscriptionStore, defineNotify, fcmFromEnv, webPushFromEnv } from "@lunora/notify";

/**
 * `lunora/notify.ts` — the app's `@lunora/notify` configuration. Codegen
 * discovers this default export and wires `ctx.notify` / `ctx.push` onto every
 * handler ctx, and (via the generated app builder) threads the D1-backed store
 * into the worker so the Studio Notifications page can read registered devices
 * through `__lunora_admin__:listPushSubscriptions`.
 *
 * - `webPush` reads VAPID secrets (`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` /
 *   `VAPID_SUBJECT`) from `env`.
 * - `fcm` reads `FCM_PROJECT_ID` / `FCM_ACCESS_TOKEN` from `env`.
 * - `store` persists device subscriptions in the `DB` D1 binding (lazily-created
 *   table — no migration needed).
 */
export default defineNotify({
    fcm: (env) => fcmFromEnv(env),
    store: (env) => d1SubscriptionStore((env as { DB: D1Like }).DB),
    webPush: (env) => webPushFromEnv(env),
});
