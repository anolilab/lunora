import type { ShardDirectory, ShardJurisdiction } from "@lunora/platform";
import { resolveShard as resolveShardStub } from "@lunora/platform";

/**
 * The Cloudflare-binding members {@link toDirectory} reads.
 *
 * Only the optional two: a `ShardDirectory` returns early, so everything past
 * that point is a binding, where `get` and `idFromName` are required.
 */
type ShardNamespaceParts = {
    getByName?: (name: string) => { fetch: (request: Request) => Promise<Response> };
    jurisdiction?: (jurisdiction: DurableObjectJurisdiction) => ShardNamespaceLike;
};

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
 *
 * Memoized per namespace: bindings are long-lived (one per worker, or one per
 * jurisdiction view of one), while `resolveShard` runs on the per-request
 * routing path. Building a fresh object and three closures on every resolution
 * to describe an object that never changes is pure allocation churn. Keyed
 * weakly so a discarded namespace — a one-off jurisdiction view — does not
 * outlive its binding.
 */
const directoryCache = new WeakMap<object, ShardDirectory>();

/**
 * Read whichever id-derivation spelling the namespace supplies.
 *
 * Throws rather than returning the name unchanged when neither exists: a
 * namespace with no `getByName` and no way to derive an id cannot resolve a
 * shard at all, and silently substituting the raw name would route every key to
 * whatever object that string happens to address.
 */

/**
 * `idFromName` is the one member only a Cloudflare binding has — the contract
 * spells it `idForName` — so it is what separates the two arms of the input
 * union. Narrowed on the *binding*, not the directory, because
 * `DirectShardDirectory` declares `idForName` optionally and an `in` check
 * cannot exclude it.
 */
const isCloudflareBinding = (input: ShardNamespaceInput): input is ShardNamespaceLike => typeof (input as ShardNamespaceLike).idFromName === "function";

const toDirectory = (input: ShardNamespaceInput): ShardDirectory => {
    // A `ShardDirectory` is already the contract — adapting it would allocate a
    // fresh object and three closures to re-derive `idForName` from `idForName`.
    // Returning it also means everything below is a Cloudflare binding, where
    // `get` and `idFromName` are required, which is what removes the cast and
    // the all-optional projection this function used to need.
    if (!isCloudflareBinding(input)) {
        return input;
    }

    const namespace = input;
    const cached = directoryCache.get(input);

    if (cached !== undefined) {
        return cached;
    }

    const jurisdiction =
        typeof namespace.jurisdiction === "function"
            ? (hint: ShardJurisdiction) =>
                  toDirectory((namespace.jurisdiction as NonNullable<ShardNamespaceParts["jurisdiction"]>)(hint as DurableObjectJurisdiction))
            : undefined;

    const directory: ShardDirectory =
        typeof namespace.getByName === "function"
            ? {
                  get: (id) => namespace.get(id),
                  // Wrapped, NOT passed by reference: `DurableObjectNamespace`'s
                  // methods are native and require their own receiver, so handing
                  // the bare function to the contract calls it with the directory
                  // as `this` and workerd rejects it with "Illegal invocation".
                  // Plain-object test doubles tolerate the detached reference,
                  // which is why only the workerd suites caught this.
                  getByName: (name) => (namespace.getByName as NonNullable<ShardNamespaceParts["getByName"]>)(name),
                  idForName: (name) => namespace.idFromName(name),
                  jurisdiction,
              }
            : {
                  get: (id) => namespace.get(id),
                  idForName: (name) => namespace.idFromName(name),
                  jurisdiction,
              };

    directoryCache.set(input, directory);

    return directory;
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
    /** Materialize a stub from an opaque id. */
    get: (id: unknown) => { fetch: (request: Request) => Promise<Response> };

    /**
     * `getByName` is the friendlier API but isn't on every workers-types
     * release yet. We prefer it when available and fall back to
     * `idFromName` + `get` for compatibility.
     */
    getByName?: (name: string) => { fetch: (request: Request) => Promise<Response> };

    /** Cloudflare's `DurableObjectNamespace` spelling of `idForName`. */
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

/**
 * What a fan-out entry point accepts: a Cloudflare binding **or** a
 * `@lunora/platform` `ShardDirectory`.
 *
 * The two shapes differ by one method name — the contract spells `idFromName`
 * as `idForName` — and that one letter made every entry point
 * (`QueryCoordinator.fanOut`, the `orchestrate*` family) reject a fully
 * conforming directory. A porting blocker, found by construction the first time
 * `@lunora/platform-node` fanned out.
 *
 * It is a **union, not a loosened `ShardNamespaceLike`**. Making `get` and
 * `idFromName` optional on that interface fixed fan-out and broke everything
 * else: it is the projection of a real `DurableObjectNamespace`, so ~74 call
 * sites and every app's `env.SHARD` inherited two members that were suddenly
 * `possibly undefined`. Widening the input is what was wanted; widening the
 * binding type was collateral.
 */
export type ShardNamespaceInput = ShardDirectory | ShardNamespaceLike;

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
export const resolveShard = (namespace: ShardNamespaceInput, shardKey: string): ResolvedShard => resolveShardStub(toDirectory(namespace), shardKey);
