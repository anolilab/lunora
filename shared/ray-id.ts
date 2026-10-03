/**
 * Shared, bundler-inlined handling of the Cloudflare **Ray ID** — the per-request
 * identifier the edge stamps on every request as the `cf-ray` header, and the key
 * Cloudflare Traces, Workers Logs and Security Events are searched by.
 *
 * `@lunora/runtime` reads it off {@link CF_RAY_HEADER} at the Worker entry, ONCE
 * per request, and forwards it to the shard Durable Object under
 * {@link RAY_ID_HEADER}, alongside `traceparent`; `@lunora/do` reads it back there
 * so shard-side logs and spans carry it too. Both sides parse through
 * {@link parseRayId}, so they agree on what a Ray ID is.
 *
 * The Ray ID is **informational only**: it is a cross-navigation key into
 * Cloudflare's own tooling, never an authorization or routing input. It is
 * absent off the edge (`wrangler dev` / Miniflare does not set it, and no other
 * host does), and every consumer treats absence as the normal case.
 * Keep this file genuinely zero-dependency so inlining stays sound.
 */

/** The header the Cloudflare edge stamps the Ray ID on, on every inbound request. */
export const CF_RAY_HEADER = "cf-ray";

/**
 * The internal header the runtime forwards the parsed Ray ID to the shard on.
 * Lunora-namespaced rather than re-sending `cf-ray`, so the DO reads the value the
 * WORKER parsed — never whatever the platform may stamp on the internal hop.
 */
export const RAY_ID_HEADER = "x-lunora-ray-id";

/**
 * A `cf-ray` value: 16 hex digits, optionally followed by `-` and the serving
 * data center's code (`8f2a1b3c4d5e6f70-FRA`).
 */
const RAY_ID_PATTERN = /^([\da-f]{16})(?:-[a-z]{3,4})?$/i;

/**
 * Parse a `cf-ray` (or forwarded {@link RAY_ID_HEADER}) value into the bare,
 * lowercase 16-hex Ray ID, or `undefined` when absent or malformed.
 *
 * The data-center suffix is dropped: it names a colo, not the request, and the
 * bare id is the form Cloudflare's dashboards search on. Validation is strict
 * because the value is echoed into log lines and span attributes — off the edge
 * the header is whatever the caller typed, and anything that is not a Ray ID is
 * simply not one.
 *
 * Every `rayId` field in Lunora holds this function's output and is
 * **informational only** — the module doc above is the one statement of what
 * that means; other doc comments link here rather than restating it.
 */
export const parseRayId = (header: null | string | undefined): string | undefined => {
    if (header === null || header === undefined) {
        return undefined;
    }

    const match = RAY_ID_PATTERN.exec(header.trim());

    return match?.[1]?.toLowerCase();
};
