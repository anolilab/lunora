import { createConfig } from "@anolilab/eslint-config";

// Self-contained flat config for @cirrus/scheduler. Each package owns its own
// setup (no shared local preset); rules build on @anolilab/eslint-config.
export default createConfig(
    {
        ignores: [
            "**/dist/**",
            "**/node_modules/**",
            "**/.next/**",
            "**/.source/**",
            "**/_generated/**",
            "**/__fixtures__/**",
            "**/fixtures/**",
            "**/test-results/**",
            "**/coverage/**",
            "**/.wrangler/**",
            "**/.history/**",
            "**/CHANGELOG.md",
            // Code fences inside markdown (e.g. DESIGN.md) are extracted as
            // virtual .ts files that aren't in any tsconfig, so type-aware
            // linting can't parse them — don't lint doc snippets as source.
            "**/*.md/**",
            "**/vitest.config.ts",
            "**/packem.config.ts",
            "**/vite.config.ts",
            "**/wrangler.jsonc",
            "**/package.json",
            "**/tsconfig*.json",
            "**/README.md",
            "**/prettier.config.js",
            "**/eslint.config.js",
        ],
    },
    // Markdown code blocks: don't enforce language tags.
    {
        files: ["**/*.md", "**/*.md/**"],
        rules: {
            "markdown/fenced-code-language": "off",
        },
    },
    // Behavior-breaking autofixers — kept off (not style). sort-objects reorders the
    // keys of JSON.stringify'd wire payloads / canonical objects, changing the bytes on
    // the wire and breaking order-sensitive tests; prefer-expect-type-of rewrites a
    // runtime `expect(typeof x)` into a compile-time `expectTypeOf`, silently dropping
    // the assertion from the runtime count.
    {
        rules: {
            "perfectionist/sort-objects": "off",
            "vitest/prefer-expect-type-of": "off",
        },
    },
);
