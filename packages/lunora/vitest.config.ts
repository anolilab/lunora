import { getVitestConfig } from "../../tools/get-vitest-config";

export default getVitestConfig(
    {
        test: {
            environment: "node",
            include: ["__tests__/**/*.test.ts"],
        },
    },
    // ratchet: the umbrella's re-export tests resolve the built `lunorash` dist,
    // so v8 attributes no coverage to `src/`. Zeroed until source-mapped
    // re-export tests exist.
    { branches: 0, functions: 0, lines: 0, statements: 0 },
);
