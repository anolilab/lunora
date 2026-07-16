import { getVitestConfig } from "../../tools/get-vitest-config";

export default getVitestConfig(
    {
        test: {
            environment: "node",
            include: ["__tests__/**/*.test.ts"],
        },
    },
    // ratchet: measured 2026-07-16 at 0% — the umbrella's re-export test
    // resolves the built `lunorash` dist, so v8 never attributes coverage to
    // `src/`. Needs source-mapped re-export tests (plan 135 unit-coverage gap:
    // 1 test / 22 src) before any real floor can apply.
    { branches: 0, functions: 0, lines: 0, statements: 0 },
);
