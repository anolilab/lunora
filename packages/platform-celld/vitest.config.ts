import { getVitestConfig } from "../../tools/get-vitest-config";

/**
 * Lower floors than the repo default, deliberately — same rationale as
 * `platform-cloudflare`'s.
 *
 * This package is a thin recomposition of `@lunora/platform-cloudflare`'s
 * adapters (celld executes Wrangler bundles, so those adapters ARE the celld
 * host); the adapters' own branches are covered in that package's suite, and
 * what remains here is the capability override plus the `localSql` guard.
 * Raise these floors if the package grows celld-specific adapters.
 */
export default getVitestConfig({ test: { environment: "node" } }, { branches: 40, functions: 40, lines: 40, statements: 40 });
