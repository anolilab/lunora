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
    NotifyEnv,
    PushContent,
    RegisterInput,
    StoredSubscription,
    SubscriptionFilter,
    SubscriptionStore,
} from "./types";

const resolveMaybeFactory = <T>(value: T | ((env: NotifyEnv) => T | undefined) | undefined, env: NotifyEnv): T | undefined =>
    typeof value === "function" ? (value as (env: NotifyEnv) => T | undefined)(env) : value;

const receiptError = (receipt: Receipt): string | undefined => (receipt.successful ? undefined : receipt.errorMessages.join("; "));

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
 * middleware) and the dev in-memory fallback store are expensive to build and MUST
 * persist across requests (a `register()` in one request has to be visible to a
 * `broadcast()` in the next). All three fields are lazy: the engine is only built
 * when there is no `options.engine` override, the fallback store only when the
 * config supplies no real `store`.
 */
interface NotifyRuntime {
    engine?: Notification;
    fallbackStore?: SubscriptionStore;
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
        runtime = { warnedNoStore: false };
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

    let store: SubscriptionStore | undefined = definition.store?.(env);

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

    const deliver = async (subscription: StoredSubscription, payload: PushContent): Promise<Receipt> => {
        const receipt = await engine.sendToChannel("push", { ...payload, to: targetOf(subscription) });
        const error = receiptError(receipt);

        if (receipt.successful) {
            await subscriptionStore.markStatus(subscription.id, "ok");
        } else if (isGoneError(error)) {
            await subscriptionStore.delete(subscription.id);
        } else {
            await subscriptionStore.markStatus(subscription.id, "failed", error);
        }

        return receipt;
    };

    const push: LunoraPush = {
        broadcast: async (payload: PushContent, filter?: SubscriptionFilter): Promise<BroadcastResult> => {
            const subscriptions = await subscriptionStore.list(filter);

            const outcomes = await mapWithConcurrency(subscriptions, concurrency, async (subscription): Promise<BroadcastOutcome> => {
                const receipt = await deliver(subscription, payload);

                if (receipt.successful) {
                    return { id: subscription.id, status: "ok" };
                }

                const error = receiptError(receipt);

                return isGoneError(error) ? { error, id: subscription.id, status: "expired" } : { error, id: subscription.id, status: "failed" };
            });

            return {
                failed: outcomes.filter((outcome) => outcome.status === "failed").length,
                outcomes,
                pruned: outcomes.filter((outcome) => outcome.status === "expired").length,
                sent: outcomes.filter((outcome) => outcome.status === "ok").length,
                total: outcomes.length,
            };
        },
        list: (filter?: SubscriptionFilter): Promise<StoredSubscription[]> => subscriptionStore.list(filter),
        register: (input: RegisterInput): Promise<StoredSubscription> => subscriptionStore.put(normalizeRegisterInput(input)),
        send: async (target: StoredSubscription | string, payload: PushContent): Promise<Receipt> => deliver(await resolveSubscription(target), payload),
        unregister: (id: string): Promise<void> => subscriptionStore.delete(id),
    };

    const sendToChannel = async (channel: "chat" | "inapp" | "webhook", payload: unknown): Promise<Receipt> => {
        if (engine.getProvider(channel) === undefined) {
            throw new LunoraError("BAD_REQUEST", `@lunora/notify: the "${channel}" channel is not configured in defineNotify(...)`);
        }

        return engine.sendToChannel(channel, payload as never);
    };

    const notify: LunoraNotify = {
        chat: (payload) => sendToChannel("chat", payload),
        inApp: (payload) => sendToChannel("inapp", payload),
        push,
        send: (message) => engine.send(message),
        webhook: (payload) => sendToChannel("webhook", payload),
    };

    return { notify, push };
};
