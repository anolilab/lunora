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
 * this is a widening union rather than a closed enum.
 *
 * Other providers may map these to their own region/placement concepts or
 * leave them unsupported.
 */
export type ShardJurisdiction = "eu" | "fedramp" | "us";

/**
 * A resolved shard stub. The engine calls `fetch` (or an equivalent RPC
 * method) to dispatch work to the shard.
 */
export interface ShardStub {
    /** Dispatch a request to the shard. */
    fetch: (request: Request) => Promise<Response>;
}

/**
 * The shard directory contract. One instance per shard namespace.
 */
export interface ShardDirectory {
    /**
     * Resolve an opaque id (from `idForName`) to a stub. Required when
     * `getByName` is absent.
     */
    get: (id: unknown) => ShardStub;

    /**
     * Resolve a shard key to a stub. Prefer this when available; it avoids
     * the two-step `idForName` + `get` dance.
     */
    getByName?: (name: string) => ShardStub;

    /**
     * Derive a stable, opaque shard id from a human-readable key. Required
     * when `getByName` is absent.
     */
    idForName: (name: string) => unknown;

    /**
     * Derive a jurisdiction-restricted view of this directory. Every stub
     * created from the returned directory is pinned to `jurisdiction`.
     * Optional because some providers may not support placement hints;
     * callers should fail closed when a jurisdiction is requested but this
     * method is absent.
     */
    jurisdiction?: (jurisdiction: ShardJurisdiction) => ShardDirectory;
}
