import type { FunctionReference, Preloaded, SubscriptionErrorCallback } from "@lunora/client";
import type { Ref } from "vue";

import { isBrowser } from "../../../shared/is-browser";
import { useLunora } from "./lunora-provider";
import onScopeDisposeOrWarn from "./scope-dispose";
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
 * The preloaded value was read for whoever was signed in when the page loaded.
 * After a sign-out or user switch retires that identity
 * (`client.identityEpoch() > 0`), every `hydratePreloaded` on the client (mounted
 * then or later) stops using it and holds `undefined` until the live value
 * arrives — matching `@lunora/react`'s `usePreloadedQuery`. The ref is typed
 * `Ref<T>` like every other adapter's return, so guard for that window.
 */
// eslint-disable-next-line import/prefer-default-export -- the package barrel re-exports every composable by name; a default here would break the `import { hydratePreloaded } from "@lunora/vue"` surface.
export const hydratePreloaded = <T>(preloaded: Preloaded<T>, options: { onError?: SubscriptionErrorCallback } = {}): Ref<T> => {
    const client = useLunora();

    const { args, functionPath, shardKey, value } = preloaded;

    // Rebuild a minimal FunctionReference from the serialized path. The token
    // carries no phantom types across the wire; the consumer supplies `T`, which
    // re-establishes the return type on the ref.
    const functionReference: FunctionReference = { __lunoraRef: functionPath };

    const data = subscribeToQuery<FunctionReference, T>(client, functionReference, args, {
        onError: options.onError,
        seed: client.identityEpoch() === 0 ? value : undefined,
        shardKey,
    });

    if (isBrowser()) {
        onScopeDisposeOrWarn(
            client.onIdentityChange(() => {
                data.value = undefined;
            }),
            "[@lunora/vue] hydratePreloaded called with no active effect scope — its identity listener will not be cleaned up automatically.",
        );
    }

    return data as Ref<T>;
};
