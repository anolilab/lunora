import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { coverageConfigDefaults, defineConfig } from "vitest/config";

import { DEFAULT_COVERAGE_THRESHOLDS } from "../../tools/get-vitest-config";

// Mirror of the shared `tools/get-vitest-config` coverage block. The workers
// pool relies on `defineConfig` (not the shared helper, which would break the
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
    // Measured well above the default floor (99.27/97.97/100/99.24); the default
    // is already a safe ratchet here.
    thresholds: { ...DEFAULT_COVERAGE_THRESHOLDS },
};

/**
 * Two-project Vitest config (see `packages/do/vitest.config.ts` for the rationale
 * behind the `LUNORA_WORKERD_TESTS=1` opt-in gate):
 *
 *  - `node`    — the unit suites over plain-object page/browser doubles. Always on.
 *  - `workerd` — `createBrowser` in real workerd against the real
 *                `@cloudflare/playwright` peer, with `env.BROWSER` a service
 *                binding to a fake Browser Run that refuses the DevTools upgrade
 *                (there is no Chrome locally). See `__tests__/workerd/`.
 */
const runWorkerd = process.env.LUNORA_WORKERD_TESTS === "1";

const nodeProject = {
    extends: true,
    test: {
        environment: "node",
        exclude: ["__tests__/workerd/**"],
        include: ["__tests__/**/*.test.ts"],
        name: "node",
    },
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
