import solid from "vite-plugin-solid";

import { getVitestConfig } from "../../tools/get-vitest-config";

// `vite-plugin-solid` compiles Solid's JSX + reactive transform so the render
// tests (`@solidjs/testing-library`) exercise real components. `conditions`
// resolves the `solid` export of `solid-js`, matching how a Solid app builds.
export default getVitestConfig(
    {
        plugins: [solid()],
        resolve: {
            conditions: ["development", "browser"],
        },
        test: {
            environment: "jsdom",
            setupFiles: ["./__tests__/setup.ts"],
        },
    },
    // ratchet: below the default floor; raise as coverage improves.
    { branches: 60, lines: 78, statements: 78 },
);
