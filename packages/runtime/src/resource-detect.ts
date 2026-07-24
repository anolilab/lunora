/**
 * Per-request OTLP resource detection for the worker.
 *
 * The runtime — not the sink — owns this, for two reasons.
 *
 * **Blast radius.** Detection needs the Worker's `env` (secret bindings, KV
 * namespaces, everything) and the raw `Request` (its `Authorization` and `Cookie`
 * headers). Handing those to `ObservabilitySink` would hand them to *every*
 * registered sink, including third-party and user-authored ones, where a single
 * `console.error("[sink]", event, context)` while debugging dumps the lot.
 * Resolving here means the sink boundary only ever sees the narrow, allowlisted
 * bag below — a handful of known `service.*` / `cloud.*` keys.
 *
 * **Cost.** `env` and `request` are fixed for a request, so detection is a
 * per-request constant. Resolving it in the sink meant re-running the probes on
 * every log line, metric, and span on the hot dispatch path. The resolver here is
 * lazy (nothing runs unless a sink asks) and memoized (it runs at most once per
 * request), so a deployment with no OTLP sink pays nothing at all.
 */
import type { OtlpResourceAttributes } from "../../../shared/otlp";
import { detectCloudflareResource, detectServiceResource, mergeResourceAttributes, readerFromRecord } from "../../../shared/otlp-resource";

/**
 * Resolves this request's detected resource attributes on demand. Returns the
 * same bag on every call.
 */
type ResourceAttributeResolver = () => OtlpResourceAttributes;

/**
 * Build the lazy, memoized resolver for one request.
 *
 * Only the detectors a Worker can actually satisfy are composed: service
 * identity (from env vars) and Cloudflare placement (from `request.cf`). The
 * host/process detectors are deliberately absent — `HOSTNAME`, `KUBERNETES_*` and
 * a pid do not exist in workerd, so probing for them here would be dead branches
 * copied from the container exporter. `@lunora/container` composes those instead.
 * @param environment The Worker's `env` bindings bag, when available.
 * @param request The inbound request, used only for its `cf` placement metadata.
 */
const createResourceAttributeResolver = (environment: unknown, request?: Request): ResourceAttributeResolver => {
    let resolved: OtlpResourceAttributes | undefined;

    return () => {
        if (resolved === undefined) {
            const read = readerFromRecord(environment as Record<string, unknown> | undefined);
            // `cf` is Cloudflare's per-request placement bag; absent off-Cloudflare
            // and on synthetic requests, which the detector treats as "not Cloudflare".
            const cf = request === undefined ? undefined : (request as { cf?: unknown }).cf;

            resolved = mergeResourceAttributes(detectServiceResource(read), detectCloudflareResource(read, cf));
        }

        return resolved;
    };
};

export type { ResourceAttributeResolver };
export { createResourceAttributeResolver };
