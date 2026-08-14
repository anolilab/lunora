/**
 * Rivet adapter: the provider-neutral `@lunora/platform` `ShardDirectory` over
 * a RivetKit client.
 *
 * This is the piece that makes Rivet a *platform* for Lunora rather than a
 * place to run one shard: `client.<actorName>.getOrCreate(key)` is a
 * deterministic key → instance mapping, and the handle it returns has a
 * `fetch` that reaches the actor's `onRequest` handler. That is exactly
 * `ShardStub`.
 *
 * The directory lands on the {@link DirectShardDirectory} branch of the
 * contract's union: Rivet addresses actors by key, so `getByName` is the whole
 * implementation and there is no `idForName`/`get` pair to stub out. (Rivet
 * does* have actor ids — `getForId`, `handle.resolve()` — but an id is minted
 * by creation rather than derived from a key, so it cannot answer
 * `idForName`'s "derive a stable, opaque shard id from a shard key".)
 *
 * ## Keys
 *
 * Lunora shard keys are strings; Rivet keys are string arrays, and Rivet's own
 * documentation is emphatic that compound keys should be arrays rather than
 * interpolated strings, because interpolation lets user-supplied data inject a
 * delimiter and address someone else's actor. A Lunora shard key is already one
 * opaque string by the time it reaches a directory, so it is passed as a
 * **single-element array** — no splitting, no delimiter, nothing for a `:` in a
 * tenant id to break.
 *
 * ## Regions
 *
 * `ShardRegionHint` speaks Cloudflare's vocabulary (`wnam`, `weur`, `apac`, …).
 * Rivet region slugs are deployment-defined — `atl` on Rivet Cloud,
 * operator-named when self-hosting — so there is no mapping this package can
 * hard-code that would be right for two deployments. `resolveRegion` is
 * therefore a caller-supplied function, and with none supplied the hint is
 * dropped rather than guessed. Dropping it is safe by the contract's own terms:
 * a region is advisory, "a provider may ignore it", and everything downstream
 * must work identically whether it was honoured or not.
 *
 * ## Jurisdictions
 *
 * `jurisdiction()` is deliberately **not** implemented. A jurisdiction is a
 * hard data-residency constraint a caller must fail closed on, and Rivet's
 * region selection is best-effort placement. Mapping one onto the other would
 * turn "this data may not leave the EU" into "we tried" — so the method is
 * absent, and `resolveShard`'s callers fail closed as the contract instructs.
 */

import type { DirectShardDirectory, ShardRegionHint, ShardStub } from "@lunora/platform";

import type { RivetActorNamespaceLike } from "./rivet-context";

/** Options for {@link createRivetShardDirectory}. */
export interface RivetShardDirectoryOptions {
    /**
     * Map a Lunora placement region onto a Rivet region slug for this
     * deployment. Return `undefined` to let Rivet place the actor itself.
     *
     * Only consulted when a `locationHint` is supplied, and only honoured by
     * the call that *creates* the actor — Rivet never migrates one afterwards,
     * which matches the contract's "honoured only by the resolution that
     * creates the object" note exactly.
     */
    resolveRegion?: (hint: ShardRegionHint) => string | undefined;
}

/**
 * Build a `ShardDirectory` over one actor type on a RivetKit client.
 *
 * `namespace` is the client's per-actor accessor — `client.myShard`, not the
 * client itself — so a deployment with more than one shard actor type builds
 * one directory per type, and neither can accidentally address the other's
 * keyspace.
 */
export const createRivetShardDirectory = (namespace: RivetActorNamespaceLike, options: RivetShardDirectoryOptions = {}): DirectShardDirectory => {
    return {
        getByName: (name: string, locationHint?: ShardRegionHint): ShardStub => {
            const region = locationHint === undefined ? undefined : options.resolveRegion?.(locationHint);
            const handle = namespace.getOrCreate([name], region === undefined ? undefined : { createInRegion: region });

            return {
                // Forwarded whole rather than decomposed into url/init: the
                // engine's RPC edge puts meaning in the method, headers and
                // body, and Rivet's `onRequest` is documented to receive the
                // request unchanged.
                fetch: async (request: Request): Promise<Response> => handle.fetch(request),
            };
        },
    };
};
