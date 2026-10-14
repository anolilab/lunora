import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Examples ship no coverage ratchet. These tests run the example's real schema
// and procedures on the in-memory harness, so they fail when the example itself
// stops working — not just when a helper regresses.
//
// The `workerd` project runs the same request lifecycle over a real Durable Object's
// SQLite (see `__tests__/workerd/`). `node:sqlite` builds with `SQLITE_DQS=0` and workerd
// does not, so only that run covers the SQL the ports issue. It is gated the way the
// packages' workerd projects are (see `packages/do/vitest.config.ts`).
const runWorkerd = process.env.LUNORA_WORKERD_TESTS === "1";

// vis fans many projects out at once, so a small timeout fails on contention, not on a bug.
const TIMEOUTS = { hookTimeout: 30_000, testTimeout: 30_000 };

const nodeProject = {
    extends: true,
    test: {
        // The workerd suite imports `cloudflare:test`, which only resolves inside workerd.
        environment: "node",
        exclude: ["**/node_modules/**", "**/dist/**", "__tests__/workerd/**"],
        include: ["__tests__/**/*.test.ts"],
        env: { PRIVACY_TOMBSTONE_SECRET: "example-test-secret" },
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
                              main: "__tests__/workerd/test-worker.ts",
                              wrangler: { configPath: "./__tests__/workerd/wrangler.jsonc" },
                          }),
                      ],
                      test: { ...TIMEOUTS, include: ["__tests__/workerd/**/*.test.ts"], name: "workerd" },
                  },
              ]
            : [nodeProject],
    },
});
