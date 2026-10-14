import { getVitestConfig } from "../../tools/get-vitest-config";

export default getVitestConfig(
    {
        test: {
            environment: "node",
            include: ["__tests__/**/*.test.ts"],
        },
    },
    // ratchet: the Nuxt module body (`@nuxt/kit` wiring) only runs inside a Nuxt
    // build, so it sits below the default floor; raise as coverage improves.
    { branches: 50, functions: 40, lines: 40, statements: 40 },
);
