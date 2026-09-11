import { svelte } from "@sveltejs/vite-plugin-svelte";

import { getVitestConfig } from "../../tools/get-vitest-config";

/**
 * One project per framework: the Svelte port needs its own transform, and it
 * cannot share a pipeline with React. `core/` needs no plugin at all (plain
 * TypeScript, no framework import), so it rides along with React.
 *
 * That `core/` compiles with no plugin is the architecture's smoke test: the
 * day it needs one, logic has leaked into a view.
 */
export default getVitestConfig({
    test: {
        coverage: {
            // The core is what the thresholds are about; the ports are thin
            // bindings over it, covered by per-port render tests.
            include: ["src/core/**", "src/react/**"],
        },
        projects: [
            {
                test: {
                    environment: "jsdom",
                    include: ["__tests__/core/**/*.test.ts", "__tests__/react/**/*.test.tsx"],
                    name: "react",
                    setupFiles: ["./__tests__/setup.ts"],
                },
            },
            {
                plugins: [svelte()],
                // Without the browser condition, `svelte` resolves to its SSR
                // build and mounting throws lifecycle_function_unavailable.
                resolve: { conditions: ["browser"] },
                test: {
                    environment: "jsdom",
                    include: ["__tests__/svelte/**/*.test.ts"],
                    name: "svelte",
                    setupFiles: ["./__tests__/svelte/setup.ts"],
                },
            },
        ],
    },
});
