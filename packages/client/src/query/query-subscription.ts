import type { ArgsOf, LunoraClient, FunctionReference, ReturnOf, SubscriptionError, SubscriptionErrorCallback, Unsubscribe } from "../index";

/**
 * The sentinel a framework adapter resolves its reactive args to when it wants
 * to short-circuit a query — no network call, no socket.
 */
export const SKIP = "skip" as const;

/** Args after a framework has resolved its reactivity primitive, or the skip sentinel. */
export type ResolvedArgs<F extends FunctionReference> = ArgsOf<F> | typeof SKIP;

/**
 * The framework-neutral sinks a {@link createQuerySubscription} call drives. A
 * framework adapter supplies these, wiring each into its own reactivity
 * primitive (a TanStack cache write, a Vue `ref`, a Svelte store `set`, a Solid
 * signal setter).
 *
 * `onData` fires when a fresh server value lands (the initial frame or a delta).
 * `onError` fires when the subscription attach threw, or the server pushed a
 * subscription-scoped error — it is optional, and when omitted an attach throw
 * propagates to the caller (preserving the "no error channel" behaviour of
 * adapters like Solid/Vue that never had one) rather than being swallowed.
 * `onReset` fires when the resolved args are `"skip"`: clear any prior value.
 */
export interface QuerySubscriptionSinks<T> {
    onData: (value: T) => void;
    onError?: (error: SubscriptionError) => void;
    onReset?: () => void;
}

export interface QuerySubscriptionOptions {
    /** Route to a specific shard when the target function is `.shardBy(...)`-partitioned. */
    shardKey?: string;
}

/** Normalise an unknown thrown value into the client's {@link SubscriptionError} shape. */
export const toSubscriptionError = (error: unknown): SubscriptionError => {
    if (error instanceof Error) {
        return { message: error.message };
    }

    return { message: String(error) };
};

/**
 * The subscribe → snapshot → error/reset → cleanup state machine shared by
 * every Lunora framework adapter's live-query hook.
 *
 * Given a `client`, a function reference, the already-resolved `args` (a
 * framework reads its own reactive source first, then hands the plain value in),
 * and a set of {@link QuerySubscriptionSinks}, this opens one `client.subscribe`
 * registration and returns the {@link Unsubscribe} to tear it down. Each
 * framework owns *when* to call this (a React effect, a Vue `watch`, a Svelte
 * store start callback, a Solid `createEffect(on(...))`) and *where* to stash
 * the value — this owns the lifecycle in between, so the skip-handling, the
 * value/error fan-out, the attach-throw normalisation, and the
 * cancellation-guarded teardown live in exactly one place.
 *
 * Behaviour. When `args === "skip"` it calls `sinks.onReset?.()` and returns a
 * no-op teardown; no `client.subscribe` is issued. Otherwise it opens
 * `client.subscribe(fn, args, …, { shardKey, onError })`: server pushes route to
 * `sinks.onData`, and the client's own `onError` channel (a server-rejected
 * subscription) routes to `sinks.onError` when present. The attach is wrapped —
 * if `client.subscribe` itself throws, the error is normalised to a
 * {@link SubscriptionError} and delivered to `sinks.onError` when present; with
 * no `onError` sink the throw is rethrown so adapters without an error channel
 * behave exactly as before. The returned teardown is idempotent and
 * cancellation-guarded: once it runs, no further `onData`/`onError` from an
 * in-flight push reaches the sinks.
 */
export const createQuerySubscription = <F extends FunctionReference, T = ReturnOf<F>>(
    client: LunoraClient,
    function_: F,
    args: ResolvedArgs<F>,
    sinks: QuerySubscriptionSinks<T>,
    options: QuerySubscriptionOptions = {},
): Unsubscribe => {
    if (args === SKIP) {
        sinks.onReset?.();

        return () => {};
    }

    let cancelled = false;

    const handleError = (error: SubscriptionError): void => {
        if (cancelled) {
            return;
        }

        sinks.onError?.(error);
    };

    const onError: SubscriptionErrorCallback | undefined = sinks.onError ? handleError : undefined;

    let unsubscribe: Unsubscribe;

    try {
        unsubscribe = client.subscribe<F>(
            function_,
            args,
            (value) => {
                if (cancelled) {
                    return;
                }

                sinks.onData(value as unknown as T);
            },
            { onError, shardKey: options.shardKey },
        );
    } catch (error: unknown) {
        // The attach itself threw (e.g. the client is closed). Adapters with an
        // error channel surface it; adapters without one (Solid/Vue) never had a
        // place to put it, so preserve their behaviour by rethrowing.
        if (!sinks.onError) {
            throw error;
        }

        handleError(toSubscriptionError(error));

        return () => {
            cancelled = true;
        };
    }

    return () => {
        cancelled = true;
        unsubscribe();
    };
};
