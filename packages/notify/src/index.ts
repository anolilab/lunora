/**
 * `@lunora/notify`
 *
 * Multi-channel notifications for Lunora, wrapping the `@visulima/notification`
 * engine. `defineNotify` in `lunora/notify.ts` configures the edge-safe channels
 * (Web Push + FCM, plus chat / in-app inbox / webhook); codegen wires `ctx.notify`
 * and its `ctx.push` alias onto every handler ctx from it (mirroring `defineFlags`
 * → `ctx.flags`).
 *
 * Edge-safety: Web Push (VAPID + RFC 8291) and FCM (HTTP v1) run on `fetch` + Web
 * Crypto under workerd. APNs (`node:http2`) and SMS / Node-only queue adapters are
 * deliberately **not** on the edge facade — route heavy fan-out through
 * `@lunora/queue` (`enqueuePushBroadcast` / `runPushBroadcastPage`).
 *
 * - `@lunora/notify` — `defineNotify`, `createNotify`, config resolvers, subscription stores and types.
 * - `@lunora/notify/web` — the browser `subscribeToPush` service-worker helper.
 * @packageDocumentation
 */

export { FCM_ENV_KEYS, fcmFromEnv, WEB_PUSH_ENV_KEYS, webPushFromEnv } from "./config";
export { defineNotify, isNotifyDefinition } from "./define-notify";
export type { CreateNotifyOptions } from "./notify";
export { createNotify } from "./notify";
export type { ResolvedProviders, RoutingPushOptions } from "./providers";
export { buildEngine, routingPushProvider } from "./providers";
export type { PushBroadcastJob, PushBroadcastPageOutcome, QueueProducerLike } from "./queue";
export { enqueuePushBroadcast, runPushBroadcastPage } from "./queue";
export type { D1Like, D1PreparedLike, D1StoreOptions } from "./subscriptions/d1-store";
export { d1SubscriptionStore } from "./subscriptions/d1-store";
export { memorySubscriptionStore } from "./subscriptions/memory-store";
export { fcmId, isGoneError, normalizeRegisterInput, targetOf, webPushId } from "./subscriptions/normalize";
export type {
    BroadcastOutcome,
    BroadcastResult,
    ChatPayload,
    FcmConfig,
    FcmConfigFactory,
    InAppPayload,
    LunoraNotify,
    LunoraPush,
    NotificationMessage,
    NotifyConfig,
    NotifyDefinition,
    NotifyDeliveryStatus,
    NotifyEnv,
    NotifyLogger,
    NotifyMetrics,
    NotifySkipReason,
    PushOwner,
    PushPayload,
    PushSubscriptionDevice,
    PushSubscriptionLike,
    PushSubscriptionsResult,
    Receipt,
    RegisterInput,
    StoredSubscription,
    SubscriptionFilter,
    SubscriptionKind,
    SubscriptionStatus,
    SubscriptionStore,
    WebhookPayload,
    WebPushConfig,
    WebPushConfigFactory,
} from "./types";
