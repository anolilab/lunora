/**
 * Structural projection of the bits of `DurableObjectNamespace` the runtime
 * needs. Real workers-types defines a much wider surface; this lets us pass
 * unit-test doubles without coupling to `@cloudflare/workers-types`.
 */
export interface ShardNamespaceLike {
    get: (id: unknown) => { fetch: (request: Request) => Promise<Response> };

    /**
     * `getByName` is the friendlier API but isn't on every workers-types
     * release yet. We prefer it when available and fall back to
     * `idFromName` + `get` for compatibility.
     */
    getByName?: (name: string) => { fetch: (request: Request) => Promise<Response> };
    idFromName: (name: string) => unknown;
}

export interface ResolvedShard {
    fetch: (request: Request) => Promise<Response>;
}

/** Look up a shard stub by name, preferring `getByName` when present. */
export const resolveShard = (namespace: ShardNamespaceLike, shardKey: string): ResolvedShard => {
    if (typeof namespace.getByName === "function") {
        return namespace.getByName(shardKey);
    }

    const id = namespace.idFromName(shardKey);

    return namespace.get(id);
};
