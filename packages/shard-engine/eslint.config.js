import { createConfig } from "@anolilab/eslint-config";

// Self-contained flat config for @lunora/shard-engine. This is production
// runtime code (the host-neutral reactive engine), so it uses the standard
// strict preset. Test files get the usual test relaxations.
export default createConfig(
    {
        typescript: { tsconfigPath: "tsconfig.json" },
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
    {
        rules: {
            // `node:sqlite` is stable on Node ^22.15 || >=24.10 and is the
            // deliberate in-memory engine for the reference host only; any real
            // host adapters must not depend on it.
            "n/no-unsupported-features/node-builtins": [
                "error",
                { ignores: ["crypto", "CryptoKey", "SubtleCrypto", "Storage", "sessionStorage", "localStorage"] },
            ],
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
    {
        rules: {
            "antfu/consistent-chaining": "off",
            "antfu/consistent-list-newline": "off",
            "no-confusing-arrow": "off",
            "unicorn/number-literal-case": "off",
        },
    },
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
    // The engine conformance run registers every `it` dynamically through
    // defineEngineContractSuite's injection; sonarjs cannot see through that and
    // reports the file as empty at position 0:1, which no inline disable reaches.
    // Same exemption, same reason, as @lunora/platform's conformance test.
    {
        files: ["**/__tests__/engine-conformance.test.ts"],
        rules: {
            "sonarjs/no-empty-test-file": "off",
            // Same injection: the suite call at describe-scope IS the hook.
            "vitest/require-hook": "off",
        },
    },
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
    {
        rules: {
            "perfectionist/sort-objects": "off",
            "vitest/prefer-expect-type-of": "off",
        },
    },
);
