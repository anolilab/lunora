import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

/**
 * Two-project Vitest config:
 *
 *  - `mocks`   — legacy mock-state suite. Runs in plain Node, no Miniflare.
 *               Always enabled.
 *  - `workerd` — real workerd + Miniflare suite via `@cloudflare/vitest-pool-workers`.
 *               Boots `__tests__/workerd/test-worker.ts` against the wrangler
 *               config in `__tests__/workerd/wrangler.jsonc`. Exercises the
 *               WebSocket Hibernation API, real `state.acceptWebSocket()`,
 *               `serializeAttachment` round-trip, and SQLite-in-DO storage.
 *
 *               Gated by `CIRRUS_WORKERD_TESTS=1` because the pool-workers
 *               integration requires unrestricted localhost-loopback access
 *               between workerd and the test host. Sandboxed CI environments
 *               (including the harness this PR was authored in) block that
 *               connection and the runtime can't boot. On a developer
 *               workstation set the env variable to run the suite:
 *
 *                   CIRRUS_WORKERD_TESTS=1 pnpm --filter @cirrus/do test
 */
const runWorkerd = process.env.CIRRUS_WORKERD_TESTS === "1";

export default defineConfig({
    test: {
        projects: runWorkerd
            ? [
                  {
                      extends: true,
                      test: {
                          name: "mocks",
                          environment: "node",
                          include: ["__tests__/*.test.ts"],
                      },
                  },
                  {
                      extends: true,
                      plugins: [
                          cloudflareTest({
                              main: "__tests__/workerd/test-worker.ts",
                              wrangler: {
                                  configPath: "./__tests__/workerd/wrangler.jsonc",
                              },
                          }),
                      ],
                      test: {
                          name: "workerd",
                          include: ["__tests__/workerd/**/*.test.ts"],
                      },
                  },
              ]
            : [
                  {
                      extends: true,
                      test: {
                          name: "mocks",
                          environment: "node",
                          include: ["__tests__/*.test.ts"],
                      },
                  },
              ],
    },
});
