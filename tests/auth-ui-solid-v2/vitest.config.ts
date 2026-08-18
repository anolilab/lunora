import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

/**
 * Render tests for `@lunora/auth-ui`'s Solid 2 port.
 *
 * The port itself is authored in `packages/auth-ui/src/solid-v2` beside the four
 * other ports, and type-checked there by `tsconfig.solid-v2.json` (which remaps
 * `solid-js` onto the aliased 2.x install). Its RUNTIME tests live here instead,
 * because that remap does not survive into a test run: `@solidjs/testing-library`
 * and `@solidjs/web` resolve their own bare `solid-js` import through Node, which
 * lands on the 1.x copy sitting next to them in `packages/auth-ui/node_modules`
 * and fails at import with "does not provide an export named createOwner".
 *
 * A package whose ONLY Solid is 2.x has no such ambiguity — same reasoning, and
 * the same shape, as `tests/solid-v2-adapter`. The suites import the port by
 * relative path; `@lunora/auth-ui` is never built or published.
 */
export default defineConfig({
    plugins: [solid()],
    resolve: {
        conditions: ["development", "browser"],
    },
    test: {
        environment: "jsdom",
        include: ["__tests__/**/*.test.tsx"],
        setupFiles: ["./__tests__/setup.ts"],
    },
});
