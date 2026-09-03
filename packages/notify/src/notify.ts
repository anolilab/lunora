import { LunoraError } from "@lunora/errors";
import type { Notification, Provider, Receipt } from "@visulima/notification";

import type { ResolvedProviders } from "./providers";
import { buildEngine } from "./providers";
import { memorySubscriptionStore } from "./subscriptions/memory-store";
import { isGoneError, normalizeRegisterInput, targetOf } from "./subscriptions/normalize";
import type {
    BroadcastOutcome,
    BroadcastPageResult,
    BroadcastResult,
    LunoraNotify,
    LunoraPush,
    NotifyDefinition,
    NotifyDeliveryStatus,
    NotifyEnv,
    NotifyLogger,
    NotifyMetrics,
    PushContent,
    PushOwner,
    PushSubscriptionDevice,
    RegisterInput,
    StoredSubscription,
    SubscriptionFilter,
    SubscriptionStore,
} from "./types";

/**
 * Default page size for `push.broadcast`'s internal keyset pagination (see
 * `CreateNotifyOptions`'s `broadcastPageSize`). A few hundred keeps one
 * page's store round trip + fan-out comfortably inside Worker CPU/wall
 * limits while still being large enough that a typical small app's
 * broadcast completes in one page.
 */
const DEFAULT_BROADCAST_PAGE_SIZE = 250;

const resolveMaybeFactory = <T>(value: T | ((env: NotifyEnv) => T | undefined) | undefined, env: NotifyEnv): T | undefined =>
    typeof value === "function" ? (value as (env: NotifyEnv) => T | undefined)(env) : value;

const receiptError = (receipt: Receipt): string | undefined => (receipt.successful ? undefined : receipt.errorMessages.join("; "));

/**
 * Map a push send's receipt to the observability {@link NotifyDeliveryStatus}:
 * `accepted` on success, `gone` when the endpoint is unregistered (404/410, FCM
 * `UNREGISTERED` — the subscription is pruned), else `failed`.
 */
const pushDeliveryStatus = (receipt: Receipt, error: string | undefined, kind: StoredSubscription["kind"]): NotifyDeliveryStatus => {
    if (receipt.successful) {
        return "accepted";
    }

    return isGoneError(error, kind) ? "gone" : "failed";
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
        allowedPushOrigins: definition.allowedPushOrigins,
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
    /**
     * Page size for `push.broadcast`'s internal keyset pagination over the
     * subscription store (default {@link DEFAULT_BROADCAST_PAGE_SIZE}, 250).
     *
     * A test/tuning seam only. **Apps set `broadcastPageSize` on `defineNotify`
     * instead** — the sole production call is codegen's fixed
     * `createNotify(definition, env, { log, metrics })`, so nothing an app writes
     * reaches this object. Set here it wins over the definition's value.
     */
    broadcastPageSize?: number;

    /**
     * Max concurrent sends during a `broadcast` (default 10). Test/tuning seam;
     * apps set `concurrency` on `defineNotify` — see
     * {@link CreateNotifyOptions.broadcastPageSize}.
     */
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
    // `definition` before the defaults, `options` before both: the app's
    // `defineNotify` is the only seam an app has (codegen's call passes just
    // `{ log, metrics }`), while `options` stays the test/tuning override.
    const concurrency = Math.max(1, options.concurrency ?? definition.concurrency ?? 10);
    const broadcastPageSize = Math.max(1, options.broadcastPageSize ?? definition.broadcastPageSize ?? DEFAULT_BROADCAST_PAGE_SIZE);
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
     * `allowedPushOrigins` allowlist. Without it the posture is defence-in-depth
     * rather than a guarantee: a STRING classifier at register time
     * (`assertPushEndpoint` → shared `isPrivateHost`) plus a best-effort
     * resolved-address re-check at send time. Both can be defeated (a DoH outage
     * falls back to the string guard, and resolution is TOCTOU-imperfect); an
     * exact-origin allowlist cannot.
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
            "@lunora/notify: Web Push registered without `allowedPushOrigins` — endpoints are guarded by a string classifier at register time and a best-effort DNS re-check at send time, both of which are defeatable. Set `allowedPushOrigins` to the exact push-service origins for a hard guarantee.",
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
            status = pushDeliveryStatus(receipt, error, subscription.kind);
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

    /**
     * Deliver `payload` to exactly the given (already-paged) `subscriptions`
     * batch, bounded by `concurrency`, and fold the outcomes into one
     * {@link BroadcastResult}. Shared by `broadcastPage` (one page) and, via
     * its page-walk loop, `broadcast` (the whole audience) — the bucketed
     * metric-count / outcome-shaping logic that used to live inline in
     * `broadcast` lives here once instead of twice.
     */
    const deliverPage = async (payload: PushContent, subscriptions: StoredSubscription[]): Promise<BroadcastResult> => {
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
            const key = `${kind} ${status}`;
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
    };

    /**
     * Fetch and deliver ONE bounded page of `filter`'s matching subscriptions
     * (see {@link LunoraPush.broadcastPage}). Pages are keyset-paginated on
     * `id` (`filter.after`, exclusive): the store is asked for `pageSize + 1`
     * rows so an exactly-full page can be told apart from the true last page
     * without a second (empty) round trip — the `+1`th row, when present, is
     * trimmed off and its predecessor's `id` becomes `nextCursor`.
     *
     * DEFENSIVE RE-FILTER: `filter.after` is OPTIONAL for a `SubscriptionStore`
     * to honor (see {@link SubscriptionFilter.after}'s documented "unpaged if
     * unsupported" fallback). Rather than trust the store, the fetched rows are
     * re-filtered here to `id > filter.after` unconditionally — a compliant
     * store's rows already all satisfy this (the filter is then a no-op cost),
     * while a store that ignores `after` and keeps returning its same unpaged
     * window gets its stale (already-delivered) rows dropped before they reach
     * `deliverPage`. This is what makes `broadcast`'s page-walk both
     * NEVER-DOUBLE-DELIVER and guaranteed to terminate against such a store:
     * `nextCursor` only ever advances (each page's eligible rows are, by
     * construction, all greater than the cursor just used), so the "new since
     * cursor" window against a fixed-size store response shrinks every
     * iteration until it empties out.
     *
     * A non-positive `filter.limit` (zero or negative) short-circuits to an
     * empty page — `{ nextCursor: undefined, result: <all-zero> }` — without
     * calling the store or `deliverPage`. This differs from the STORE layer's
     * `limit` convention (non-positive means "no cap"): here `limit` is an
     * audience cap, so its zero-floor is zero deliveries, not an unbounded page.
     */
    const broadcastPage = async (payload: PushContent, filter?: SubscriptionFilter): Promise<BroadcastPageResult> => {
        // A non-positive `limit` means "deliver to nobody" at this (audience-cap)
        // layer — NOT "no cap", which is the store layer's convention for the same
        // sentinel (see SubscriptionFilter.limit's JSDoc). Short-circuit before
        // touching the store or deliverPage: falling through to the `> 0` gate
        // below would treat `limit: 0` as "no cap" and fan out a full page.
        if (filter?.limit !== undefined && filter.limit <= 0) {
            return { nextCursor: undefined, result: { failed: 0, outcomes: [], pruned: 0, sent: 0, total: 0 } };
        }

        // `filter.limit`, when set, is an OVERALL cap (see its JSDoc) — never
        // let a single page exceed it even when the configured page size is larger.
        const cap = filter?.limit !== undefined && filter.limit > 0 ? Math.trunc(filter.limit) : undefined;
        const pageSize = cap === undefined ? broadcastPageSize : Math.min(cap, broadcastPageSize);

        const rows = await subscriptionStore.list({ after: filter?.after, kind: filter?.kind, limit: pageSize + 1, userId: filter?.userId });
        const eligible = filter?.after === undefined ? rows : rows.filter((row) => row.id > (filter.after as string));
        const hasMore = eligible.length > pageSize;
        const page = hasMore ? eligible.slice(0, pageSize) : eligible;

        if (page.length === 0 && filter?.after === undefined) {
            // A broadcast that matched nobody on its FIRST page — surface the
            // no-op rather than a silent all-zero result (per-send metrics never
            // fire). Only on the first page so a legitimately-exhausted later
            // page of an otherwise-nonempty broadcast doesn't also count as a skip.
            observeSkip("push", "no-subscriptions-matched");
        }

        const result = await deliverPage(payload, page);
        const nextCursor = hasMore ? page[page.length - 1]?.id : undefined;

        return { nextCursor, result };
    };

    /**
     * Walk every page of `filter`'s matching audience (see
     * {@link LunoraPush.broadcast}), merging each page's {@link BroadcastResult}
     * into one aggregate. Stops when a page reports no `nextCursor` — the
     * normal end, which `broadcastPage`'s defensive re-filter also guarantees
     * to eventually reach even against a `SubscriptionStore` that ignores
     * `filter.after` (see its doc comment). The `nextCursor === cursor` check
     * is an extra backstop against a pathological store whose `nextCursor`
     * somehow fails to advance despite reporting more rows remain.
     *
     * `filter.limit`, when set, is a CUMULATIVE cap across the whole walk (see
     * its JSDoc) — `broadcastPage` itself only enforces `limit` as a per-page
     * cap, so each page here is handed the shrinking REMAINING budget
     * (`overallLimit - aggregate.total`) rather than the original `filter.limit`
     * unmodified; forwarding it verbatim would let every page reach up to
     * `limit` MORE subscriptions instead of the whole broadcast topping out
     * there. The walk also stops as soon as the cumulative total meets the cap,
     * even if more pages remain.
     */
    const broadcast = async (payload: PushContent, filter?: SubscriptionFilter): Promise<BroadcastResult> => {
        const aggregate: BroadcastResult = { failed: 0, outcomes: [], pruned: 0, sent: 0, total: 0 };
        let cursor = filter?.after;
        const overallLimit = filter?.limit;

        // A non-positive overall limit means "deliver to nobody" (see
        // broadcastPage's matching guard above) — return the all-zero aggregate
        // before the walk so page 1 never gets handed a `0` per-page budget (which
        // broadcastPage's OWN `> 0` gate would otherwise read as "no cap" and fan
        // out a full page before the cumulative `total >= overallLimit` break below
        // ever fires).
        if (overallLimit !== undefined && overallLimit <= 0) {
            return aggregate;
        }

        for (;;) {
            const pageFilter: SubscriptionFilter | undefined =
                overallLimit === undefined ? { ...filter, after: cursor } : { ...filter, after: cursor, limit: overallLimit - aggregate.total };

            // eslint-disable-next-line no-await-in-loop -- pages are inherently sequential: page N's cursor comes from page N-1's result
            const { nextCursor, result } = await broadcastPage(payload, pageFilter);

            aggregate.failed += result.failed;
            aggregate.pruned += result.pruned;
            aggregate.sent += result.sent;
            aggregate.total += result.total;
            aggregate.outcomes.push(...result.outcomes);

            if (overallLimit !== undefined && aggregate.total >= overallLimit) {
                break;
            }

            if (nextCursor === undefined || nextCursor === cursor) {
                break;
            }

            cursor = nextCursor;
        }

        return aggregate;
    };

    const push: LunoraPush = {
        broadcast,
        broadcastPage,
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
        unregister: async (id: string, owner: PushOwner): Promise<void> => {
            // Ownership is checked HERE rather than pushed into the store: the
            // store is an app-implementable interface, and a scope parameter an
            // implementation is free to ignore is not a check. The internal
            // gone-pruning path (`deliver`) keeps calling `store.delete`
            // directly — it acts on a delivery receipt, not on a caller's key.
            const stored = await subscriptionStore.get(id);

            if (stored === undefined || (stored.userId ?? null) !== (owner.userId ?? null)) {
                return;
            }

            await subscriptionStore.delete(id);
        },
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
