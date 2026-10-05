import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import type { TestProjectInlineConfiguration } from "vitest/config";
import { configDefaults, coverageConfigDefaults, defineConfig } from "vitest/config";

/**
 * Coverage is declared here, and `package.json` carries the matching
 * `test:coverage` script, because without BOTH this app is absent from the
 * repo's coverage gate entirely.
 *
 * CI's Codecov leg runs `vis affected test:coverage`, and vis synthesizes no
 * target for a project that declares no such script — so the largest unit in the
 * repo, holding billing/metering, deploy-key auth, secret encryption and tenant
 * dispatch, contributed nothing to coverage while `codecov.yml`'s non-informational
 * `patch: 75%` gate passed vacuously on every PR that touched only this app. The
 * tests always ran; only the measurement was missing, which is the worse failure
 * because it looks like success.
 *
 * `lunora/_generated` and the vendored shadcn primitives are excluded: neither is
 * hand-written, and including them moves the percentage without moving the risk.
 */

/**
 * The `workerd` project — a real `BoxSessionDO` over a real hibernatable
 * WebSocket (`__tests__/workerd/`) — runs only with `LUNORA_WORKERD_TESTS=1`,
 * the same gate as the packages' workerd projects (`packages/do/vitest.config.ts`
 * has the rationale): coverage cannot run inside workerd, and some sandboxes
 * cannot boot it at all. The node project is the default `pnpm run test`.
 */
const runWorkerd = process.env.LUNORA_WORKERD_TESTS === "1";

const nodeProject: TestProjectInlineConfiguration = {
    extends: true,
    resolve: {
        alias: {
            // `BoxSessionDO` extends the workerd-only `cloudflare:workers` `DurableObject`;
            // under node it is a minimal stub, so the session's logic tests with fakes.
            "cloudflare:workers": fileURLToPath(new URL("__tests__/__stubs__/cloudflare-workers.ts", import.meta.url)),
        },
    },
    test: { environment: "node", exclude: [...configDefaults.exclude, "__tests__/workerd/**"], name: "node" },
};

export default defineConfig({
    test: {
        coverage: {
            ...coverageConfigDefaults,
            exclude: [
                ...(coverageConfigDefaults.exclude ?? []),
                "**/_generated/**",
                "src/components/ui/**",
                "src/routeTree.gen.ts",
                "**/node_modules/**",
                "**/dist/**",
            ],
            include: ["src", "lunora"],
            provider: "v8" as const,
            reporter: ["clover", "cobertura", "lcov", "text"],
        },
        projects: runWorkerd
            ? [
                  nodeProject,
                  {
                      extends: true,
                      plugins: [cloudflareTest({ main: "__tests__/workerd/test-worker.ts", wrangler: { configPath: "./__tests__/workerd/wrangler.jsonc" } })],
                      test: { include: ["__tests__/workerd/**/*.workerd.test.ts"], name: "workerd" },
                  },
              ]
            : [nodeProject],
    },
});
