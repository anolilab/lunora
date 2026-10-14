import type { DurableObjectJurisdiction, DurableObjectNamespaceLike } from "./types";

/**
 * Return a jurisdiction-restricted view of `namespace`, or `namespace`
 * unchanged when no jurisdiction is configured.
 *
 * Fail-closed: if a jurisdiction is requested but the binding does not expose
 * `.jurisdiction()`, throw rather than silently routing to the un-pinned global
 * namespace — dropping a residency constraint would let durable timer state
 * land outside the compliance boundary the caller asked for.
 */
const applyJurisdiction = (namespace: DurableObjectNamespaceLike, jurisdiction?: DurableObjectJurisdiction): DurableObjectNamespaceLike => {
    if (jurisdiction === undefined) {
        return namespace;
    }

    if (typeof namespace.jurisdiction !== "function") {
        throw new TypeError(
            `@lunora/scheduler: Durable Object namespace does not support jurisdiction("${jurisdiction}") — update @cloudflare/workers-types or remove the jurisdiction option`,
        );
    }

    return namespace.jurisdiction(jurisdiction);
};

export default applyJurisdiction;
