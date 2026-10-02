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

import type { Finding } from "./handler";

/**
 * The signals in one `observability` block that sample every request.
 *
 * Logs are on unless the block turns them off; an absent block is what
 * `lunora dev` reconciles to `{ enabled: true, head_sampling_rate: 1 }`, and an
 * absent rate is wrangler's own default of 1. Traces are opt-in
 * (`traces.enabled: true`), and an unset traces rate also means 1.
 */
const fullSamplingSignals = (observability: WranglerObservability | undefined): string[] => {
    const signals: string[] = [];
    const logsEnabled = observability?.logs?.enabled ?? observability?.enabled ?? true;
    const logsRate = observability?.logs?.head_sampling_rate ?? observability?.head_sampling_rate ?? 1;

    if (logsEnabled && logsRate >= 1) {
        signals.push("logs");
    }

    if (observability?.traces?.enabled === true && (observability.traces.head_sampling_rate ?? 1) >= 1) {
        signals.push("traces");
    }

    return signals;
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
