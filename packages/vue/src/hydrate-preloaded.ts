import type { FunctionReference, Preloaded } from "@cirrus/client";
import type { Ref } from "vue";

import { useCirrusClient } from "./cirrus-provider";
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
 */
// eslint-disable-next-line import/prefer-default-export -- the package barrel re-exports every composable by name; a default here would break the `import { hydratePreloaded } from "@cirrus/vue"` surface.
export const hydratePreloaded = <T>(preloaded: Preloaded<T>): Ref<T | undefined> => {
    const client = useCirrusClient();

    const { args, functionPath, shardKey, value } = preloaded;

    // Rebuild a minimal FunctionReference from the serialized path. The token
    // carries no phantom types across the wire; the consumer supplies `T`, which
    // re-establishes the return type on the ref.
    const functionReference: FunctionReference = { __cirrusRef: functionPath };

    return subscribeToQuery<FunctionReference, T>(client, functionReference, args, {
        seed: value,
        shardKey,
    });
};
