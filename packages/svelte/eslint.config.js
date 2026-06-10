import { createConfig } from "@anolilab/eslint-config";

// Self-contained flat config for @cirrus/svelte. Each package owns its own
// setup (no shared local preset); rules build on @anolilab/eslint-config.
export default createConfig(
    {
        // Enable type-aware linting and let @anolilab read the tsconfig. Type-aware
        // rules (no-unsafe-*, no-unnecessary-condition, require-await) only run with
        // real type info; without tsconfigPath they silently misfire.
        typescript: { tsconfigPath: "tsconfig.json" },
        // Prettier owns formatting; disable @stylistic to avoid the two-formatter ping-pong.
        stylistic: false,
        ignores: [
            "**/dist/**",
            "**/node_modules/**",
            "**/_generated/**",
            "**/__fixtures__/**",
            "**/fixtures/**",
            "**/coverage/**",
            "**/*.md/**",
            "**/vitest.config.ts",
            "**/packem.config.ts",
            "**/package.json",
            "**/tsconfig*.json",
            "**/README.md",
            "**/prettier.config.js",
            "**/eslint.config.js",
        ],
    },
    // Scoped allowances (NOT blanket rule-off):
    {
        rules: {
            // Leading-underscore identifiers that are framework API by design:
            // __cirrus* are internal markers carried on function references and the
            // preloaded token. Accidental dangles (and the trailing-underscore
            // variety) are still flagged.
            "no-underscore-dangle": [
                "error",
                {
                    allow: ["_id", "_creationTime", "__cirrusRef", "__cirrusPreloaded"],
                },
            ],
        },
    },
    // Formatting rules that conflict with Prettier (which owns formatting). Like
    // @stylistic (off via `stylistic: false`), satisfying these fights Prettier:
    // no-confusing-arrow wants parens Prettier strips; consistent-chaining owns method-
    // chain line breaks; number-literal-case wants uppercase hex digits Prettier lowercases.
    {
        rules: {
            "antfu/consistent-chaining": "off",
            "antfu/consistent-list-newline": "off",
            "no-confusing-arrow": "off",
            "unicorn/number-literal-case": "off",
        },
    },
    // Test files: relax rules that are noisy or inappropriate in test code (loose
    // mocks/typing, null fixtures, async helpers without await). Source files still
    // enforce all of these.
    {
        files: ["**/__tests__/**/*.{ts,tsx}", "**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
        rules: {
            "@typescript-eslint/naming-convention": "off",
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-non-null-assertion": "off",
            "@typescript-eslint/no-unnecessary-condition": "off",
            "@typescript-eslint/require-await": "off",
            "import/no-extraneous-dependencies": "off",
            "unicorn/no-null": "off",
            "unicorn/prevent-abbreviations": "off",
            "vitest/prefer-expect-assertions": "off",
        },
    },
    // Behavior-breaking autofixers — kept off (not style). sort-objects reorders the
    // keys of canonical/wire objects, changing bytes on the wire and breaking
    // order-sensitive tests.
    {
        rules: {
            "perfectionist/sort-objects": "off",
        },
    },
);
