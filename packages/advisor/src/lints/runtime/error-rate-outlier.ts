import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * A function must be called at least this many times (cumulatively over the
 * observed window) before an error-rate advisory fires. A handful of calls
 * makes any error rate untrustworthy (1 error in 3 calls is not "33% of
 * traffic fails"); mirrors `hot_shard`'s `MIN_TOTAL_REQUESTS` floor for the
 * same reason.
 *
 * PROTOTYPE THRESHOLD — not tuned against real traffic. See
 * `plans/248-runtime-lints-design.md` for the open threshold-model question
 * (absolute vs. baseline-relative, sustained-over-window) before productizing.
 */
const MIN_CALLS = 20;

/**
 * A function's error rate must clear this share of its calls before it counts
 * as an outlier. Deliberately high (1 in 10) so the lint only fires on a
 * function that is genuinely failing, not one with occasional expected 4xx-
 * shaped throws.
 *
 * PROTOTYPE THRESHOLD — see the module doc on {@link MIN_CALLS}.
 */
const ERROR_RATE_THRESHOLD = 0.1;

/**
 * `error_rate_outlier` — flag a function whose observed error rate is high
 * enough to be a genuine reliability signal, not noise.
 *
 * PROTOTYPE (plan 248): the read side of the runtime-lint category is thin (3
 * lints, all traffic/conflict/index shaped) next to the static category's 96.
 * `lunora insights` already collects and ranks this exact signal
 * (`errorHotspots`) for a human report; this lint closes the loop by feeding
 * the same per-function `errors`/`calls` counts into the `lunora advisor` gate
 * so a CI run can flag a genuinely failing function, not just a report a human
 * has to remember to read.
 *
 * The per-function volume comes from the runtime feeder (`context.
 * functionMetrics`): the studio backend reads `__lunora_admin__:getFunctionStats`
 * for the shard in scope — the SAME rows `context.tableScans` already draws
 * `scannedTables` from, just projecting `errors`/`calls` instead. See
 * `AdvisorFunctionMetrics` for the scope caveat (one shard, not fanned out
 * cross-shard like `context.shardTraffic`) and `plans/248-runtime-lints-design.md`
 * for the reachability finding and open questions this prototype does not
 * resolve (threshold model, single- vs. cross-shard scope, whether this ships
 * as its own lint or merges with a future latency counterpart).
 */
const errorRateOutlier: Lint = {
    categories: ["PERFORMANCE"],
    description:
        "A function's observed error rate has cleared a threshold high enough to be a genuine reliability signal — the same errorHotspots signal `lunora insights` reports, now gated in `lunora advisor`.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "error_rate_outlier",
    remediation:
        "Read the function's `lastErrorMessage` / traces to find the failing dependency or input shape, then fix or guard it; `lunora insights` ranks every function by error rate for the same window.",
    run: (context) => {
        const findings = [];

        for (const stat of context.functionMetrics ?? []) {
            if (stat.calls < MIN_CALLS) {
                continue;
            }

            const rate = stat.errors / stat.calls;

            if (rate < ERROR_RATE_THRESHOLD) {
                continue;
            }

            const percent = Math.round(rate * 100);

            findings.push(
                emit(errorRateOutlier, {
                    cacheKey: `error_rate_outlier:${stat.path}`,
                    detail: `"${stat.path}" errored on ${stat.errors.toString()} of ${stat.calls.toString()} calls (${percent.toString()}%) over the observed window.`,
                    metadata: { calls: stat.calls, errors: stat.errors, path: stat.path, rate },
                }),
            );
        }

        return findings;
    },
    source: "runtime",
    title: "Error-rate outlier",
};

export default errorRateOutlier;
