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
    // ratchet: measured 2026-07-16 at 80.4% lines / 80.29% stmts / 62.24%
    // branches — too little headroom over the 80/80 default; raise toward the
    // 80/80/80/70 default floor.
    { branches: 60, lines: 78, statements: 78 },
);
