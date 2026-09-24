import { configDefaults } from "vitest/config";

import { getVitestConfig } from "../../tools/get-vitest-config";

const CELLD_TESTS = ["__tests__/celld/**/*.test.ts"];

/**
 * `unit` always runs. `celld` — the conformance suites against a live
 * single-node celld (`__tests__/celld/celld-tck.test.ts`) — is gated behind
 * `LUNORA_CELLD_TESTS=1` for the reasons the `workerd` projects are gated: it
 * needs the `celld` binary and unrestricted localhost loopback, neither of
 * which a sandboxed runner has, and it contributes no v8 coverage (the code
 * under test runs inside celld's isolates). Run it with
 * `pnpm run test:celld`, or directly:
 *
 *     LUNORA_CELLD_TESTS=1 pnpm --filter @lunora/platform-celld run test --project celld
 *
 * Lower coverage floors than the repo default, deliberately — same rationale
 * as `platform-cloudflare`'s. This package is a thin recomposition of
 * `@lunora/platform-cloudflare`'s adapters (celld executes Wrangler bundles, so
 * those adapters ARE the celld host); the adapters' own branches are covered in
 * that package's suite, and what remains here is the capability override.
 */
const runCelld = process.env.LUNORA_CELLD_TESTS === "1";

const unit = {
    extends: true,
    test: {
        exclude: [...configDefaults.exclude, ...CELLD_TESTS],
        include: ["__tests__/**/*.test.ts"],
        name: "unit",
    },
};

const celld = {
    extends: true,
    test: {
        // `extends: true` concatenates the root `include`, so the unit files
        // have to be excluded explicitly or this project runs them again.
        exclude: [...configDefaults.exclude, "__tests__/*.test.ts"],
        // Booting celld and bundling the TCK worker takes a few seconds cold.
        hookTimeout: 120_000,
        include: CELLD_TESTS,
        name: "celld",
    },
};

export default getVitestConfig(
    { test: { environment: "node", projects: runCelld ? [unit, celld] : [unit] } },
    { branches: 40, functions: 40, lines: 40, statements: 40 },
);
