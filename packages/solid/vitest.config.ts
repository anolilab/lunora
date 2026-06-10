import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

// `vite-plugin-solid` compiles Solid's JSX + reactive transform so the render
// tests (`@solidjs/testing-library`) exercise real components. `conditions`
// resolves the `solid` export of `solid-js`, matching how a Solid app builds.
export default defineConfig({
    plugins: [solid()],
    resolve: {
        conditions: ["development", "browser"],
    },
    test: {
        environment: "jsdom",
        setupFiles: ["./__tests__/setup.ts"],
    },
});
