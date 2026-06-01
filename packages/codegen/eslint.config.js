import { createConfig } from "@anolilab/eslint-config";

// Self-contained flat config for @cirrus/codegen. Each package owns its own
// setup (no shared local preset); rules build on @anolilab/eslint-config.
export default createConfig(
    {
        // Enable type-aware linting and let @anolilab read the tsconfig. This gates
        // correct behaviour: type-aware rules (no-unsafe-*, no-unnecessary-condition,
        // require-await) only run with real type info, and for React packages the
        // tsconfig's `jsx: "react-jsx"` flips the preset to the automatic runtime
        // (react-in-jsx-scope off). Without tsconfigPath both silently misfire.
        typescript: { tsconfigPath: "tsconfig.json" },
        // Prettier owns formatting; disable @stylistic to avoid the two-formatter ping-pong.
        stylistic: false,
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
    // Scoped framework / Web-platform allowances (NOT blanket rule-off):
    {
        rules: {
            // Web platform globals present in the workerd + browser deploy runtimes (and
            // modern Node); eslint-plugin-n's Node-version data flags them conservatively.
            "n/no-unsupported-features/node-builtins": [
                "error",
                { ignores: ["crypto", "CryptoKey", "SubtleCrypto", "Storage", "sessionStorage", "localStorage"] },
            ],
            // Leading-underscore identifiers that are framework API by design: _id /
            // _creationTime are the public document fields; __cirrus* are internal markers;
            // _meta/__doc__ are data-model internals; __name is a bundler helper. Accidental
            // dangles (and the trailing-underscore variety) are still flagged.
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
                        "__cirrusRef",
                        "__cirrusVisibility",
                        "__cirrusProcedure",
                        "__cirrusCtx",
                        "__cirrusTable",
                        "__cirrusPreloaded",
                    ],
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
            "no-confusing-arrow": "off",
            "unicorn/number-literal-case": "off",
        },
    },
    // Test files: relax rules that are noisy or inappropriate in test code (loose
    // mocks/typing, inline regex, null fixtures, async helpers without await, toEqual,
    // describe titles). Source files still enforce all of these.
    {
        files: ["**/__tests__/**/*.{ts,tsx}", "**/__bench__/**/*.{ts,tsx}", "**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}", "**/*.bench.{ts,tsx}"],
        rules: {
            "@stylistic/no-tabs": "off",
            "max-classes-per-file": "off",
            "@typescript-eslint/no-empty-object-type": "off",
            "unicorn/no-object-as-default-parameter": "off",
            "no-confusing-arrow": "off",
            "sonarjs/no-nested-conditional": "off",
            "no-underscore-dangle": "off",
            "unused-imports/no-unused-vars": "off",
            "no-await-in-loop": "off",
            "import/prefer-default-export": "off",
            "@typescript-eslint/unbound-method": "off",
            "@typescript-eslint/naming-convention": "off",
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-floating-promises": "off",
            "@typescript-eslint/no-non-null-assertion": "off",
            "@typescript-eslint/no-unnecessary-condition": "off",
            "@typescript-eslint/no-unsafe-argument": "off",
            "@typescript-eslint/no-unsafe-assignment": "off",
            "@typescript-eslint/no-unsafe-call": "off",
            "@typescript-eslint/no-unsafe-member-access": "off",
            "@typescript-eslint/no-unsafe-return": "off",
            "@typescript-eslint/no-use-before-define": "off",
            "@typescript-eslint/require-await": "off",
            "e18e/prefer-static-regex": "off",
            "import/exports-last": "off",
            "import/no-extraneous-dependencies": "off",
            "n/no-unsupported-features/node-builtins": "off",
            "no-void": "off",
            "promise/always-return": "off",
            "sonarjs/deprecation": "off",
            "sonarjs/no-control-regex": "off",
            "sonarjs/no-nested-functions": "off",
            "unicorn/no-null": "off",
            "unicorn/prevent-abbreviations": "off",
            "vitest/no-conditional-expect": "off",
            "vitest/prefer-describe-function-title": "off",
            "vitest/prefer-strict-equal": "off",
        },
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
