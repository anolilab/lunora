import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Two-project Vitest config (see `packages/do/vitest.config.ts` for the
 * rationale behind the `LUNORA_WORKERD_TESTS=1` opt-in gate):
 *
 *  - `mocks`   — Node unit suite. `@cloudflare/containers` imports the
 *                workerd-only `cloudflare:workers` module at module scope, so
 *                this project aliases it to a minimal stub to keep the
 *                `LunoraContainer` base class testable in plain Node. The alias
 *                lives on this project only — the workerd project must resolve
 *                the real runtime module.
 *  - `workerd` — real workerd via `@cloudflare/vitest-pool-workers`: boots the
 *                generated-style Container DO up to the no-container-runtime
 *                guard, drives the `ctx.containers` surface over a real DO
 *                namespace, and round-trips the container→Lunora bridge client
 *                (see `__tests__/workerd/`).
 */
const runWorkerd = process.env.LUNORA_WORKERD_TESTS === "1";

const mocksProject = {
    extends: true,
    resolve: {
        alias: {
            // `@cloudflare/containers` imports the workerd-only `cloudflare:workers`
            // module at module scope; alias it to a minimal stub so the
            // `LunoraContainer` base class is testable in plain Node.
            "cloudflare:workers": fileURLToPath(new URL("__tests__/__stubs__/cloudflare-workers.ts", import.meta.url)),
        },
    },
    test: { name: "mocks", environment: "node", include: ["__tests__/*.test.ts"] },
} as const;

export default defineConfig({
    test: {
        projects: runWorkerd
            ? [
                  mocksProject,
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
            : [mocksProject],
    },
});
