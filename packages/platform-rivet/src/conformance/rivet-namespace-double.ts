/**
 * An in-memory stand-in for one actor type on a RivetKit client —
 * `client.<actorName>`, the surface `createRivetShardDirectory` is built over.
 *
 * The directory contract is small and its guarantees are about *addressing*
 * rather than about what a shard does with the request: the same key must
 * resolve to the same instance every time, and a resolved stub must be
 * dispatchable. So this double answers a `fetch` with the resolved key, which
 * is exactly enough to prove determinism (the TCK compares two responses for
 * the same key) without pretending to run an actor.
 *
 * It also records the region each key was created with, which is how the
 * placement test pins that `resolveRegion` is consulted only for the call that
 * creates an actor — Rivet never migrates one afterwards.
 */

import type { RivetActorHandleLike, RivetActorNamespaceLike, RivetGetOrCreateOptions } from "../rivet-context";

/** The namespace double plus the bookkeeping a test asserts against. */
export interface RivetNamespaceDouble extends RivetActorNamespaceLike {
    /** The region each key was first created in, when one was requested. */
    readonly createdRegions: Map<string, string | undefined>;
    /** How many times each key has been resolved. */
    readonly resolutions: Map<string, number>;
}

/** Build an in-memory RivetKit actor namespace. */
export const createRivetNamespaceDouble = (): RivetNamespaceDouble => {
    const createdRegions = new Map<string, string | undefined>();
    const resolutions = new Map<string, number>();

    return {
        createdRegions,
        getOrCreate: (key: string | string[], options?: RivetGetOrCreateOptions): RivetActorHandleLike => {
            const resolved = typeof key === "string" ? key : key.join("/");

            resolutions.set(resolved, (resolutions.get(resolved) ?? 0) + 1);

            // Get-or-*create*: the region is recorded by the first resolution
            // only, mirroring Rivet's "an actor does not migrate between
            // regions" rule. A later hint for the same key is inert, which is
            // precisely what the contract calls advisory.
            if (!createdRegions.has(resolved)) {
                createdRegions.set(resolved, options?.createInRegion);
            }

            return {
                fetch: async (): Promise<Response> => new Response(resolved),
            };
        },
        resolutions,
    };
};
