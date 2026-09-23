import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { coverageConfigDefaults, defineConfig } from "vitest/config";

// Mirror of the shared `tools/get-vitest-config` coverage block. The workers pool
// relies on `defineConfig` (not the shared helper, which would break the
// `@cloudflare/vitest-plugin` projects), so coverage is wired inline here.
const coverage = {
    ...coverageConfigDefaults,
    provider: "v8" as const,
    reporter: ["clover", "cobertura", "lcov", "text", "html"],
    include: ["src"],
    exclude: [
        ...(coverageConfigDefaults.exclude ?? []),
        "__fixtures__/**",
        "__bench__/**",
        "scripts/**",
        "src/**/types.ts",
        "e2e",
        "**/node_modules/**",
        "**/dist/**",
    ],
    // ratchet: below the shared default floor; raise as coverage improves. Carried
    // over verbatim from the `getVitestConfig` call this config replaced, and
    // meaningful for the same reason auth's is: the default run here is node-only
    // (workerd is opt-in), so the number is not structurally incomplete.
    thresholds: { branches: 48, functions: 70, lines: 65, statements: 65 },
};

/**
 * Two-project Vitest config (see `packages/do/vitest.config.ts` for the rationale
 * behind the `LUNORA_WORKERD_TESTS=1` opt-in gate):
 *
 *  - `node`    — the store core's unit suites. It is dialect-parameterized logic
 *                over an injected `SqlExec`, so most of it is testable against
 *                plain-object doubles and a `node:sqlite`-backed exec. Always on.
 *  - `workerd` — real workerd over a real D1 binding, for the part that is not.
 *                `node:sqlite` builds with `SQLITE_DQS=0` while workerd and D1
 *                build the double-quoted-string misfeature in, so a provisioning
 *                guard that gates on a statement *failing* behaves differently on
 *                the two engines — and the Node one is not the engine this
 *                package ships to. See
 *                `__tests__/workerd/global-table-drift.workerd.test.ts`.
 */
const runWorkerd = process.env.LUNORA_WORKERD_TESTS === "1";

// Mirrors `tools/get-vitest-config`: vis fans many projects out at once and CI runs
// coverage-instrumented, so a small timeout fails on contention rather than on a bug.
const TIMEOUTS = { hookTimeout: 30_000, testTimeout: 30_000 };

const nodeProject = {
    extends: true,
    test: {
        ...TIMEOUTS,
        environment: "node",
        // `__tests__/**` rather than `__tests__/*`, minus the workerd project's own
        // directory — its files end in `.test.ts` like every other, and would
        // otherwise be run in the wrong runtime (where they do not fail, they pass
        // vacuously).
        exclude: ["__tests__/workerd/**"],
        include: ["src/**/*.test.ts", "__tests__/**/*.test.ts"],
        name: "node",
    },
};

export default defineConfig({
    test: {
        coverage,
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
