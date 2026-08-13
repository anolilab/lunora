import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

/**
 * The Solid 2.0 half of `@lunora/solid`'s dual-major guard.
 *
 * `packages/solid` develops and tests against Solid 1.x (its own devDependency),
 * so nothing there can catch a 2.0 regression — a stray `import { on } from
 * "solid-js"` links fine under 1.x and hard-fails for every 2.x consumer. This
 * package installs Solid 2.0 as its ONLY Solid and imports `@lunora/solid` by
 * package name, so the suite exercises the exact bundle that ships to npm.
 *
 * `dedupe` pins the Solid specifiers to THIS package's root. It is insurance,
 * not a fix for a live bug: `@lunora/solid` is a workspace symlink sitting next
 * to its own Solid 1.x devDependency, and deduping removes any chance that a
 * future pnpm/Vite layout change resolves the adapter's bare `solid-js` there
 * and quietly re-tests 1.x. `adapter.test.tsx` asserts the major the adapter
 * actually linked against, so that failure mode is caught either way.
 */
export default defineConfig({
    plugins: [solid()],
    resolve: {
        conditions: ["development", "browser"],
        dedupe: ["@solidjs/signals", "@solidjs/web", "solid-js"],
    },
    test: {
        environment: "jsdom",
        include: ["__tests__/**/*.test.tsx"],
        setupFiles: ["./__tests__/setup.ts"],
    },
});
