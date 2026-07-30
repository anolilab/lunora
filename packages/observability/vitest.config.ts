import { getVitestConfig } from "../../tools/get-vitest-config";

/**
 * Coverage ratchet: floors sit just under the current measurement, so a
 * regression fails while ordinary variance does not.
 *
 * These modules came out of `@lunora/do`, which is threshold-free, so they
 * arrived below any floor. The gap was almost entirely two files —
 * `function-metrics` (593 lines) and `issue-explainer` (300) — which had no
 * suite of their own and were exercised only through `ShardDO`. Both now have
 * one and both measure 100% on all four metrics, which took the package from
 * 70/65/68/70 to 90.09/77.72/85.95/90.10.
 *
 * `branches` remains the laggard: `context-telemetry` (40.81%) is the bulk of
 * it — a structural bridge whose arms only differ under a real host span. Raise
 * these numbers as that lands; do not lower them.
 */
export default getVitestConfig({ test: { environment: "node" } }, { branches: 76, functions: 84, lines: 89, statements: 89 });
