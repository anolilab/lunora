import { createConfig } from "@anolilab/eslint-config";

// Self-contained flat config for @lunora/platform-celld. Each package owns its own
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
            "**/vitest.bench.config.ts",
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
    // One composition module with two named factory exports, matching the repo
    // convention and CLAUDE.md's no-mixed-default rule.
    {
        rules: {
            "import/prefer-default-export": "off",
        },
    },
    // Test files: relax rules that are noisy or inappropriate in test code (loose
    // mocks/typing, inline regex, null fixtures, async helpers without await, toEqual,
    // describe titles). Source files still enforce all of these.
    {
        files: ["**/__tests__/**/*.{ts,tsx}", "**/__bench__/**/*.{ts,tsx}", "**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}", "**/*.bench.{ts,tsx}"],
        rules: {
            "@typescript-eslint/naming-convention": "off",
            "@typescript-eslint/no-empty-object-type": "off",
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-non-null-assertion": "off",
            "@typescript-eslint/no-unnecessary-condition": "off",
            "@typescript-eslint/no-unsafe-argument": "off",
            "@typescript-eslint/no-unsafe-assignment": "off",
            "@typescript-eslint/no-unsafe-call": "off",
            "@typescript-eslint/no-unsafe-member-access": "off",
            "@typescript-eslint/no-unsafe-return": "off",
            "@typescript-eslint/require-await": "off",
            "e18e/prefer-static-regex": "off",
            "import/no-extraneous-dependencies": "off",
            "max-classes-per-file": "off",
            "n/no-unsupported-features/node-builtins": "off",
            "sonarjs/deprecation": "off",
            "sonarjs/no-control-regex": "off",
            "unicorn/no-null": "off",
            "unicorn/prevent-abbreviations": "off",
            "unused-imports/no-unused-vars": "off",
            "vitest/prefer-describe-function-title": "off",
            "vitest/prefer-strict-equal": "off",
        },
    },
    // Markdown code blocks: don't enforce language tags.
    // The `n` Node-builtins rules reach into the scope manager, which a markdown
    // document has none of — under ESLint 10 they throw "Cannot read properties
    // of undefined (globalScope)" while LOADING the rule, so a single committed
    // .md file crashes the whole lint run instead of reporting findings. They're
    // meaningless on prose either way, so turn them off for markdown.
    {
        files: ["**/*.md", "**/*.md/**"],
        rules: {
            "markdown/fenced-code-language": "off",
            "n/no-unsupported-features/es-builtins": "off",
            "n/no-unsupported-features/es-syntax": "off",
            "n/no-unsupported-features/node-builtins": "off",
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
