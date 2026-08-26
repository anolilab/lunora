/// <reference types="vitest" />
import { cpus } from "node:os";

import type { ViteUserConfig } from "vitest/config";
import { configDefaults, coverageConfigDefaults, defineConfig } from "vitest/config";

const VITEST_SEQUENCE_SEED = Date.now();

/**
 * Worker cap per vitest instance, so concurrent instances do not oversubscribe
 * the machine between them.
 *
 * Vitest defaults to roughly one worker per core. That is right for ONE instance
 * and wrong for how this repo runs its suite: `vis` starts several package tasks
 * at a time, so on a 10-core machine five instances each claimed ~9 workers —
 * about 45 processes competing for 10 cores.
 *
 * That 4.5x oversubscription is what produced this repo's "flaky" tests. They
 * were not flaky. A `findByTestId` that resolves instantly in isolation missed a
 * 1s budget by 3-6 seconds, and a CLI test was reported at 10,063 ms against a
 * 10,000 ms limit — the signature of starvation, not of a race. Capping the
 * workers made three consecutive full-suite runs clean AND cut wall time from
 * ~290-380s to ~190-250s: the contention was costing more than it bought.
 *
 * Keyed on `VIS_TASK_SLOTS`, which vis sets in every task it spawns to declare
 * how many it runs at once. Reading it rather than mirroring `vis.config.ts`
 * means the two cannot drift, and a STANDALONE run
 * (`pnpm --filter <pkg> run test`) sees no variable and keeps vitest's default —
 * which matters, because the cap makes a single-package run about twice as slow
 * and that is the inner dev loop.
 */
const visTaskSlots = Number.parseInt(process.env["VIS_TASK_SLOTS"] ?? "", 10);
const MAX_WORKERS = Number.isFinite(visTaskSlots) && visTaskSlots > 1 ? Math.max(1, Math.floor((cpus().length || visTaskSlots) / visTaskSlots)) : undefined;

export interface CoverageThresholds {
    branches?: number;
    functions?: number;
    lines?: number;
    statements?: number;
}

/**
 * Default coverage floor for every package on the shared config. Packages that
 * sit below it get an explicit lower override at their call site (with a
 * `// ratchet:` comment) and raise it over time instead of blocking.
 *
 * Thresholds only apply when coverage is enabled (`vitest run --coverage`, the
 * `test:coverage` scripts); plain `vitest run` is unaffected. The workerd-gated
 * packages (client, container, d1, dispatch, do, queue, runtime, scheduler,
 * storage, workflow, x402) use inline `defineConfig` configs — not this
 * helper — because their `workerd` project runs without coverage (v8/
 * `node:inspector` is unsupported in `@cloudflare/vitest-plugin`), so a
 * floor keyed to THIS default would gate on a structurally incomplete number.
 * That does not make every workerd-gated package threshold-free: a package
 * whose non-workers project has stable, measured coverage may still pin its
 * own floor inline — `client`'s `vitest.config.ts` does exactly this for its
 * `mocks` project, with numbers measured against that project alone (see its
 * file-level comment). The exemption is "don't inherit this default", not
 * "no threshold anywhere"; a package that moves off this helper for any
 * other reason needs its own justification, not this comment.
 */
export const DEFAULT_COVERAGE_THRESHOLDS: Required<CoverageThresholds> = {
    branches: 70,
    functions: 80,
    lines: 80,
    statements: 80,
};

// https://vitejs.dev/config/
export const getVitestConfig = (options: ViteUserConfig = {}, coverageThresholds: CoverageThresholds = {}) => {
    console.log("VITEST_SEQUENCE_SEED", VITEST_SEQUENCE_SEED);

    return defineConfig({
        ...options,
        test: {
            ...configDefaults,
            coverage: {
                ...coverageConfigDefaults,
                provider: "v8",
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
                thresholds: {
                    ...DEFAULT_COVERAGE_THRESHOLDS,
                    ...coverageThresholds,
                },
            },
            environment: "node",
            hideSkippedTests: true,
            // vis runs many projects concurrently; under that contention (v8
            // instrumentation + oversubscribed cores) a test that finishes in
            // well under a second can blow past a small timeout and fail
            // spuriously.
            //
            // NOT keyed on CI, which is the mistake this replaces. `pnpm run test`
            // fans 108 tasks across a developer's machine — one already running an
            // editor, a browser and whatever else — while CI gets a dedicated
            // runner doing nothing else. Local is the MORE contended environment,
            // and it was the one given the shorter fuse: the flakes this caused
            // were reported at 10,063 ms against a 10,000 ms local limit.
            //
            // A timeout only bounds how long a PASSING assertion is willing to
            // wait, so raising it costs nothing when the suite is healthy. The
            // only price is that a genuinely hung test takes longer to say so,
            // which is a far better trade than a false failure that costs a
            // three-minute re-run of the whole suite.
            testTimeout: 30_000,
            hookTimeout: 30_000,
            // See MAX_WORKERS: the timeouts above are the backstop, this is the
            // fix. Without it five concurrent vitest instances each spawn a
            // worker per core and starve each other.
            ...(MAX_WORKERS === undefined ? {} : { maxWorkers: MAX_WORKERS }),
            reporters: process.env.CI
                ? process.env.CI_PREFLIGHT
                    ? ["dot", "github-actions"]
                    : ["dot"]
                : ["default"],
            sequence: {
                seed: VITEST_SEQUENCE_SEED,
                // `seed` is inert without `shuffle` — Vitest only consumes the seed when it
                // is randomizing. File-level only: within-file order is legitimately
                // load-bearing in some suites.
                ...(process.env.LUNORA_SHUFFLE === "1" ? { shuffle: { files: true, tests: false } } : {}),
            },
            silent: process.env.CI ? "passed-only" : false,
            typecheck: {
                enabled: false,
            },
            ...options.test,
            exclude: [...configDefaults.exclude, "__fixtures__/**", ...(options.test?.exclude ?? [])],
        },
    });
};
