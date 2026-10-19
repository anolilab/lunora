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
        "src/module.d.ts",
        "src/reset.d.ts",
        "e2e",
        "**/node_modules/**",
        "**/dist/**",
    ],
    /**
     * Coverage ratchet: floors sit just under the current measurement, so a
     * regression fails while ordinary variance does not.
     *
     * These modules came out of `@lunora/do`, which is threshold-free, so they
     * arrived below any floor. The gap was almost entirely two files —
     * `function-metrics` (593 lines) and `issue-explainer` (300) — which had no
     * suite of their own and were exercised only through `ShardDO`. Both now have
     * one and both measure 100% on all four metrics, which took the package from
     * 70/65/68/70 to 90.09/77.72/85.95/90.10.
     *
     * `branches` remains the laggard: `context-telemetry` (40.81%) is the bulk of
     * it — a structural bridge whose arms only differ under a real host span. Raise
     * these numbers as that lands; do not lower them.
     *
     * They are measured against the `node` project alone: CI's coverage leg runs
     * with the workerd gate off, and v8 coverage cannot see into workerd.
     */
    thresholds: { branches: 76, functions: 84, lines: 89, statements: 89 },
};

/**
 * Two-project Vitest config (see `packages/do/vitest.config.ts` for the rationale
 * behind the `LUNORA_WORKERD_TESTS=1` opt-in gate):
 *
 *  - `node`    — every suite, the SQL ones over a `node:sqlite`-backed `SqlExec`.
 *                Always on.
 *  - `workerd` — the SQL scenarios again, over a real SQLite-backed
 *                Durable Object's `state.storage.sql`. `node:sqlite` builds with
 *                `SQLITE_DQS=0` while workerd builds the double-quoted-string
 *                misfeature in, so a bare double-quoted name that resolves to
 *                nothing raises on Node and reads as a string literal in
 *                production. The scenarios live in `__tests__/_scenarios/` and
 *                both projects run them.
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
        // otherwise be run in the wrong runtime.
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
