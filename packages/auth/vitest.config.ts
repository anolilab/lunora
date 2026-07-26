import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { coverageConfigDefaults, defineConfig } from "vitest/config";

// Mirror of the shared `tools/get-vitest-config` coverage block. The workers pool
// relies on `defineConfig` (not the shared helper, which would break the
// `@cloudflare/vitest-pool-workers` projects), so coverage is wired inline here.
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
};

/**
 * Two-project Vitest config (see `packages/do/vitest.config.ts` for the rationale
 * behind the `LUNORA_WORKERD_TESTS=1` opt-in gate):
 *
 *  - `node`    — the unit suites over the better-auth wrapper (adapter, audit,
 *                email guard, plugin surface). Always on.
 *  - `workerd` — real workerd via `@cloudflare/vitest-pool-workers`, proving the
 *                enterprise-auth plugins load in the runtime they ship to:
 *                `@better-auth/sso` statically imports `samlify` +
 *                `node:crypto`'s `X509Certificate`, so a Node-only pass says
 *                nothing about whether an app can actually deploy it.
 */
const runWorkerd = process.env.LUNORA_WORKERD_TESTS === "1";

const nodeProject = {
    extends: true,
    test: { environment: "node", include: ["src/**/*.test.ts", "__tests__/*.test.ts"], name: "node" },
};

export default defineConfig({
    test: {
        coverage,
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
    },
});
