import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Two-project Vitest config (matches @cirrus/scheduler / @cirrus/client):
 *
 *  - `mocks`   — fast unit suite over in-memory R2 fakes, plain Node, always on.
 *  - `workerd` — Phase 6 verification gate. Spins up workerd with a real R2
 *               binding via Miniflare's emulator. Gated by `CIRRUS_WORKERD_TESTS=1`
 *               because the pool needs unrestricted localhost-loopback between
 *               workerd and the test host — sandboxed CI blocks that. Locally:
 *
 *                   CIRRUS_WORKERD_TESTS=1 pnpm --filter @cirrus/storage test
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
