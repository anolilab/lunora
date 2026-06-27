/**
 * Structural projections of the `SHARD` Durable Object namespace + one shard
 * stub, shared by the inbound dispatcher. Mirrors the shapes the outbound dev
 * capture sink uses (`packages/mail/src/from-env.ts`) so inbound dispatch routes
 * a parsed message into a Lunora function over the exact same admin-RPC-over-shard
 * path — without importing any Cloudflare types into `@lunora/mail`.
 */

/** Structural projection of one shard stub — only `fetch` returning something with `.json()`. */
interface ShardStubLike {
    fetch: (input: string, init?: { body?: string; headers?: Record<string, string>; method?: string }) => Promise<{ json: () => Promise<unknown> }>;
}

/**
 * Cloudflare Durable Object data-residency jurisdiction. Widening union —
 * Cloudflare adds values over time.
 * @see https://developers.cloudflare.com/durable-objects/reference/data-location/
 */
type DurableObjectJurisdiction = "eu" | "fedramp" | "us";

/** Structural projection of the `SHARD` Durable Object namespace. */
interface ShardNamespaceLike {
    get: (id: unknown) => ShardStubLike;
    idFromName: (name: string) => unknown;

    /**
     * Derive a jurisdiction-restricted subnamespace. Optional because older
     * workers-types releases (and test doubles) may not expose it.
     */
    jurisdiction?: (jurisdiction: DurableObjectJurisdiction) => ShardNamespaceLike;
}

/**
 * Return a jurisdiction-restricted view of `namespace`, or `namespace`
 * unchanged when no jurisdiction is configured. Fail-closed when the binding
 * lacks `.jurisdiction()` so a residency constraint is never silently dropped.
 */
const applyJurisdiction = (namespace: ShardNamespaceLike, jurisdiction?: DurableObjectJurisdiction): ShardNamespaceLike => {
    if (jurisdiction === undefined) {
        return namespace;
    }

    if (typeof namespace.jurisdiction !== "function") {
        throw new TypeError(
            `@lunora/mail: Durable Object namespace does not support jurisdiction("${jurisdiction}") — update @cloudflare/workers-types or remove the jurisdiction option`,
        );
    }

    return namespace.jurisdiction(jurisdiction);
};

export { applyJurisdiction };
export type { DurableObjectJurisdiction, ShardNamespaceLike, ShardStubLike };
