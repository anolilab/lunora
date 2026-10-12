import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

import { getVitestConfig } from "../../tools/get-vitest-config";

/**
 * Two-project Vitest config, same shape as `packages/sql-store/vitest.config.ts`:
 *
 *  - `node`    — the unit suites. Always on, and the default (`getVitestConfig`).
 *  - `workerd` — real workerd over a Durable Object with `ctx.storage`, for the
 *                consume path. The DO is the only place where the storage awaits
 *                that the database store depends on are real. Opt-in behind
 *                `LUNORA_WORKERD_TESTS=1`, because `@cloudflare/vitest-plugin`
 *                cannot run under the coverage instrumentation.
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
                          include: ["src/**/*.test.ts", "__tests__/**/*.test.ts"],
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
      getVitestConfig({ test: { environment: "node", exclude: ["__tests__/workerd/**"] } });
