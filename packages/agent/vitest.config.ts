import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

import { getVitestConfig } from "../../tools/get-vitest-config";

/**
 * Two-project Vitest config, same shape as `packages/ratelimit/vitest.config.ts`:
 *
 *  - `node`    — the unit suites. Always on, and the default (`getVitestConfig`).
 *  - `workerd` — the component's storage paths over a Durable Object's real SQLite.
 *                Opt-in behind `LUNORA_WORKERD_TESTS=1`, because
 *                `@cloudflare/vitest-plugin` cannot run under coverage instrumentation.
 */
const runWorkerd = process.env.LUNORA_WORKERD_TESTS === "1";

// Mirrors `tools/get-vitest-config`: vis fans many projects out at once, so a small
// timeout fails on contention rather than on a bug.
const TIMEOUTS = { hookTimeout: 30_000, testTimeout: 30_000 };

export default runWorkerd
    ? defineConfig({
          test: {
              projects: [
                  {
                      test: {
                          ...TIMEOUTS,
                          environment: "node",
                          exclude: ["__tests__/workerd/**"],
                          include: ["__tests__/**/*.test.ts"],
                          name: "node",
                      },
                  },
                  {
                      plugins: [
                          cloudflareTest({
                              main: "__tests__/workerd/test-worker.ts",
                              wrangler: { configPath: "./__tests__/workerd/wrangler.jsonc" },
                          }),
                      ],
                      test: { ...TIMEOUTS, include: ["__tests__/workerd/**/*.test.ts"], name: "workerd" },
                  },
              ],
          },
      })
    : // The workerd suites import `cloudflare:test`, which only resolves inside workerd.
      getVitestConfig({ test: { environment: "node", exclude: ["__tests__/workerd/**"] } }, { branches: 80, functions: 88, lines: 88, statements: 88 });
