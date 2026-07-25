import vue from "@vitejs/plugin-vue";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import solid from "vite-plugin-solid";

import { getVitestConfig } from "../../tools/get-vitest-config";

/**
 * One project per framework: each dialect needs its own transform, and they
 * cannot share a pipeline — `vite-plugin-solid` rewrites every `.tsx` with
 * Solid's JSX factory, which would break the React tests running beside it.
 * Splitting by directory keeps each plugin scoped to the port it compiles.
 *
 * `core/` needs no plugin at all (plain TS), so it rides along with React.
 */
export default getVitestConfig(
    {
        test: {
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
                    plugins: [vue()],
                    test: {
                        environment: "jsdom",
                        include: ["__tests__/vue/**/*.test.ts"],
                        name: "vue",
                        setupFiles: ["./__tests__/vue/setup.ts"],
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
                {
                    plugins: [solid()],
                    // Matches how a Solid app builds (resolves solid-js's `solid` export).
                    resolve: { conditions: ["development", "browser"] },
                    test: {
                        environment: "jsdom",
                        include: ["__tests__/solid/**/*.test.tsx"],
                        name: "solid",
                        setupFiles: ["./__tests__/solid/setup.ts"],
                    },
                },
                {
                    // No Angular build plugin, and so no component rendering: the cards
                    // use signal inputs, which only the AOT compiler can see, and
                    // pulling in @angular/build for that would land the Angular CLI
                    // toolchain in every install here. These tests cover the port's DI
                    // and signal bridge instead — see the file header.
                    test: {
                        environment: "jsdom",
                        include: ["__tests__/angular/**/*.test.ts"],
                        name: "angular",
                        setupFiles: ["./__tests__/angular/setup.ts"],
                    },
                },
            ],
        },
    },
    // ratchet: framework-agnostic controllers are heavily covered; raise as the
    // per-port component tests fill in.
    { branches: 60 },
);
