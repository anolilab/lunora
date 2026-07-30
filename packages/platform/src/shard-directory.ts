/**
 * `ShardDirectory` — the provider-neutral contract for resolving shard keys to
 * callable stubs. On Cloudflare this is backed by `DurableObjectNamespace`
 * (`idFromName` + `get` + `jurisdiction`). On another provider it may be an
 * actor registry, a consistent-hash router, or a local in-process map.
 *
 * The engine relies on two capabilities:
 * 1. **Deterministic placement** — a shard key always resolves to the same
 * logical shard (`idForName`).
 * 2. **RPC dispatch** — a resolved stub can receive a `fetch` request (or
 * equivalent RPC call) that the shard handles.
 *
 * Placement hints (jurisdiction, region) are provider-mapped and may be
 * unsupported per the capability matrix.
 */

/**
 * Cloudflare Durable Object jurisdictions restrict where a DO runs and
 * persists data, for data-residency / compliance regimes (GDPR, FedRAMP, US
 * data residency). The set is open — Cloudflare adds values over time — so
 * this is a widening union rather than a closed enum: the three literals are
 * the values we know about (and the ones editors autocomplete), but any other
 * string a provider introduces is accepted without a release of this package.
 *
 * Other providers may map these to their own region/placement concepts or
 * leave them unsupported.
 */
export type ShardJurisdiction = "eu" | "fedramp" | "us" | (Record<never, never> & string);

/**
 * A resolved shard stub. The engine calls `fetch` (or an equivalent RPC
 * method) to dispatch work to the shard.
 */
export interface ShardStub {
    /** Dispatch a request to the shard. */
    fetch: (request: Request) => Promise<Response>;
}

/**
 * A directory that resolves a shard key straight to a stub in one step. The
 * two-step `idForName` + `get` pair stays available for providers that expose
 * an addressable id (Cloudflare's `DurableObjectNamespace` does both), but a
 * provider whose registry only understands names implements `getByName` alone.
 */
export interface DirectShardDirectory {
    /** Resolve an opaque id (from `idForName`) to a stub, when the provider has ids. */
    get?: (id: unknown) => ShardStub;

    /** Resolve a shard key to a stub. */
    getByName: (name: string) => ShardStub;

    /** Derive a stable, opaque shard id from a shard key, when the provider has ids. */
    idForName?: (name: string) => unknown;

    /** See {@link ShardDirectory}. */
    jurisdiction?: (jurisdiction: ShardJurisdiction) => ShardDirectory;
}

/**
 * A directory that resolves a shard key in two steps: derive an opaque id with
 * `idForName`, then materialize a stub for it with `get`. This is the shape of
 * an id-addressed registry that has no name-based lookup of its own.
 */
export interface TwoStepShardDirectory {
    /** Resolve an opaque id (from `idForName`) to a stub. */
    get: (id: unknown) => ShardStub;

    /**
     * Absent — the discriminant that selects the two-step branch.
     */
    // eslint-disable-next-line sonarjs/no-redundant-optional -- `?: undefined` is the discriminant, not a redundant optional: it is what lets `directory.getByName !== undefined` narrow the union to `DirectShardDirectory` (and its negation to this branch) in `resolveShard`. Dropping either half breaks that narrowing.
    getByName?: undefined;

    /** Derive a stable, opaque shard id from a human-readable key. */
    idForName: (name: string) => unknown;

    /** See {@link ShardDirectory}. */
    jurisdiction?: (jurisdiction: ShardJurisdiction) => ShardDirectory;
}

/**
 * The shard directory contract. One instance per shard namespace.
 *
 * A provider satisfies this with *either* direct name lookup
 * ({@link DirectShardDirectory}) *or* the two-step id dance
 * ({@link TwoStepShardDirectory}) — it is a union, not one interface with
 * optional halves, so a name-only registry never has to stub out `idForName`
 * and `get` to type-check. Providers that support both (Cloudflare) simply
 * populate all three and land on the direct branch.
 *
 * Prefer {@link resolveShard} over reaching into either branch by hand.
 *
 * `jurisdiction` derives a placement-restricted view of the directory: every
 * stub created from the returned directory is pinned to that jurisdiction. It
 * is optional because some providers have no placement hints; callers must fail
 * closed when a jurisdiction is requested but the method is absent.
 */
export type ShardDirectory = DirectShardDirectory | TwoStepShardDirectory;

/**
 * Resolve a shard key to a stub against either directory shape. Uses direct
 * name lookup when the provider has it, and falls back to the two-step
 * `idForName` + `get` dance otherwise.
 */
export const resolveShard = (directory: ShardDirectory, name: string): ShardStub => {
    if (directory.getByName !== undefined) {
        return directory.getByName(name);
    }

    return directory.get(directory.idForName(name));
};
