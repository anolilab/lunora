import { createConfig } from "@anolilab/eslint-config";

// Self-contained flat config for @lunora/replica. Each package owns its own
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
            "**/vitest.bench.config.ts",
            "**/packem.config.ts",
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
            // `for` loop afterthoughts are the idiomatic place for `++`; the rule still
            // catches `++` used as an expression elsewhere.
            "no-plusplus": ["error", { allowForLoopAfterthoughts: true }],
            // Prettier formats `async *` with a space before `*`; the core rule wants the
            // opposite. Prettier owns formatting, so disable the conflicting stylistic rule.
            "generator-star-spacing": "off",
            // Leading-underscore identifiers that are framework API by design: _id /
            // _creationTime are the public document fields; __lunora* are internal markers.
            // `_types` is the public type-map key on `defineEvents` results.
            "no-underscore-dangle": [
                "error",
                {
                    allow: ["_id", "_creationTime", "_meta", "_types", "__lunoraRef"],
                },
            ],
            // Library modules intentionally expose named exports so the public API stays
            // uniform (`import { EventEmitter } from "..."`). `import/prefer-default-export`
            // would force every single-export source file to switch to a default export,
            // which conflicts with the no-mixed-default-named convention and the re-export
            // style used in `src/index.ts`.
            "import/prefer-default-export": "off",
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
    // mocks/typing, inline regex, null fixtures, async helpers without await, toEqual,
    // describe titles). Source files still enforce all of these.
    {
        files: ["**/__tests__/**/*.{ts,tsx}", "**/__bench__/**/*.{ts,tsx}", "**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}", "**/*.bench.{ts,tsx}"],
        rules: {
            "@typescript-eslint/naming-convention": "off",
            "@typescript-eslint/no-base-to-string": "off",
            "@typescript-eslint/no-empty-object-type": "off",
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-non-null-assertion": "off",
            "@typescript-eslint/no-unnecessary-condition": "off",
            "@typescript-eslint/no-unnecessary-type-conversion": "off",
            "@typescript-eslint/no-unsafe-argument": "off",
            "@typescript-eslint/no-unsafe-assignment": "off",
            "@typescript-eslint/no-unsafe-call": "off",
            "@typescript-eslint/no-unsafe-member-access": "off",
            "@typescript-eslint/no-unsafe-return": "off",
            "@typescript-eslint/require-await": "off",
            "@typescript-eslint/restrict-template-expressions": "off",
            "arrow-body-style": "off",
            "e18e/prefer-static-regex": "off",
            "import/no-extraneous-dependencies": "off",
            "jsdoc/check-param-names": "off",
            "jsdoc/informative-docs": "off",
            "jsdoc/no-undefined-types": "off",
            "max-classes-per-file": "off",
            "n/no-unsupported-features/node-builtins": "off",
            "no-await-in-loop": "off",
            "no-new": "off",
            "no-plusplus": "off",
            "no-promise-executor-return": "off",
            "no-underscore-dangle": "off",
            "promise/param-names": "off",
            "regexp/no-super-linear-backtracking": "off",
            "regexp/no-unused-capturing-group": "off",
            "sonarjs/assertions-in-tests": "off",
            "sonarjs/cognitive-complexity": "off",
            "sonarjs/constructor-for-side-effects": "off",
            "sonarjs/deprecation": "off",
            "sonarjs/no-alphabetical-sort": "off",
            "sonarjs/no-control-regex": "off",
            "sonarjs/no-misleading-array-reverse": "off",
            "sonarjs/no-nested-assignment": "off",
            "sonarjs/prefer-regexp-exec": "off",
            "sonarjs/slow-regex": "off",
            "unicorn/no-array-sort": "off",
            "unicorn/no-null": "off",
            "unicorn/prefer-event-target": "off",
            "unicorn/prevent-abbreviations": "off",
            "unused-imports/no-unused-vars": "off",
            "vitest/expect-expect": "off",
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
    // keys of canonical/wire objects, changing bytes on the wire and breaking
    // order-sensitive tests.
    {
        rules: {
            "perfectionist/sort-objects": "off",
        },
    },
);
