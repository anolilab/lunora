/**
 * Cloudflare's documented bounds for a custom container instance type
 * (https://developers.cloudflare.com/containers/platform-details/limits/):
 * 1–4 vCPU, up to 12 GiB memory, up to 20 GB disk at any memory size, and at
 * least 3 GiB memory per vCPU. Below 1 vCPU, Cloudflare points at the named
 * `lite` / `basic` instance types instead.
 *
 * The one copy of these numbers. `defineContainer` checks a `durable_object`
 * container's runtime size against it, and `@lunora/config`'s wrangler validator
 * checks `containers[].instance_type` against it (config already depends on this
 * package, so the import runs one way). Pure data, Node-safe.
 */

/** Inclusive bounds for one dimension of a custom instance type. */
interface InstanceDimensionLimits {
    readonly max: number;
    readonly min: number;
}

/** Per-dimension bounds, keyed by the `CustomContainerInstanceType` field names. */
const CUSTOM_INSTANCE_TYPE_LIMITS: Readonly<{ diskMb: InstanceDimensionLimits; memoryMib: InstanceDimensionLimits; vcpu: InstanceDimensionLimits }> =
    Object.freeze({
        diskMb: Object.freeze({ max: 20_000, min: 1 }),
        memoryMib: Object.freeze({ max: 12_288, min: 1 }),
        vcpu: Object.freeze({ max: 4, min: 1 }),
    });

/** The memory floor per vCPU: 3 GiB. */
const CUSTOM_INSTANCE_MIN_MEMORY_MIB_PER_VCPU = 3072;

export type { InstanceDimensionLimits };
export { CUSTOM_INSTANCE_MIN_MEMORY_MIB_PER_VCPU, CUSTOM_INSTANCE_TYPE_LIMITS };
