import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Examples ship no coverage ratchet. These tests run the example's real schema
// and procedures on the in-memory harness, so they fail when the example itself
// stops working — not just when a helper regresses.
//
// The `workerd` project boots the app's real Worker (`src/server/index.ts`) and its
// real `ShardDO` in workerd, so the membership gates are checked against a live shard
// rather than the harness, which re-runs every subscription on each mutation. It is
// gated the way privacy's workerd project is (see `examples/privacy/vitest.config.ts`).
const runWorkerd = process.env.LUNORA_WORKERD_TESTS === "1";

// vis fans many projects out at once, so a small timeout fails on contention, not on a bug.
const TIMEOUTS = { hookTimeout: 30_000, testTimeout: 30_000 };

const nodeProject = {
    test: {
        environment: "node",
        exclude: ["**/node_modules/**", "**/dist/**", "__tests__/workerd/**"],
        include: ["__tests__/**/*.test.ts"],
        name: "node",
    },
};

export default defineConfig({
    test: {
        projects: runWorkerd
            ? [
                  nodeProject,
                  {
                      extends: true,
                      plugins: [
                          cloudflareTest({
                              main: "src/server/index.ts",
                              wrangler: { configPath: "./__tests__/workerd/wrangler.jsonc" },
                          }),
                      ],
                      test: { ...TIMEOUTS, include: ["__tests__/workerd/**/*.test.ts"], name: "workerd" },
                  },
              ]
            : [nodeProject],
    },
});
