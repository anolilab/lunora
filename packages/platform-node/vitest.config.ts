import { getVitestConfig } from "../../tools/get-vitest-config";

/**
 * Lower floors than the repo default, deliberately — same rationale as
 * `platform-cloudflare`'s.
 *
 * This package is a spike (plan 234): a Node host over `better-sqlite3` plus
 * an in-process socket/directory/scheduler registry, built to run the
 * existing `@lunora/platform/conformance` TCK and discover contract gaps by
 * construction. Most branches are error paths and host-parity edge cases the
 * TCK exercises indirectly; raise these floors as the host hardens past spike
 * stage.
 */
export default getVitestConfig({ test: { environment: "node" } }, { branches: 60, functions: 80, lines: 84, statements: 84 });
