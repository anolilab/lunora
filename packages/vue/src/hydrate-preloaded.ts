import type { FunctionReference, Preloaded, SubscriptionErrorCallback } from "@lunora/client";
import type { Ref } from "vue";

import { useLunora } from "./lunora-provider";
import { subscribeToQuery } from "./use-query";

/**
 * Hydrate a query from a {@link Preloaded} token produced by `preloadQuery`
 * during SSR, then keep it live — the Vue half of PLAN4's reactive-loader
 * handoff.
 *
 * The returned `ref` is seeded **synchronously** from `preloaded.value`, so the
 * very first read (during hydration) shows the server value: no loading flash,
 * no hydration mismatch. After seeding it opens a WebSocket subscription on the
 * same `(functionPath, args, shardKey)` the SSR loader used, so every later
 * server delta updates the ref exactly like `useQuery`.
 *
 * The subscription tears down with the surrounding effect scope (component
 * unmount or `effectScope().stop()`), inherited from `subscribeToQuery`.
 *
 * Pass `onError` to surface a subscription-scoped error the server pushes (a
 * session expiry, an RLS denial). Without it such an error is dropped and the
 * ref keeps rendering the SSR snapshot as if it were live.
 *
 * The ref is `Ref<T>`, not `Ref<T | undefined>`: `subscribeToQuery`'s ref widens
 * to `undefined` because it also serves the unseeded `useQuery` case, but this
 * entry point always passes `seed: preloaded.value`, so the "seeded
 * synchronously, no loading flash" contract means it is never undefined. Every
 * other adapter's `hydratePreloaded` returns `T`; narrowing here stops Vue
 * consumers guarding a state that cannot occur.
 */
// eslint-disable-next-line import/prefer-default-export -- the package barrel re-exports every composable by name; a default here would break the `import { hydratePreloaded } from "@lunora/vue"` surface.
export const hydratePreloaded = <T>(preloaded: Preloaded<T>, options: { onError?: SubscriptionErrorCallback } = {}): Ref<T> => {
    const client = useLunora();

    const { args, functionPath, shardKey, value } = preloaded;

    // Rebuild a minimal FunctionReference from the serialized path. The token
    // carries no phantom types across the wire; the consumer supplies `T`, which
    // re-establishes the return type on the ref.
    const functionReference: FunctionReference = { __lunoraRef: functionPath };

    return subscribeToQuery<FunctionReference, T>(client, functionReference, args, {
        onError: options.onError,
        seed: value,
        shardKey,
    }) as Ref<T>;
};
