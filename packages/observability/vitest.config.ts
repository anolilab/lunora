import { getVitestConfig } from "../../tools/get-vitest-config";

/**
 * ratchet: floors set just under current measurement, to be raised as tests land.
 *
 * These modules came out of `@lunora/do`, which is threshold-free — so they
 * were never held to a floor before, and arrive below the default one. Two are
 * the whole gap: `function-metrics` and `issue-explainer` are exercised only
 * through `ShardDO`, and those suites stayed in `@lunora/do` because they need
 * a Durable Object to drive. Splitting their unit halves out is the work that
 * lifts these numbers; lowering the floor is the honest placeholder until then,
 * not the fix.
 */
export default getVitestConfig({ test: { environment: "node" } }, { branches: 65, functions: 68, lines: 70, statements: 70 });
