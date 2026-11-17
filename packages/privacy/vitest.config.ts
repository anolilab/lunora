import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * The node suite is the default. The `workerd` project runs the package's own code under the runtime its
 * Worker uses (the archive's ZIP and PDF, and the request lifecycle over the in-memory ports). It is gated
 * by `LUNORA_WORKERD_TESTS=1` like the other packages' workerd projects, because a sandbox may not let
 * workerd open its loopback. `scripts/test-workerd.sh` runs it.
 */
const runWorkerd = process.env.LUNORA_WORKERD_TESTS === "1";

const NODE_EXCLUDE = ["**/node_modules/**", "**/dist/**", "__tests__/workerd/**"];

export default defineConfig({
    test: {
        projects: runWorkerd
            ? [
                  {
                      extends: true,
                      test: {
                          name: "node",
                          environment: "node",
                          include: ["__tests__/**/*.test.ts"],
                          exclude: NODE_EXCLUDE,
                      },
                  },
                  {
                      extends: true,
                      plugins: [
                          cloudflareTest({
                              main: "__tests__/workerd/test-worker.ts",
                              wrangler: { configPath: "./__tests__/workerd/wrangler.jsonc" },
                          }),
                      ],
                      test: {
                          name: "workerd",
                          include: ["__tests__/workerd/**/*.test.ts"],
                          exclude: ["**/node_modules/**", "**/dist/**"],
                      },
                  },
              ]
            : undefined,
        // Only the node-only run excludes the workerd directory. With the workerd project on, a root `exclude` would be
        // merged into that project and leave it with no tests.
        ...(runWorkerd ? {} : { environment: "node", exclude: NODE_EXCLUDE }),
    },
});
