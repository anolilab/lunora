import type { FunctionReference, Preloaded, SubscriptionErrorCallback } from "@lunora/client";
import type { Accessor } from "solid-js";
import { createSignal } from "solid-js";

import { useLunora, useLunoraClientSwapped } from "./context";
import { onMounted } from "./solid-compat";

/**
 * Hydrate a query from a {@link Preloaded} token produced by `preloadQuery`
 * during SSR, then keep it live.
 *
 * This is the client half of PLAN4's "your loaders are live" handoff. The
 * returned accessor is seeded **synchronously** from `preloaded.value`, so the
 * very first read — during hydration — returns the server-rendered value with
 * no loading flash and no `Suspense` fallback (unlike `createResource`, which
 * always starts pending). Once the component mounts, a WebSocket subscription
 * attaches and every subsequent server delta flows into the same signal, so the
 * UI goes live with zero refetch.
 *
 * ```tsx
 * // route loader (server): const preloaded = await preloadQuery(client, api.messages.list, args);
 * const messages = hydratePreloaded(preloaded); // seeded from SSR, then live
 * return <pre>{JSON.stringify(messages())}</pre>;
 * ```
 *
 * Mount callbacks do not run on the server during SSR (both Solid majors defer
 * them until after hydration), so the subscription is strictly client-side —
 * the seed is the only value the server render ever sees.
 *
 * Pass `onError` to surface a subscription-scoped error the server pushes (a
 * session expiry, an RLS denial). Without it such an error is dropped and the
 * accessor keeps rendering the SSR snapshot as if it were live.
 *
 * The preloaded value was read for whoever was signed in when the page loaded.
 * After a sign-out or user switch retires that identity
 * (`client.identityEpoch() > 0`), every `hydratePreloaded` on the client (mounted
 * then or later) stops using it and returns `undefined` until the live value
 * arrives — matching `@lunora/react`'s `usePreloadedQuery`, hence the
 * `Accessor<T | undefined>` type. The same holds under a `LunoraProvider` whose
 * `client` was swapped: the value was preloaded for the first client.
 */
const hydratePreloaded = <T>(preloaded: Preloaded<T>, options: { onError?: SubscriptionErrorCallback } = {}): Accessor<T | undefined> => {
    const client = useLunora();

    const { args, functionPath, shardKey, value } = preloaded;

    // Seed synchronously: the signal already holds the SSR value before the
    // first render reads it, so there is no loading window until an identity
    // is retired — or the provider's `client` is swapped, since the value was
    // preloaded for the client it first rendered with.
    const [data, setData] = createSignal<T | undefined>(client.identityEpoch() === 0 && !useLunoraClientSwapped() ? value : undefined);

    const functionRef: FunctionReference = { __lunoraRef: functionPath };

    onMounted(() => {
        const offIdentity = client.onIdentityChange(() => {
            setData(() => undefined);
        });

        // Mount is deferred: an identity retired after the seed was taken but
        // before this listener existed must still blank it.
        if (client.identityEpoch() !== 0) {
            setData(() => undefined);
        }

        const unsubscribe = client.subscribe(functionRef, args, (next) => setData(() => next as T), { onError: options.onError, shardKey });

        return () => {
            offIdentity();
            unsubscribe();
        };
    });

    return data;
};

export default hydratePreloaded;
