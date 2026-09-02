import type { FunctionReference, Preloaded, SubscriptionErrorCallback } from "@lunora/client";
import type { Accessor } from "solid-js";
import { createSignal } from "solid-js";

import { useLunora } from "./context";
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
 */
const hydratePreloaded = <T>(preloaded: Preloaded<T>, options: { onError?: SubscriptionErrorCallback } = {}): Accessor<T> => {
    const client = useLunora();

    const { args, functionPath, shardKey, value } = preloaded;

    // Seed synchronously: the signal already holds the SSR value before the
    // first render reads it, so there is no `undefined`/loading window.
    const [data, setData] = createSignal<T>(value);

    const functionRef: FunctionReference = { __lunoraRef: functionPath };

    onMounted(() => client.subscribe(functionRef, args, (next) => setData(() => next as T), { onError: options.onError, shardKey }));

    return data;
};

export default hydratePreloaded;
