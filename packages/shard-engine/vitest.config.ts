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
     * These numbers are a RATCHET, not a target: they sit under the current
     * measurement so a regression still fails, and every engine unit test added
     * should raise them. Do not lower them.
     *
     * Measured on both CI legs, because they do not agree: Node 22 (which CI runs
     * `test:affected:coverage` on) gives 88.9 stmts / 79.2 branches / 88.0 funcs /
     * 88.9 lines, Node 24 gives 89.0 / 79.5 / 88.1 / 89.0. Part of that gap is not
     * instrumentation noise but real branch selection — `node:sqlite` ships FTS5
     * from 22.23 on, so the older leg takes the LIKE-scan path through ctx-db's
     * search code instead. The floors are pinned ~3pp under the LOWER leg: a floor
     * fitted tightly to the local (Node 24) number reds in CI on the identical
     * commit, which is exactly how PR #408 failed.
     *
     * They are measured against the `node` project alone: CI's coverage leg runs
     * with the workerd gate off, and v8 coverage cannot see into workerd.
     */
    thresholds: { branches: 75, functions: 85, lines: 86, statements: 86 },
};

/**
 * Two-project Vitest config (see `packages/do/vitest.config.ts` for the rationale
 * behind the `LUNORA_WORKERD_TESTS=1` opt-in gate):
 *
 *  - `node`    — every engine suite, over a `node:sqlite`-backed `SqlExec`.
 *                Always on.
 *  - `workerd` — the SQL-heavy scenarios again, over a real SQLite-backed
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
