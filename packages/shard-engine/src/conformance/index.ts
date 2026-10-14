/**
 * `@lunora/shard-engine/conformance` — the engine contract suite.
 *
 * Asserts what the reactive engine guarantees when it runs on any host that
 * satisfies `@lunora/platform`'s contracts. Separate from
 * `@lunora/platform/conformance`, which asserts the host primitives themselves;
 * a host is proven when it passes both. See `./suite` for why the split is
 * forced rather than chosen.
 */
export type { EngineHostFactory, EngineVitestApi } from "./suite";
export { defineEngineContractSuite } from "./suite";
