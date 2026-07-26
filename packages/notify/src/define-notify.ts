import type { NotifyConfig, NotifyDefinition } from "./types";

/**
 * Declare the notification channels for a Lunora app. Pure validation +
 * branding — codegen discovers the default export of `lunora/notify.ts`, imports
 * it into the generated worker, and wires `ctx.notify` / `ctx.push` from it
 * (mirrors how `defineFlags` feeds codegen to build `ctx.flags`).
 *
 * ```ts
 * // lunora/notify.ts
 * import { defineNotify, webPushFromEnv, fcmFromEnv } from "@lunora/notify";
 * import { d1SubscriptionStore } from "@lunora/notify";
 *
 * export default defineNotify({
 *     webPush: (env) => webPushFromEnv(env),   // VAPID_* from .dev.vars
 *     fcm: (env) => fcmFromEnv(env),           // FCM_PROJECT_ID / FCM_ACCESS_TOKEN
 *     store: (env) => d1SubscriptionStore(env.DB),
 * });
 * ```
 *
 * Only edge-safe channels are wired here — Web Push and FCM run on Web Crypto +
 * `fetch` under workerd. APNs (`node:http2`) and SMS/Node-only queue adapters are
 * intentionally **not** exposed on the edge facade; route heavy fan-out through
 * `@lunora/queue` instead (see `broadcastViaQueue`).
 */
const defineNotify = (config: NotifyConfig): NotifyDefinition => {
    if (config.webPush !== undefined && typeof config.webPush !== "function" && typeof config.webPush !== "object") {
        throw new TypeError("defineNotify: `webPush` must be a WebPushConfig object or an `(env) => WebPushConfig` function");
    }

    if (config.fcm !== undefined && typeof config.fcm !== "function" && typeof config.fcm !== "object") {
        throw new TypeError("defineNotify: `fcm` must be an FcmConfig object or an `(env) => FcmConfig` function");
    }

    if (config.store !== undefined && typeof config.store !== "function") {
        throw new TypeError("defineNotify: `store` must be a function `(env) => SubscriptionStore` when provided");
    }

    if (
        config.allowedPushOrigins !== undefined &&
        (!Array.isArray(config.allowedPushOrigins) || config.allowedPushOrigins.some((origin) => typeof origin !== "string"))
    ) {
        throw new TypeError('defineNotify: `allowedPushOrigins` must be an array of origin strings (e.g. ["https://fcm.googleapis.com"]) when provided');
    }

    if (config.webPush === undefined && config.fcm === undefined) {
        throw new TypeError("defineNotify: configure at least one push channel — `webPush` and/or `fcm`");
    }

    return { ...config, isLunoraNotify: true };
};

/** True when a value is a {@link defineNotify} result (the runtime brand check). */
const isNotifyDefinition = (value: unknown): value is NotifyDefinition =>
    typeof value === "object" && value !== null && (value as { isLunoraNotify?: unknown }).isLunoraNotify === true;

export { defineNotify, isNotifyDefinition };
