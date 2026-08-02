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
 *
 * Memoized per namespace: bindings are long-lived (one per worker, or one per
 * jurisdiction view of one), while `resolveShard` runs on the per-request
 * routing path. Building a fresh object and three closures on every resolution
 * to describe an object that never changes is pure allocation churn. Keyed
 * weakly so a discarded namespace — a one-off jurisdiction view — does not
 * outlive its binding.
 */
const directoryCache = new WeakMap<ShardNamespaceLike, ShardDirectory>();

/**
 * Read whichever id-derivation spelling the namespace supplies.
 *
 * Throws rather than returning the name unchanged when neither exists: a
 * namespace with no `getByName` and no way to derive an id cannot resolve a
 * shard at all, and silently substituting the raw name would route every key to
 * whatever object that string happens to address.
 */
const derivedIdForName = (namespace: ShardNamespaceLike, name: string): unknown => {
    const derive = namespace.idFromName ?? namespace.idForName;

    if (typeof derive !== "function") {
        throw new TypeError("@lunora/runtime: shard namespace exposes neither idFromName nor idForName, so a shard key cannot be resolved");
    }

    return derive.call(namespace, name);
};

const toDirectory = (namespace: ShardNamespaceLike): ShardDirectory => {
    const cached = directoryCache.get(namespace);

    if (cached !== undefined) {
        return cached;
    }

    const jurisdiction =
        typeof namespace.jurisdiction === "function"
            ? (hint: ShardJurisdiction) =>
                  toDirectory((namespace.jurisdiction as NonNullable<ShardNamespaceLike["jurisdiction"]>)(hint as DurableObjectJurisdiction))
            : undefined;

    const directory: ShardDirectory =
        typeof namespace.getByName === "function"
            ? {
                  // Mirrors the namespace: a name-only registry has no `get` to
                  // offer, and the direct branch never needs one.
                  get: namespace.get === undefined ? undefined : (id) => (namespace.get as NonNullable<ShardNamespaceLike["get"]>)(id),
                  // Wrapped, NOT passed by reference: `DurableObjectNamespace`'s
                  // methods are native and require their own receiver, so handing
                  // the bare function to the contract calls it with the directory
                  // as `this` and workerd rejects it with "Illegal invocation".
                  // Plain-object test doubles tolerate the detached reference,
                  // which is why only the workerd suites caught this.
                  getByName: (name) => (namespace.getByName as NonNullable<ShardNamespaceLike["getByName"]>)(name),
                  idForName: (name) => derivedIdForName(namespace, name),
                  jurisdiction,
              }
            : {
                  // The two-step branch is the only path with no name lookup to
                  // fall back on, so a namespace reaching here without `get`
                  // cannot resolve anything — fail loudly rather than at the
                  // first `undefined is not a function` inside a fan-out leg.
                  get: (id) => {
                      if (namespace.get === undefined) {
                          throw new TypeError("@lunora/runtime: shard namespace exposes neither getByName nor get, so a shard key cannot be resolved");
                      }

                      return namespace.get(id);
                  },
                  idForName: (name) => derivedIdForName(namespace, name),
                  jurisdiction,
              };

    directoryCache.set(namespace, directory);

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
    /**
     * Materialize a stub from an opaque id.
     *
     * Optional for the same reason it is optional on `DirectShardDirectory`: a
     * provider whose registry only understands names has no id to materialize
     * from, and implements `getByName` alone. Required in practice only on the
     * two-step branch below, which is the one that has no other way in.
     */
    get?: (id: unknown) => { fetch: (request: Request) => Promise<Response> };

    /**
     * `getByName` is the friendlier API but isn't on every workers-types
     * release yet. We prefer it when available and fall back to
     * `idFromName` + `get` for compatibility.
     */
    getByName?: (name: string) => { fetch: (request: Request) => Promise<Response> };

    /**
     * The `@lunora/platform` spelling of {@link ShardNamespaceLike.idFromName}.
     *
     * Present so a non-Cloudflare host can hand its own `ShardDirectory`
     * straight to the runtime. Before this, the only difference between the two
     * shapes was the method name, and that one letter made every fan-out entry
     * point (`QueryCoordinator.fanOut`, the `orchestrate*` family) reject a
     * conforming directory — a porting blocker discovered by construction when
     * `@lunora/platform-node` tried to fan out. Exactly one of the two must be
     * present; `idFromName` wins when both are.
     */
    idForName?: (name: string) => unknown;

    /** Cloudflare's `DurableObjectNamespace` spelling. See {@link ShardNamespaceLike.idForName}. */
    idFromName?: (name: string) => unknown;

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
