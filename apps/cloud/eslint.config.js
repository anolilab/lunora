import { createConfig } from "@anolilab/eslint-config";

// Self-contained flat config for @cirrus/cloud (backend-only control plane).
// Builds on @anolilab/eslint-config; Prettier owns formatting.
export default createConfig(
    {
        typescript: { tsconfigPath: "tsconfig.json" },
        stylistic: false,
        ignores: [
            "**/dist/**",
            "**/node_modules/**",
            "**/_generated/**",
            "**/test-results/**",
            "**/coverage/**",
            "**/.wrangler/**",
            "**/*.md/**",
            "**/vitest.config.ts",
            "**/wrangler.jsonc",
            "**/package.json",
            "**/tsconfig*.json",
            "**/README.md",
            "**/eslint.config.js",
        ],
    },
    // Web-platform globals present in the workerd deploy runtime (and modern Node);
    // eslint-plugin-n's Node-version data flags them conservatively.
    {
        rules: {
            "n/no-unsupported-features/node-builtins": ["error", { ignores: ["crypto", "CryptoKey", "SubtleCrypto", "TextEncoder", "Request", "Response"] }],
            // `_id` / `_creationTime` are the public document fields; `__cirrus*` are
            // internal markers. Accidental dangles are still flagged.
            "no-underscore-dangle": [
                "error",
                { allow: ["_id", "_creationTime", "_meta", "__cirrusRef", "__cirrusVisibility", "__cirrusProcedure", "__cirrusCtx", "__cirrusTable"] },
            ],
        },
    },
    // Formatting rules that conflict with Prettier (which owns formatting).
    {
        rules: {
            "antfu/consistent-chaining": "off",
            "antfu/consistent-list-newline": "off",
            "no-confusing-arrow": "off",
            "unicorn/number-literal-case": "off",
        },
    },
    // Behavior-breaking autofixers — kept off (not style).
    {
        rules: {
            "perfectionist/sort-objects": "off",
            "vitest/prefer-expect-type-of": "off",
        },
    },
    // Test files: relax rules that are noisy or inappropriate in test code.
    {
        files: ["**/__tests__/**/*.ts", "**/*.test.ts", "**/*.spec.ts"],
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unnecessary-condition": "off",
            "@typescript-eslint/require-await": "off",
            "e18e/prefer-static-regex": "off",
            "import/no-extraneous-dependencies": "off",
            "n/no-unsupported-features/node-builtins": "off",
            "unicorn/no-null": "off",
            "unicorn/prevent-abbreviations": "off",
            "unused-imports/no-unused-vars": "off",
            "vitest/prefer-expect-assertions": "off",
        },
    },
    // Cirrus function modules (cirrus/*.ts) and the worker entry export *named*
    // queries/mutations/actions + DO/handler bindings by design — codegen and
    // wrangler reference them by name, so a single-export file is still idiomatically
    // a named export.
    {
        files: ["cirrus/**/*.ts", "src/**/*.ts"],
        rules: {
            "import/exports-last": "off",
            "import/prefer-default-export": "off",
        },
    },
    // `null` is the contract for the runtime's `resolveIdentity`, for several
    // untyped `env` / binding values TS sees as non-null, and for query "not
    // found" returns (matching the framework's own example apps).
    {
        files: ["cirrus/**/*.ts", "src/**/*.ts"],
        rules: {
            "@typescript-eslint/no-unnecessary-condition": "off",
            "unicorn/no-null": "off",
        },
    },
    // JSDoc-in-comment false positives: indented prose/list blocks inside doc comments.
    {
        files: ["**/*.ts"],
        rules: {
            "jsdoc/check-indentation": "off",
            "jsdoc/no-undefined-types": "off",
        },
    },
);
