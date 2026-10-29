import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { coverageConfigDefaults, defineConfig } from "vitest/config";

import { DEFAULT_COVERAGE_THRESHOLDS } from "../../tools/get-vitest-config";

// Mirror of the shared `tools/get-vitest-config` coverage block. The workers pool
// relies on `defineConfig` (not the shared helper, which would break the
// `@cloudflare/vitest-plugin` projects), so coverage is wired inline here.
const coverage = {
    ...coverageConfigDefaults,
    provider: "v8" as const,
    reporter: ["clover", "cobertura", "lcov", "text", "html"],
    include: ["src"],
    exclude: [
        ...(coverageConfigDefaults.exclude ?? []),
        "__fixtures__/**",
        "__bench__/**",
        "scripts/**",
        "src/**/types.ts",
        "e2e",
        "**/node_modules/**",
        "**/dist/**",
    ],
    // The default run is node-only (workerd is opt-in), so the number is complete and
    // the floor is meaningful — same reasoning as `packages/auth/vitest.config.ts`.
    // ratchet: branches below the default floor; raise as coverage improves.
    thresholds: { ...DEFAULT_COVERAGE_THRESHOLDS, branches: 68 },
};

/**
 * Two-project Vitest config (see `packages/do/vitest.config.ts` for the rationale
 * behind the `LUNORA_WORKERD_TESTS=1` opt-in gate):
 *
 *  - `node`    — the unit suites, store tests over the in-memory double. Always on.
 *  - `workerd` — `createDatabasePaymentStore` over a real shard-engine `ctx.db` on
 *                Durable Object SQLite, the storage it ships to. The unique indexes
 *                behind webhook dedupe and usage idempotency, bigint money columns
 *                and keyset paging are only proven there.
 */
const runWorkerd = process.env.LUNORA_WORKERD_TESTS === "1";

const nodeProject = {
    extends: true,
    test: {
        environment: "node",
        exclude: ["__tests__/workerd/**"],
        include: ["src/**/*.test.ts", "__tests__/**/*.test.ts"],
        name: "node",
    },
};

export default defineConfig({
    test: {
        coverage,
        // Flat, not keyed on CI — see `tools/get-vitest-config` for why.
        hookTimeout: 30_000,
        projects: runWorkerd
            ? [
                  nodeProject,
                  {
                      extends: true,
                      plugins: [
                          cloudflareTest({
                              main: "__tests__/workerd/test-worker.ts",
                              wrangler: { configPath: "./__tests__/workerd/wrangler.jsonc" },
                          }),
                      ],
                      test: { include: ["__tests__/workerd/**/*.test.ts"], name: "workerd" },
                  },
              ]
            : [nodeProject],
        testTimeout: 30_000,
    },
});
