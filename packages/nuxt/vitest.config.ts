import { getVitestConfig } from "../../tools/get-vitest-config";

export default getVitestConfig(
    {
        test: {
            environment: "node",
            include: ["__tests__/**/*.test.ts"],
        },
    },
    // ratchet: measured 2026-07-16 at 46.8% lines / 44.44% funcs / 55.26%
    // branches — the Nuxt module body (`@nuxt/kit` wiring) only runs inside a
    // Nuxt build. Raise toward the 80/80/80/70 default floor.
    { branches: 50, functions: 40, lines: 40, statements: 40 },
);
