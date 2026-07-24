import type { ShardDirectory, ShardJurisdiction } from "@lunora/platform";
import { resolveShard as resolveShardStub } from "@lunora/platform";

/**
 * Adapt a Cloudflare-shaped {@link ShardNamespaceLike} to the provider-neutral
 * {@link ShardDirectory} contract.
 *
 * The two are near-identical — the only real skew is the method name
 * (`idFromName` vs the contract's `idForName`). Mapping here rather than
 * renaming the namespace keeps `ShardNamespaceLike` matching the runtime's
 * `DurableObjectNamespace` binding, while routing every resolution through the
 * one contract `@lunora/platform` defines. A namespace that exposes `getByName`
 * lands on the direct branch; one that doesn't lands on the two-step
 * `idForName` + `get` branch — the same preference the contract's own
 * `resolveShard` encodes.
 */
const toDirectory = (namespace: ShardNamespaceLike): ShardDirectory => {
    const jurisdiction =
        typeof namespace.jurisdiction === "function"
            ? (hint: ShardJurisdiction) =>
                  toDirectory((namespace.jurisdiction as NonNullable<ShardNamespaceLike["jurisdiction"]>)(hint as DurableObjectJurisdiction))
            : undefined;

    if (typeof namespace.getByName === "function") {
        return {
            get: (id) => namespace.get(id),
            getByName: namespace.getByName,
            idForName: (name) => namespace.idFromName(name),
            jurisdiction,
        };
    }

    return {
        get: (id) => namespace.get(id),
        idForName: (name) => namespace.idFromName(name),
        jurisdiction,
    };
};

/**
 * Cloudflare Durable Object jurisdictions restrict where a DO runs and persists
 * data, for data-residency / compliance regimes (GDPR, FedRAMP, US data
 * residency). The set is open — Cloudflare adds values over time — so this is a
 * widening union rather than a closed enum.
 * @see https://developers.cloudflare.com/durable-objects/reference/data-location/
 */
export type DurableObjectJurisdiction = "eu" | "fedramp" | "us";

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

    /**
     * Derive a jurisdiction-restricted subnamespace. Every ID and stub created
     * from the returned namespace is pinned to `jurisdiction`. Optional because
     * older workers-types releases (and unit-test doubles) may not expose it;
     * {@link applyJurisdiction} fails closed when a jurisdiction is requested
     * but this method is absent.
     */
    jurisdiction?: (jurisdiction: DurableObjectJurisdiction) => ShardNamespaceLike;
}

export interface ResolvedShard {
    fetch: (request: Request) => Promise<Response>;
}

/**
 * Return a jurisdiction-restricted view of `namespace`, or `namespace`
 * unchanged when no jurisdiction is configured.
 *
 * Fail-closed: if a jurisdiction is requested but the binding does not expose
 * `.jurisdiction()` (an older workers-types, or a misconfigured test double),
 * this throws rather than silently routing to the un-pinned global namespace —
 * silently dropping a residency constraint would let data land outside the
 * compliance boundary the caller asked for.
 */
export const applyJurisdiction = (namespace: ShardNamespaceLike, jurisdiction?: DurableObjectJurisdiction): ShardNamespaceLike => {
    if (jurisdiction === undefined) {
        return namespace;
    }

    if (typeof namespace.jurisdiction !== "function") {
        throw new TypeError(
            `@lunora/runtime: Durable Object namespace does not support jurisdiction("${jurisdiction}") — update @cloudflare/workers-types or remove the jurisdiction option`,
        );
    }

    return namespace.jurisdiction(jurisdiction);
};

/**
 * Look up a shard stub by name through the `@lunora/platform` `ShardDirectory`
 * contract. Preserves the historical preference — `getByName` when present,
 * else `idFromName` + `get` — but the preference now lives in one place (the
 * contract's `resolveShard`) rather than being restated per resolution path.
 */
export const resolveShard = (namespace: ShardNamespaceLike, shardKey: string): ResolvedShard => resolveShardStub(toDirectory(namespace), shardKey);
