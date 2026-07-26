import type { ChatPayload, InAppPayload, NotificationMessage, PushPayload, Receipt, WebhookPayload } from "@visulima/notification";
import type { FcmConfig } from "@visulima/notification/providers/fcm";
import type { PushSubscriptionLike, WebPushConfig } from "@visulima/notification/providers/web-push";

/**
 * A Worker `env` projected as a plain record (vars, secrets and bindings are
 * `unknown`-valued). `defineNotify` factories receive this so a config can read
 * VAPID/FCM secrets and pick bindings (D1, Queues) at request/isolate time —
 * mirroring the `config.ai?.(env)` / flags `provider(env)` thunk pattern.
 */
export type NotifyEnv = Record<string, unknown>;

/** The delivery kind a stored device subscription targets. */
export type SubscriptionKind = "fcm" | "web-push";

/** The last-known delivery outcome recorded on a subscription. */
export type SubscriptionStatus = "expired" | "failed" | "ok";

/**
 * A registered device/browser subscription. Web Push carries a W3C Push API
 * `endpoint` + `keys`; FCM carries a device registration `token`. `id` is a
 * stable, storage-safe identifier derived from the target (see `subscriptionId`).
 */
export interface StoredSubscription {
    /** Unix-ms creation time. */
    createdAt: number;
    /** Web Push service endpoint URL (web-push only). */
    endpoint?: string;
    /** Stable identifier (endpoint/token derived) used as the store key. */
    id: string;
    /** Web Push client keys (web-push only). */
    keys?: { auth: string; p256dh: string };
    /** The delivery channel this subscription targets. */
    kind: SubscriptionKind;
    /** Last delivery error message, when `lastStatus` is `failed`/`expired`. */
    lastError?: string;
    /** Unix-ms time of the most recent register/send touch. */
    lastSeenAt: number;
    /** Last-known delivery outcome. */
    lastStatus?: SubscriptionStatus;
    /** Arbitrary app metadata (device name, locale, topics, …). */
    metadata?: Record<string, unknown>;
    /** FCM device registration token (fcm only). */
    token?: string;
    /** Owning user id, or `null` when anonymous. */
    userId?: string | null;
}

/**
 * The admin-facing projection of a {@link StoredSubscription} — a registered
 * device as surfaced by the gated `__lunora_admin__:listPushSubscriptions` RPC
 * (backing the Studio Notifications page). The delivery **secrets** are dropped:
 * the Web Push `keys` (the RFC 8291 `auth`/`p256dh` encryption material) and the
 * FCM `token` are never sent to the browser — only the endpoint / kind / owner /
 * timestamps and the last-send status + error the page renders.
 */
export type PushSubscriptionDevice = Omit<StoredSubscription, "keys" | "token">;

/** Payload of a `__lunora_admin__:listPushSubscriptions` call — the registered devices, secrets redacted. */
export interface PushSubscriptionsResult {
    /** The registered device subscriptions matching the request filter (secrets stripped). */
    subscriptions: PushSubscriptionDevice[];
}

/** Input accepted by `ctx.push.register(...)` — a web-push subscription or an FCM token. */
export type RegisterInput =
    | { kind?: "web-push"; metadata?: Record<string, unknown>; subscription: PushSubscriptionLike | string; userId?: string | null }
    | { kind: "fcm"; metadata?: Record<string, unknown>; token: string; userId?: string | null };

/** Filter narrowing which stored subscriptions a `list`/`broadcast` targets. */
export interface SubscriptionFilter {
    /** Restrict to a delivery kind. */
    kind?: SubscriptionKind;

    /**
     * Cap the number of rows returned (a `LIMIT`). Applied server-side by the
     * store, so a large audience never materializes wholesale in the isolate.
     * A non-positive/absent value means "no cap"; a fractional value is truncated.
     * `broadcast` deliberately leaves this unset (it must reach every matched
     * device); admin/list reads set it to bound the page.
     */
    limit?: number;
    /** Restrict to a single owning user. */
    userId?: string | null;
}

/**
 * Persistence for device subscriptions. Implementations back `ctx.push`'s
 * lifecycle (register, list, prune). Ships with an in-memory store (tests/dev)
 * and a D1-backed store (durable, edge-safe).
 */
export interface SubscriptionStore {
    /** Remove a subscription by id (idempotent). */
    delete: (id: string) => Promise<void>;
    /** Read a subscription by id, or `undefined`. */
    get: (id: string) => Promise<StoredSubscription | undefined>;
    /** List subscriptions, optionally filtered. */
    list: (filter?: SubscriptionFilter) => Promise<StoredSubscription[]>;
    /** Record the latest delivery outcome for a subscription (best-effort). */
    markStatus: (id: string, status: SubscriptionStatus, error?: string) => Promise<void>;
    /** Insert or update a subscription (upsert by id). */
    put: (subscription: StoredSubscription) => Promise<StoredSubscription>;
}

/** Per-recipient outcome from a fan-out `broadcast`. */
export interface BroadcastOutcome {
    /** Delivery error message when `status` is not `ok`. */
    error?: string;
    /** The subscription this outcome belongs to. */
    id: string;
    /** `expired` subscriptions were pruned from the store. */
    status: SubscriptionStatus;
}

/** Aggregate result of a `broadcast`. */
export interface BroadcastResult {
    /** Number of subscriptions that failed (non-gone). */
    failed: number;
    /** Per-subscription outcomes. */
    outcomes: BroadcastOutcome[];
    /** Number of pruned (gone/expired) subscriptions. */
    pruned: number;
    /** Number of subscriptions delivered successfully. */
    sent: number;
    /** Total subscriptions attempted. */
    total: number;
}

/**
 * The compact, stable delivery-status vocabulary emitted on notify observability
 * signals — the `status` dimension on the `notify.send` metric and the failure
 * log line. Modeled on Novu's execution status, but honest to edge push:
 *
 * - `accepted` — the provider took the message (a `Receipt.successful` send).
 * - `failed` — a provider error; the log line carries the `error` text.
 * - `gone` — the endpoint is unregistered (404/410, FCM `UNREGISTERED`) and pruned; push-only.
 *
 * Web Push and FCM give no delivery/open receipts, so the vocabulary stops at the
 * send attempt: a `delivered`/`opened` status would be a lie for these channels.
 * The one place a later `seen`/`read` is real is the in-app inbox, where the
 * client posts a read receipt back — out of scope here.
 */
export type NotifyDeliveryStatus = "accepted" | "failed" | "gone";

/**
 * Why a send fanned out to nobody — the "sent 0 because…" signal (mirrors Novu's
 * pre-send `DetailEnum` reasons). Emitted as the `reason` dimension on a
 * `notify.skipped` metric so a no-op is visible in the Studio metric/trend view
 * instead of silent.
 *
 * - `no-subscriptions-matched` — the store held no device for the broadcast filter.
 * - `channel-not-configured` — the target channel was never wired in `defineNotify`.
 */
export type NotifySkipReason = "channel-not-configured" | "no-subscriptions-matched";

/**
 * The minimal structural slice of `ctx.log` the notify facade emits through — just
 * the `warn` severity it uses for a failed delivery. Structural (rather than a
 * dependency on `@lunora/server`'s `LunoraLogger`) so codegen passes the real
 * `ctx.log` and a test passes a spy — the D1-store `D1Like` pattern, applied to
 * observability.
 */
export interface NotifyLogger {
    warn: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * The minimal structural slice of `ctx.metrics` the notify facade emits through —
 * the `count` instrument backing the `notify.send` / `notify.skipped` series.
 * Structural for the same reason as {@link NotifyLogger}.
 */
export interface NotifyMetrics {
    count: (name: string, value?: number, attributes?: Record<string, unknown>) => void;
}

/**
 * The push sub-facade — spliced onto ctx as `ctx.push` (and reachable as
 * `ctx.notify.push`). Owns the device-subscription lifecycle plus targeted and
 * fan-out push delivery through the edge-safe Web Push / FCM providers.
 */
export interface LunoraPush {
    /**
     * Fan-out a push to every stored subscription matching `filter` (default: all).
     * Reuses the engine's retry/circuit-breaker middleware; prunes subscriptions
     * the push service reports as gone (HTTP 404/410, FCM `UNREGISTERED`). The `to`
     * target is derived from each subscription, so it is omitted from the payload.
     */
    broadcast: (payload: PushContent, filter?: SubscriptionFilter) => Promise<BroadcastResult>;

    /**
     * List stored subscriptions (optionally filtered), with the delivery
     * **secrets** stripped — the Web Push `keys` (RFC 8291 `auth`/`p256dh`) and the
     * FCM `token`. Those, plus the endpoint, are enough to deliver arbitrary push to
     * a device, so they never cross the app-facing facade. `list` and
     * {@link LunoraPush.listDevices} return the same projected shape; the raw rows
     * are reachable only through the internal `SubscriptionStore`.
     */
    list: (filter?: SubscriptionFilter) => Promise<PushSubscriptionDevice[]>;
    /** Alias of {@link LunoraPush.list} — list stored devices with delivery secrets stripped. */
    listDevices: (filter?: SubscriptionFilter) => Promise<PushSubscriptionDevice[]>;
    /** Register (upsert) a device subscription and return the stored record. */
    register: (input: RegisterInput) => Promise<StoredSubscription>;
    /** Send a push to a single stored subscription (by id or record); `to` is derived from it. */
    send: (target: StoredSubscription | string, payload: PushContent) => Promise<Receipt>;
    /** Remove a subscription by id (idempotent). */
    unregister: (id: string) => Promise<void>;
}

/** A push payload without its `to` target — the facade derives `to` from the stored subscription. */
export type PushContent = Omit<PushPayload, "to">;

/**
 * The multi-channel notification facade — spliced onto ctx as `ctx.notify`.
 * `send` delivers a fully-specified multi-channel message through the engine;
 * `push` is the device-push sub-facade; `chat` / `inApp` / `webhook` are
 * single-channel convenience senders for the edge-safe channels.
 */
export interface LunoraNotify {
    /** Send an outbound webhook. */
    chat: (payload: ChatPayload) => Promise<Receipt>;
    /** Deliver an in-app inbox notification. */
    inApp: (payload: InAppPayload) => Promise<Receipt>;
    /** The device-push sub-facade (identical object to `ctx.push`). */
    push: LunoraPush;
    /** Deliver a multi-channel message (one payload per channel). */
    send: (message: NotificationMessage) => Promise<Receipt[]>;
    /** Post to a chat channel (Slack/Discord/Teams/Telegram). */
    webhook: (payload: WebhookPayload) => Promise<Receipt>;
}

/**
 * Resolves a channel provider factory from the Worker `env`. Receiving `env`
 * (rather than a constructed provider) lets a config read VAPID/FCM secrets and
 * bindings at request time. Return `undefined` to leave the channel unwired.
 */
export type WebPushConfigFactory = (env: NotifyEnv) => WebPushConfig | undefined;
export type FcmConfigFactory = (env: NotifyEnv) => FcmConfig | undefined;

/** Options accepted by `defineNotify`. */
export interface NotifyConfig {
    /**
     * Exact origins (`https://host[:port]`) a client-supplied Web Push `endpoint`
     * may register from. When set (non-empty), `register()` requires the endpoint's
     * origin to be one of these — the strongest anti-SSRF posture, and the way to
     * close DNS rebinding for a facade that accepts client-controlled endpoints.
     *
     * When unset, the default posture applies: an endpoint must be `https:` with a
     * non-private / non-loopback / non-link-local host. Set this to the push
     * services your app actually uses (e.g. `["https://fcm.googleapis.com",
     * "https://updates.push.services.mozilla.com"]` — exact origins only, no
     * wildcards) to hard-pin the boundary.
     */
    allowedPushOrigins?: string[];

    /**
     * Optional chat provider factory (Slack/Discord/Teams/Telegram). Wire with a
     * provider from `@visulima/notification/providers/*`. Edge-safe (fetch-based).
     */
    chat?: (env: NotifyEnv) => unknown;
    /** FCM (Firebase Cloud Messaging HTTP v1) config. Edge-safe — supply an OAuth2 token. */
    fcm?: FcmConfig | FcmConfigFactory;
    /** Optional in-app inbox provider factory. Edge-safe. */
    inApp?: (env: NotifyEnv) => unknown;

    /**
     * Builds the subscription store from `env` (usually a D1-backed store from a
     * binding). Defaults to a non-durable in-memory store with a dev warning.
     */
    store?: (env: NotifyEnv) => SubscriptionStore;
    /** Optional outbound-webhook provider factory. Edge-safe (fetch-based). */
    webhook?: (env: NotifyEnv) => unknown;
    /** Web Push (VAPID + RFC 8291) config. Fully edge-safe (Web Crypto only). */
    webPush?: WebPushConfig | WebPushConfigFactory;
}

/**
 * A branded {@link NotifyConfig} produced by `defineNotify`. This is the default
 * export of `lunora/notify.ts`; codegen imports it into the generated worker and
 * wires `ctx.notify` / `ctx.push` from it (mirroring `defineFlags` → `ctx.flags`).
 */
export interface NotifyDefinition extends NotifyConfig {
    /** Runtime brand used by `isNotifyDefinition` and codegen discovery. */
    readonly isLunoraNotify: true;
}

// Re-export the engine payload/config types an app touches when authoring
// `defineNotify` or a send, so consumers don't need a direct dependency on
// `@visulima/notification` just for typing.
export type { ChatPayload, InAppPayload, NotificationMessage, PushPayload, Receipt, WebhookPayload } from "@visulima/notification";
export type { FcmConfig } from "@visulima/notification/providers/fcm";
export type { PushSubscriptionLike, WebPushConfig } from "@visulima/notification/providers/web-push";
