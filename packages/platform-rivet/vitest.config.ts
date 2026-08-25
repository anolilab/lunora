import { getVitestConfig } from "../../tools/get-vitest-config";

/**
 * Lower floors than the repo default, deliberately — same rationale as
 * `platform-node`'s.
 *
 * This package is a first-cut host: the `@lunora/platform` contracts over Rivet
 * Actors, exercised through the shared conformance TCK against an in-memory
 * Rivet actor double. Most uncovered branches are error paths and
 * host-parity edge cases the TCK reaches indirectly; raise these floors as the
 * host is driven against a real Rivet engine.
 */
export default getVitestConfig({ test: { environment: "node" } }, { branches: 60, functions: 80, lines: 84, statements: 84 });
