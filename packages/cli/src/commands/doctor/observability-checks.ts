/**
 * `lunora doctor`'s observability-cost check. Lunora keeps
 * `observability.head_sampling_rate: 1` as the default it reconciles into
 * wrangler.jsonc — every request logged is the right default while an app is
 * small. Workers Observability becomes a billed product on 2026-12-01, though,
 * so a project that still samples everything gets one advisory explaining what
 * that costs and which knobs lower it.
 *
 * Pricing (https://blog.cloudflare.com/cloudflare-tracing/): Free caps
 * ingestion at 0.5 GB/day; Paid includes 50 GB per billing cycle, then
 * $0.25/GB ingested.
 */
import type { WranglerConfig, WranglerObservability } from "@lunora/config/cloudflare";
import { resolveObservabilitySampling } from "@lunora/config/cloudflare";

import type { Finding } from "./handler";

/**
 * The signals in one `observability` block that sample every request, read
 * through the config layer's sampling resolver — the same defaults (an absent
 * block is the reconciled default, an unset rate is wrangler's 1) that
 * `lunora dev` writes, so the advisory cannot drift from them.
 */
const fullSamplingSignals = (observability: WranglerObservability | undefined): string[] => {
    const { logs, traces } = resolveObservabilitySampling(observability);

    return Object.entries({ logs, traces })
        .filter(([, signal]) => signal.enabled && signal.headSamplingRate >= 1)
        .map(([name]) => name);
};

/**
 * INFO (`observability-full-sampling`) when the top-level config, or any
 * `env.<name>` with its own `observability` block, samples every request for
 * logs or traces — explicitly or through the reconciled default. Advisory only:
 * 1 is still Lunora's default, and for a low-traffic app it is the right one.
 */
const checkObservabilitySampling = (parsed: WranglerConfig | undefined, findings: Finding[]): void => {
    if (parsed === undefined) {
        return;
    }

    const scopes: string[] = [];
    const topLevel = fullSamplingSignals(parsed.observability);

    if (topLevel.length > 0) {
        scopes.push(`${topLevel.join(" + ")} (top level)`);
    }

    for (const [name, environment] of Object.entries(parsed.env ?? {})) {
        // An env without its own block inherits the top level, already counted above.
        if (environment.observability === undefined) {
            continue;
        }

        const signals = fullSamplingSignals(environment.observability);

        if (signals.length > 0) {
            scopes.push(`${signals.join(" + ")} (env.${name})`);
        }
    }

    if (scopes.length === 0) {
        return;
    }

    findings.push({
        code: "observability-full-sampling",
        fix:
            "For a high-traffic Worker, lower head_sampling_rate in wrangler.jsonc: under observability for logs, " +
            "under observability.traces for traces — e.g. 0.1 keeps 10% of requests. Lunora never changes a rate you set.",
        level: "info",
        message:
            `observability samples every request (head_sampling_rate 1) for ${scopes.join(", ")}. ` +
            "From 2026-12-01 Workers Observability is billed: Free caps ingestion at 0.5 GB/day; " +
            "Paid includes 50 GB per billing cycle, then $0.25/GB.",
    });
};

export default checkObservabilitySampling;
