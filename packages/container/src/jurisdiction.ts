/**
 * Cloudflare Durable Object data-residency jurisdiction. Widening union —
 * Cloudflare adds values over time.
 * @see https://developers.cloudflare.com/durable-objects/reference/data-location/
 * @experimental
 */
type DurableObjectJurisdiction = "eu" | "fedramp" | "us";

/**
 * Return a jurisdiction-restricted view of `namespace`, or `namespace`
 * unchanged when no jurisdiction is configured. Fail-closed when the binding
 * lacks `.jurisdiction()` so a residency constraint is never silently dropped.
 *
 * Generic over the namespace shape so both the `ctx.containers` client
 * (`ContainerNamespaceLike`) and the lifecycle reporter (`ShardNamespaceLike`)
 * share one implementation — the only requirement is an optional
 * `.jurisdiction()` that returns the same namespace type.
 */
const applyJurisdiction = <N extends { jurisdiction?: (jurisdiction: DurableObjectJurisdiction) => N }>(
    namespace: N,
    jurisdiction?: DurableObjectJurisdiction,
): N => {
    if (jurisdiction === undefined) {
        return namespace;
    }

    if (typeof namespace.jurisdiction !== "function") {
        throw new TypeError(
            `@lunora/container: Durable Object namespace does not support jurisdiction("${jurisdiction}") — update @cloudflare/workers-types or remove the jurisdiction option`,
        );
    }

    return namespace.jurisdiction(jurisdiction);
};

export type { DurableObjectJurisdiction };
export { applyJurisdiction };
