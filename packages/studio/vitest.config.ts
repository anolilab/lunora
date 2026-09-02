import { configDefaults } from "vitest/config";

import { getVitestConfig } from "../../tools/get-vitest-config";

// Pure-logic tests: no React render, no browser storage globals. These run
// under plain `node` (fast, no jsdom polyfills) so they stay cheap to run in
// isolation (`test:unit`) — e.g. on the coverage CI leg, where the jsdom
// `component` project is excluded (see the ratchet note at the bottom).
// Verified DOM-free by running each file under
// `--environment node` with no setupFiles — a file belongs here only if it
// neither renders a component nor touches `localStorage`/`sessionStorage`/
// `window`/`document` (three originally-considered files — browser-storage,
// saved-queries, shard-history — throw "X is not defined" under node because
// they touch Storage APIs, so they stay in `component`).
const unitTestFiles = [
    "__tests__/features/advisors/derive-insights.test.ts",
    "__tests__/features/advisors/derive-runtime-advisories.test.ts",
    "__tests__/features/api/openapi/json-highlight.test.ts",
    "__tests__/features/containers/fold-container-instances.test.ts",
    "__tests__/features/data/back-relations.test.ts",
    "__tests__/features/data/column-window.test.ts",
    "__tests__/features/data/global-row-format.test.ts",
    "__tests__/features/data/highlight-segments.test.ts",
    "__tests__/features/database/schema-diff-model.test.ts",
    "__tests__/features/functions/function-signature.test.ts",
    "__tests__/features/kv/kv-fields.test.ts",
    "__tests__/features/logs/log-level-variant.test.ts",
    "__tests__/features/logs/mail-selection.test.ts",
    "__tests__/features/queues/reliability.test.ts",
    "__tests__/features/reports/instrument-format.test.ts",
    "__tests__/features/reports/metrics-aggregate.test.ts",
    "__tests__/features/reports/metrics-format.test.ts",
    "__tests__/features/reports/slo-aggregate.test.ts",
    "__tests__/features/reports/slo-format.test.ts",
    "__tests__/features/schema/layout.test.ts",
    "__tests__/features/traces/trace-geometry.test.ts",
    "__tests__/features/sql/format-sql.test.ts",
    "__tests__/features/sql/sql-autocomplete.test.ts",
    "__tests__/features/sql/sql-diagnostics.test.ts",
    "__tests__/features/sql/sql-tabs.test.ts",
    "__tests__/features/storage/storage-entries.test.ts",
    "__tests__/lib/admin-functions.test.ts",
    "__tests__/lib/data-view-params.test.ts",
    "__tests__/lib/internal.test.ts",
    "__tests__/lib/mask-preview-heuristic.test.ts",
    "__tests__/lib/operation-log.test.ts",
    "__tests__/lib/rest-dispatch.test.ts",
    "__tests__/lib/seed-data.test.ts",
    "__tests__/lib/ws-token-provider.test.ts",
];

export default getVitestConfig(
    {
        test: {
            // Expose afterEach as a global so @testing-library/react registers its
            // automatic post-test cleanup (replaces the old manual cleanup() setup file).
            globals: true,
            // getVitestConfig spreads vitest's `configDefaults` onto this root test
            // config, which sets an explicit root `include` (the default test glob).
            // With `projects` present, an explicit *root* `include` — even that
            // default glob — makes Vitest ignore each project's own `include`
            // override and run every project against every matching file (verified
            // by bisection: without this line, `--project unit` still picks up and
            // executes the jsdom-only `.tsx` specs, crashing on "document is not
            // defined"). Clearing it here makes each project's own `include`
            // below the sole file-selection source.
            include: [],
            projects: [
                {
                    extends: true,
                    test: { name: "unit", environment: "node", include: unitTestFiles },
                },
                {
                    extends: true,
                    test: {
                        name: "component",
                        environment: "jsdom",
                        // Explicit include required: with the root `include: []` above,
                        // an inline project that declares none inherits the EMPTY
                        // selector and silently matches zero files (verified via
                        // `vitest list --project component`). Restore vitest's default
                        // glob here; the `exclude` below carves the unit files out.
                        include: [...configDefaults.include],
                        // React Flow (the schema diagram) needs DOM-measurement APIs jsdom lacks.
                        setupFiles: ["./__tests__/setup-reactflow.ts"],
                        // Rebuild the base exclude list (see tools/get-vitest-config.ts) plus the
                        // unit files above — an inline project's own `exclude` replaces the
                        // extended base's, it does not merge with it.
                        exclude: [...configDefaults.exclude, "__fixtures__/**", ...unitTestFiles],
                    },
                },
            ],
        },
    },
    // ratchet: the jsdom `component` project is deliberately ungated — a full
    // component run under v8 coverage stalls, so `test:coverage` runs
    // `--project unit` only and these floors are the unit project's measured
    // coverage (2026-09-02, rounded down; coverage counts all of `src`, so the
    // component-only files sit at 0%). Raise when unit tests are added; never
    // lower to admit a regression.
    { branches: 11, functions: 8, lines: 12, statements: 12 },
);
