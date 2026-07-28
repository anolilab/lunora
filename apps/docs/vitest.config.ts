import { fileURLToPath } from "node:url";

import { getVitestConfig } from "../../tools/get-vitest-config";

/**
 * Mirrors the `@/*` path alias the app's tsconfig defines.
 *
 * Coverage is scoped to the handful of modules that have tests. The v8 provider
 * parses every *uncovered* file to report it as 0%, and this app's `src/` is
 * mostly `.md`/`.mdx` content and React routes — which rollup cannot parse, so
 * an unscoped run fails the whole job rather than reporting a low number.
 */
export default getVitestConfig({
    resolve: { alias: { "@": fileURLToPath(new URL("src", import.meta.url)) } },
    test: {
        coverage: { include: ["src/lib/docs-slug.ts"] },
        environment: "node",
    },
});
