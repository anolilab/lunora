import { createConfig } from "@anolilab/eslint-config";

// Self-contained flat config for this package. Each package owns its own setup
// (no shared local preset); rules build on @anolilab/eslint-config.
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
            "**/vitest.bench.config.ts",
            "**/packem.config.ts",
            "**/package.json",
            "**/tsconfig*.json",
            "**/README.md",
            "**/prettier.config.js",
            "**/eslint.config.js",
        ],
    },
    // Scoped framework allowances (NOT blanket rule-off):
    {
        rules: {
            // Leading-underscore identifiers that are framework API by design: _id /
            // _creationTime are the public document fields; __lunora* are internal markers;
            // _meta/__doc__ are data-model internals; __name is a bundler helper. Accidental
            // dangles (and the trailing-underscore variety) are still flagged.
            //
            // Without this the package needed a file-level `eslint-disable
            // no-underscore-dangle` in five files, which blinded each of them to a
            // genuinely accidental dangle too.
            "no-underscore-dangle": [
                "error",
                {
                    allow: [
                        "_id",
                        "_creationTime",
                        "_meta",
                        "_parse",
                        "_count",
                        "_checks",
                        "_chunk",
                        "__doc__",
                        "__name",
                        "__lunoraRef",
                        "__lunoraVisibility",
                        "__lunoraProcedure",
                        "__lunoraCtx",
                        "__lunoraTable",
                        "__lunoraPreloaded",
                    ],
                },
            ],
        },
    },
    // Test files: relax rules that are noisy or inappropriate in test code. Source
    // files still enforce all of these.
    {
        files: ["**/__tests__/**/*.{ts,tsx}", "**/__bench__/**/*.{ts,tsx}", "**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}", "**/*.bench.{ts,tsx}"],
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
    // `jsdoc/text-escaping` escapes `<` and `&` in doc comments into HTML entities and
    // offers no way to exempt code spans, so its autofix turns `Doc<T>` into `Doc&lt;T>` —
    // which is then what every reader sees on hover. Last in the list so it applies to
    // every file, including the scoped blocks above.
    {
        rules: {
            "jsdoc/text-escaping": "off",
        },
    },
);
