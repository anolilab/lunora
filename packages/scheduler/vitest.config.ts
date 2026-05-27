import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

/**
 * See `packages/do/vitest.config.ts` for the rationale behind the
 * `CIRRUS_WORKERD_TESTS=1` opt-in gate.
 */
const runWorkerd = process.env.CIRRUS_WORKERD_TESTS === "1";

export default defineConfig({
    test: {
        projects: runWorkerd
            ? [
                  {
                      extends: true,
                      test: { name: "mocks", environment: "node", include: ["__tests__/*.test.ts"] },
                  },
                  {
                      extends: true,
                      plugins: [
                          cloudflareTest({
                              main: "__tests__/workerd/test-worker.ts",
                              wrangler: { configPath: "./__tests__/workerd/wrangler.jsonc" },
                          }),
                      ],
                      test: { name: "workerd", include: ["__tests__/workerd/**/*.test.ts"] },
                  },
              ]
            : [
                  {
                      extends: true,
                      test: { name: "mocks", environment: "node", include: ["__tests__/*.test.ts"] },
                  },
              ],
    },
});
