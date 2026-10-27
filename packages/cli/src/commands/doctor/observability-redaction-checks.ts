/**
 * `lunora doctor`'s query-string redaction check. Wrangler persists the request
 * URL in Workers Logs as received, so an auth link's `?token=` is stored with it
 * unless the block sets `redact_query_string` to true.
 */
import type { WranglerConfig, WranglerObservability } from "@lunora/config/cloudflare";
import { resolveObservabilitySampling } from "@lunora/config/cloudflare";

import type { Finding } from "./handler";

/**
 * Whether an explicit `observability` block persists request URLs with their
 * query strings. Traces keep the URL too, so either signal counts. An absent
 * block is the reconciled default, which redacts, so it is never flagged.
 */
const keepsQueryStrings = (observability: WranglerObservability | undefined): boolean => {
    if (!observability || observability.redact_query_string === true) {
        return false;
    }

    const { logs, traces } = resolveObservabilitySampling(observability);

    return logs.enabled || traces.enabled;
};

/** Which enabled signals persist the request URL, named so a trace-only block is not told its logs leak. */
const leakingSignals = (observability: WranglerObservability | undefined): string => {
    const { logs, traces } = resolveObservabilitySampling(observability);

    return [logs.enabled && "request logs", traces.enabled && "traces"].filter(Boolean).join(" and ");
};

/**
 * WARN (`observability-query-unredacted`) when request logging or tracing is on without
 * `redact_query_string`. Auth links carry their secret in the query (`?token=`),
 * and Workers Logs stores the request URL as received, so each emailed token is
 * persisted. Lunora writes the flag into a new block; an existing block keeps
 * its values, so this names the scopes that still need it.
 */
const checkQueryStringRedaction = (parsed: WranglerConfig | undefined, findings: Finding[]): void => {
    if (parsed === undefined) {
        return;
    }

    const scopes: string[] = [];
    const signals = new Set<string>();

    if (keepsQueryStrings(parsed.observability)) {
        scopes.push("top level");
        signals.add(leakingSignals(parsed.observability));
    }

    for (const [name, environment] of Object.entries(parsed.env ?? {})) {
        if (keepsQueryStrings(environment.observability)) {
            scopes.push(`env.${name}`);
            signals.add(leakingSignals(environment.observability));
        }
    }

    if (scopes.length === 0) {
        return;
    }

    findings.push({
        code: "observability-query-unredacted",
        fix: 'Set "redact_query_string": true in each observability block listed above in wrangler.jsonc. Lunora never changes a value you set.',
        level: "warn",
        message: `${[...signals].join(" / ")} keep query strings (redact_query_string is not true) for ${scopes.join(", ")}. Emailed auth links carry their token in the query, so that token is stored with the request URL.`,
    });
};

export default checkQueryStringRedaction;
