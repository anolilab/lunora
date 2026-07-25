import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Two projects, mirroring `@lunora/do`:
 *
 *  - `unit`    — plain-Node tests of the composition logic. Always enabled.
 *  - `workerd` — the conformance TCK against the composed platform in real
 *                workerd, with a live `SchedulerDO`.
 *
 * The workerd project is gated on `LUNORA_WORKERD_TESTS=1` because the
 * pool-workers integration needs unrestricted localhost-loopback between
 * workerd and the test host, which sandboxed CI blocks. On a workstation:
 *
 *     LUNORA_WORKERD_TESTS=1 pnpm --filter @lunora/platform-cloudflare test
 */
const runWorkerd = process.env.LUNORA_WORKERD_TESTS === "1";

const unit = { extends: true, test: { environment: "node" as const, include: ["__tests__/*.test.ts"], name: "unit" } };

export default defineConfig({
    test: {
        projects: runWorkerd
            ? [
                  unit,
                  {
                      extends: true,
                      plugins: [cloudflareTest({ main: "__tests__/workerd/test-worker.ts", wrangler: { configPath: "./__tests__/workerd/wrangler.jsonc" } })],
                      test: { include: ["__tests__/workerd/**/*.test.ts"], name: "workerd" },
                  },
              ]
            : [unit],
    },
});
