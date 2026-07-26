import { LunoraError } from "@lunora/errors";
import type { Notification, Provider, Receipt } from "@visulima/notification";

import type { ResolvedProviders } from "./providers";
import { buildEngine } from "./providers";
import { memorySubscriptionStore } from "./subscriptions/memory-store";
import { isGoneError, normalizeRegisterInput, targetOf } from "./subscriptions/normalize";
import type {
    BroadcastOutcome,
    BroadcastResult,
    LunoraNotify,
    LunoraPush,
    NotifyDefinition,
    NotifyDeliveryStatus,
    NotifyEnv,
    NotifyLogger,
    NotifyMetrics,
    PushContent,
    PushSubscriptionDevice,
    RegisterInput,
    StoredSubscription,
    SubscriptionFilter,
    SubscriptionStore,
} from "./types";

const resolveMaybeFactory = <T>(value: T | ((env: NotifyEnv) => T | undefined) | undefined, env: NotifyEnv): T | undefined =>
    typeof value === "function" ? (value as (env: NotifyEnv) => T | undefined)(env) : value;

const receiptError = (receipt: Receipt): string | undefined => (receipt.successful ? undefined : receipt.errorMessages.join("; "));

/**
 * Map a push send's receipt to the observability {@link NotifyDeliveryStatus}:
 * `accepted` on success, `gone` when the endpoint is unregistered (404/410, FCM
 * `UNREGISTERED` — the subscription is pruned), else `failed`.
 */
const pushDeliveryStatus = (receipt: Receipt, error: string | undefined): NotifyDeliveryStatus => {
    if (receipt.successful) {
        return "accepted";
    }

    return isGoneError(error) ? "gone" : "failed";
};

/** Run `task` over `items` with a bounded number in flight (order-independent). */
const mapWithConcurrency = async <T, R>(items: ReadonlyArray<T>, limit: number, task: (item: T) => Promise<R>): Promise<R[]> => {
    const results: R[] = Array.from({ length: items.length });
    let cursor = 0;

    const worker = async (): Promise<void> => {
        while (cursor < items.length) {
            const index = cursor;

            cursor += 1;
            // eslint-disable-next-line no-await-in-loop -- worker drains a shared queue; concurrency is bounded by the pool
            results[index] = await task(items[index] as T);
        }
    };

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));

    return results;
};

/** Resolve the (possibly env-thunked) channel configs into a ready-to-wire set. */
const resolveProviders = (definition: NotifyDefinition, env: NotifyEnv): ResolvedProviders => {
    return {
        chat: resolveMaybeFactory(definition.chat, env) as Provider | undefined,
        fcm: resolveMaybeFactory(definition.fcm, env),
        inApp: resolveMaybeFactory(definition.inApp, env) as Provider | undefined,
        webhook: resolveMaybeFactory(definition.webhook, env) as Provider | undefined,
        webPush: resolveMaybeFactory(definition.webPush, env),
    };
};

/**
 * The per-isolate state memoized across `createNotify` calls. Codegen splices
 * `createNotify(notifyDefinition, env)` onto EVERY handler ctx, so it runs once
 * per RPC — but the engine (web-push/FCM providers + retry + circuit-breaker
 * middleware), the configured subscription store, and the dev in-memory fallback
 * store are expensive to build (or carry their own warm memos) and MUST persist
 * across requests (a `register()` in one request has to be visible to a
 * `broadcast()` in the next). All fields are lazy: the engine is only built when
 * there is no `options.engine` override, `store` only when the config supplies a
 * real `store` factory, and the fallback store only when it does not.
 */
interface NotifyRuntime {
    engine?: Notification;
    fallbackStore?: SubscriptionStore;
    store?: SubscriptionStore;
    warnedNoPushOriginAllowlist: boolean;
    warnedNoStore: boolean;
}

/**
 * Per-isolate memoization cache keyed on the {@link NotifyDefinition} identity (a
 * module singleton — the `lunora/notify.ts` default export) then the Worker `env`,
 * both stable for the isolate's lifetime. A `WeakMap` so a torn-down definition/env
 * is collectable and tests using fresh objects never leak state into each other.
 */
const runtimeCache = new WeakMap<NotifyDefinition, WeakMap<NotifyEnv, NotifyRuntime>>();

const runtimeFor = (definition: NotifyDefinition, env: NotifyEnv): NotifyRuntime => {
    let byEnv = runtimeCache.get(definition);

    if (byEnv === undefined) {
        byEnv = new WeakMap<NotifyEnv, NotifyRuntime>();
        runtimeCache.set(definition, byEnv);
    }

    let runtime = byEnv.get(env);

    if (runtime === undefined) {
        runtime = { warnedNoPushOriginAllowlist: false, warnedNoStore: false };
        byEnv.set(env, runtime);
    }

    return runtime;
};

/** Options for {@link createNotify}. */
export interface CreateNotifyOptions {
    /** Max concurrent sends during a `broadcast` (default 10). */
    concurrency?: number;

    /**
     * Override the assembled `@visulima/notification` engine. Advanced/testing
     * seam — pass a `Notification` built with your own (mock) providers to bypass
     * config resolution entirely.
     */
    engine?: Notification;

    /**
     * The request's `ctx.log` (structural {@link NotifyLogger}). Codegen threads
     * `ctx.log` in; when present the facade emits one `warn` line per FAILED
     * delivery — trace-correlated to the enclosing action and durably archived by
     * the log sink. Successes and prunes stay off the log to keep the archive
     * clean; they are counted on `metrics` instead. Absent ⇒ no log emits.
     */
    log?: NotifyLogger;

    /**
     * The request's `ctx.metrics` (structural {@link NotifyMetrics}). Codegen
     * threads `ctx.metrics` in; when present the facade counts every send on the
     * `notify.send` series (dimensions `channel` / `provider` / `status`) and every
     * no-op on `notify.skipped` (`channel` / `reason`) — feeding the durable metric
     * history + trend charts. Absent ⇒ no metric emits.
     */
    metrics?: NotifyMetrics;

    /** Suppress the in-memory-store dev warning (tests set this). */
    silent?: boolean;
}

/**
 * Build the `ctx.notify` / `ctx.push` facades for a request from a
 * {@link NotifyDefinition} (the `lunora/notify.ts` default export) and the Worker
 * `env`. Codegen calls this to splice the facades onto ctx — the same shape as
 * `createFlags` for `ctx.flags`. Returns both facades; `notify.push` is the very
 * same object exposed as `ctx.push`.
 *
 * The engine and the dev fallback store are memoized per isolate (see
 * {@link NotifyRuntime}), so repeat calls with the same `definition`/`env` are
 * cheap — only the thin facade closures below are rebuilt each call.
 */
export const createNotify = (definition: NotifyDefinition, env: NotifyEnv, options: CreateNotifyOptions = {}): { notify: LunoraNotify; push: LunoraPush } => {
    const runtime = runtimeFor(definition, env);

    let engine: Notification;

    if (options.engine === undefined) {
        // Build once per isolate; the `options.engine` override seam bypasses it.
        runtime.engine ??= buildEngine(resolveProviders(definition, env));
        engine = runtime.engine;
    } else {
        engine = options.engine;
    }

    // Memoize the real store per isolate exactly like `engine`/`fallbackStore`: it
    // is built once from `definition.store(env)` and reused across requests, so its
    // own memos (e.g. the D1 store's `schemaReady` `CREATE TABLE` guard) stay warm
    // instead of paying a cold schema round trip on every `ctx.push.*` call. A no-op
    // when no `store` is configured (`?.(env)` stays `undefined` and the fallback
    // path below owns durability).
    runtime.store ??= definition.store?.(env);

    let { store } = runtime;

    if (store === undefined) {
        // Reuse ONE in-memory store per isolate so registrations survive across
        // requests; warn at most once (guarded on the per-isolate runtime).
        runtime.fallbackStore ??= memorySubscriptionStore();

        if (!options.silent && !runtime.warnedNoStore) {
            runtime.warnedNoStore = true;
            // eslint-disable-next-line no-console -- one-time durability warning, mirrors other dev-store fallbacks
            console.warn(
                "@lunora/notify: no `store` configured — using a non-durable in-memory subscription store. Configure `store: (env) => d1SubscriptionStore(env.DB)` for production.",
            );
        }

        store = runtime.fallbackStore;
    }

    const subscriptionStore = store;
    const concurrency = Math.max(1, options.concurrency ?? 10);
    const { log, metrics } = options;

    /**
     * Count `count` (default 1) settled sends of one (channel, provider, status)
     * on the `notify.send` series — dimensions are low-cardinality so identifiers
     * stay on the log, not the metric; `provider` falls back to the channel name.
     * A single/channel send passes the default 1; a broadcast aggregates per
     * bucket and passes the bucket total, so the durable metric write (a SQLite
     * upsert — see the metrics-emit bench) happens once per bucket, not per
     * recipient.
     */
    const countSend = (channel: string, provider: string | undefined, status: NotifyDeliveryStatus, count = 1): void => {
        metrics?.count("notify.send", count, { channel, provider: provider ?? channel, status });
    };

    /**
     * Emit the per-recipient failure `warn`. Called only from a `status ===
     * "failed"` guard, so its fields object is built only on a failure — never on
     * the (hot, O(N)) success path of a broadcast.
     */
    const warnFailedSend = (channel: string, provider: string | undefined, fields: Record<string, unknown>): void => {
        log?.warn(`notify ${channel} delivery failed`, { channel, provider: provider ?? channel, status: "failed", ...fields });
    };

    /** Emit a `notify.skipped` count for a send that reached no recipient (the "sent 0 because…" signal). */
    const observeSkip = (channel: string, reason: string): void => {
        metrics?.count("notify.skipped", 1, { channel, reason });
    };

    /**
     * Warn ONCE per isolate when a Web Push subscription is registered without an
     * `allowedPushOrigins` allowlist. The default posture validates the endpoint
     * host with a STRING classifier (`assertPushEndpoint` → shared `isPrivateHost`)
     * that does NOT resolve DNS, so a public hostname that resolves to a
     * private/internal IP (e.g. `https://127.0.0.1.nip.io/…`) slips past it — only
     * an exact-origin `allowedPushOrigins` allowlist closes that DNS-rebinding gap.
     * Guarded on the per-isolate runtime, mirroring the no-store fallback warning.
     */
    const warnNoPushOriginAllowlist = (): void => {
        const hasAllowlist = definition.allowedPushOrigins !== undefined && definition.allowedPushOrigins.length > 0;

        if (options.silent || hasAllowlist || runtime.warnedNoPushOriginAllowlist) {
            return;
        }

        runtime.warnedNoPushOriginAllowlist = true;
        // eslint-disable-next-line no-console -- one-time SSRF-posture warning, mirrors the no-store fallback warning
        console.warn(
            "@lunora/notify: Web Push registered without `allowedPushOrigins` — the endpoint host is validated by a string classifier that does NOT resolve DNS, so a public hostname resolving to a private/internal IP (e.g. `https://127.0.0.1.nip.io/…`) is NOT blocked. Set `allowedPushOrigins` to the exact push-service origins to close DNS rebinding.",
        );
    };

    /**
     * List stored subscriptions with the delivery SECRETS stripped — the Web Push
     * `keys` (RFC 8291 `auth`/`p256dh`) and the FCM `token`. Backs `ctx.push.list`:
     * those, with the endpoint, are enough to deliver arbitrary push to a device, so
     * they never cross the app-facing facade. Uses the same `{ keys, token, ...device }`
     * projection as the gated Studio admin RPC (`create-worker.ts`). The raw rows stay
     * reachable only through the internal `SubscriptionStore` (which `broadcast` uses
     * directly).
     */
    const listProjected = async (filter?: SubscriptionFilter): Promise<PushSubscriptionDevice[]> => {
        const rows = await subscriptionStore.list(filter);

        return rows.map(({ keys: _keys, token: _token, ...device }) => device);
    };

    const resolveSubscription = async (target: StoredSubscription | string): Promise<StoredSubscription> => {
        if (typeof target !== "string") {
            return target;
        }

        const found = await subscriptionStore.get(target);

        if (found === undefined) {
            throw new LunoraError("BAD_REQUEST", `@lunora/notify: no registered subscription with id "${target}"`);
        }

        return found;
    };

    /**
     * Send one push and settle its store lifecycle + observability. Returns the
     * receipt and the derived {@link NotifyDeliveryStatus} (so a broadcast reuses
     * it instead of re-deriving). The FAILURE LOG is per-recipient regardless of
     * path. The metric is counted inline ONLY when `countInline` (a single
     * `push.send`); a broadcast passes `false` and counts aggregated buckets once.
     */
    const deliver = async (
        subscription: StoredSubscription,
        payload: PushContent,
        countInline: boolean,
    ): Promise<{ error?: string; receipt?: Receipt; status: NotifyDeliveryStatus }> => {
        let receipt: Receipt | undefined;
        let error: string | undefined;
        // The observability status vocabulary (accepted/failed/gone). The store's
        // own `SubscriptionStatus` (ok/failed) is set below and left unchanged.
        let status: NotifyDeliveryStatus;

        try {
            receipt = await engine.sendToChannel("push", { ...payload, to: targetOf(subscription) });
            error = receiptError(receipt);
            status = pushDeliveryStatus(receipt, error);
        } catch (error_) {
            // A THROW from the send path — a transient provider/store error, or the
            // push router's raw throw for a target whose channel (`webPush`/`fcm`)
            // isn't configured — must degrade THIS recipient to `failed`, never
            // reject the whole fan-out. `broadcast` relies on `deliver` being total.
            status = "failed";
            error = error_ instanceof Error ? error_.message : String(error_);
        }

        try {
            if (status === "accepted") {
                await subscriptionStore.markStatus(subscription.id, "ok");
            } else if (status === "gone") {
                await subscriptionStore.delete(subscription.id);
            } else {
                await subscriptionStore.markStatus(subscription.id, "failed", error);
            }
        } catch {
            // The store lifecycle write is best-effort: a failing markStatus/delete
            // (e.g. a transient D1 error) must not abort the fan-out. The send
            // outcome above still stands; the status just went unrecorded.
        }

        if (status === "failed") {
            // `provider` is the push kind (web-push/fcm) — a push send's own provider.
            warnFailedSend("push", subscription.kind, { error, subscriptionId: subscription.id, userId: subscription.userId ?? null });
        }

        if (countInline) {
            countSend("push", subscription.kind, status);
        }

        return { error, receipt, status };
    };

    const push: LunoraPush = {
        broadcast: async (payload: PushContent, filter?: SubscriptionFilter): Promise<BroadcastResult> => {
            const subscriptions = await subscriptionStore.list(filter);

            if (subscriptions.length === 0) {
                // A broadcast that matched nobody — surface the no-op rather than
                // returning a silent all-zero result (per-send metrics never fire).
                observeSkip("push", "no-subscriptions-matched");
            }

            const rows = await mapWithConcurrency(subscriptions, concurrency, async (subscription) => {
                // `deliver` is total (it never rejects — a throwing recipient
                // becomes a `failed` outcome inside it), so the bounded `Promise.all`
                // pool in `mapWithConcurrency` can never be rejected by one bad send.
                const { error, status } = await deliver(subscription, payload, false);

                return { error, kind: subscription.kind, status, subscription };
            });

            // Fold the per-recipient statuses into one metric count per (kind,
            // status) bucket — at most kinds×3 emits — instead of one durable
            // SQLite write per recipient. (The per-recipient FAILURE LOGS already
            // fired inside `deliver`.)
            const buckets = new Map<string, { count: number; kind: string; status: NotifyDeliveryStatus }>();

            for (const { kind, status } of rows) {
                const key = `${kind} ${status}`;
                const bucket = buckets.get(key);

                if (bucket === undefined) {
                    buckets.set(key, { count: 1, kind, status });
                } else {
                    bucket.count += 1;
                }
            }

            for (const { count, kind, status } of buckets.values()) {
                countSend("push", kind, status, count);
            }

            const outcomes: BroadcastOutcome[] = rows.map(({ error, status, subscription }) => {
                if (status === "accepted") {
                    return { id: subscription.id, status: "ok" };
                }

                return status === "gone" ? { error, id: subscription.id, status: "expired" } : { error, id: subscription.id, status: "failed" };
            });

            return {
                failed: outcomes.filter((outcome) => outcome.status === "failed").length,
                outcomes,
                pruned: outcomes.filter((outcome) => outcome.status === "expired").length,
                sent: outcomes.filter((outcome) => outcome.status === "ok").length,
                total: outcomes.length,
            };
        },
        list: (filter?: SubscriptionFilter): Promise<PushSubscriptionDevice[]> => listProjected(filter),
        register: (input: RegisterInput): Promise<StoredSubscription> => {
            // A web-push registration accepts a client-controlled endpoint — the SSRF
            // surface. Nudge (once) to the exact-origin allowlist when unset. FCM
            // tokens carry no endpoint, so the origin allowlist doesn't apply to them.
            if (!("token" in input)) {
                warnNoPushOriginAllowlist();
            }

            return subscriptionStore.put(normalizeRegisterInput(input, undefined, { allowedPushOrigins: definition.allowedPushOrigins }));
        },
        send: async (target: StoredSubscription | string, payload: PushContent): Promise<Receipt> => {
            const { error, receipt } = await deliver(await resolveSubscription(target), payload, true);

            if (receipt === undefined) {
                // A targeted single send is not a fan-out: when the provider throws
                // (no receipt at all) the caller must see the failure, so re-surface
                // it. `deliver` already logged/counted the `failed` status.
                throw new LunoraError("INTERNAL", `@lunora/notify: push send failed: ${error ?? "unknown error"}`);
            }

            return receipt;
        },
        unregister: (id: string): Promise<void> => subscriptionStore.delete(id),
    };

    const sendToChannel = async (channel: "chat" | "inapp" | "webhook", payload: unknown): Promise<Receipt> => {
        if (engine.getProvider(channel) === undefined) {
            observeSkip(channel, "channel-not-configured");

            throw new LunoraError("BAD_REQUEST", `@lunora/notify: the "${channel}" channel is not configured in defineNotify(...)`);
        }

        const receipt = await engine.sendToChannel(channel, payload as never);
        const status: NotifyDeliveryStatus = receipt.successful ? "accepted" : "failed";

        countSend(channel, receipt.provider, status);

        if (status === "failed") {
            warnFailedSend(channel, receipt.provider, { error: receiptError(receipt) });
        }

        return receipt;
    };

    const notify: LunoraNotify = {
        chat: (payload) => sendToChannel("chat", payload),
        inApp: (payload) => sendToChannel("inapp", payload),
        push,
        send: async (message) => {
            const receipts = await engine.send(message);

            // One measurement per channel receipt — `channel`/`provider` come off
            // the receipt (the multi-channel engine labels each), defaulting when
            // absent so an unlabeled receipt still counts.
            for (const receipt of receipts) {
                const channel = receipt.channel ?? "unknown";
                const status: NotifyDeliveryStatus = receipt.successful ? "accepted" : "failed";

                countSend(channel, receipt.provider, status);

                if (status === "failed") {
                    warnFailedSend(channel, receipt.provider, { error: receiptError(receipt) });
                }
            }

            return receipts;
        },
        webhook: (payload) => sendToChannel("webhook", payload),
    };

    return { notify, push };
};
