import { createConfig } from "@anolilab/eslint-config";

// Self-contained flat config for @lunora/auth-ui — the source-of-truth for the
// copy-in auth screens. Built on @anolilab/eslint-config; mirrors packages/react.
export default createConfig(
    {
        typescript: { tsconfigPath: "tsconfig.json" },
        // Prettier owns formatting; disable @stylistic to avoid the two-formatter ping-pong.
        stylistic: false,
        ignores: [
            "**/dist/**",
            "**/node_modules/**",
            "**/coverage/**",
            "**/*.md/**",
            "**/vitest.config.ts",
            "**/wrangler.jsonc",
            "**/package.json",
            "**/tsconfig*.json",
            "**/README.md",
            "**/prettier.config.js",
            "**/eslint.config.js",
        ],
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
    // Named-only export convention applies package-wide (this rule wants a lone
    // default on single-export files — the opposite of the repo convention).
    {
        rules: {
            "import/prefer-default-export": "off",
            // `void expr;` is the intended "explicitly ignore this promise" marker.
            "no-void": ["error", { allowAsStatement: true }],
            "sonarjs/void-use": "off",
        },
    },
    // Scoped allowances for the copy-in React templates.
    {
        files: ["**/*.tsx", "src/react/**/*.ts"],
        rules: {
            // These components are copied into user projects to be read and edited;
            // inline event handlers are idiomatic and the React Compiler memoizes
            // them at build time, so these perf rules are noise here.
            "react-perf/jsx-no-new-function-as-prop": "off",
            "react-perf/jsx-no-new-object-as-prop": "off",
        },
    },
    // Test files: relax rules that are noisy or inappropriate in test code.
    {
        files: ["**/__tests__/**/*.{ts,tsx}", "**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
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
            "import/no-extraneous-dependencies": "off",
            "unicorn/no-null": "off",
            "unicorn/prevent-abbreviations": "off",
            "unused-imports/no-unused-vars": "off",
            // Loose test mocks + assertion-count/describe-title preferences are noise here.
            "react-perf/jsx-no-new-object-as-prop": "off",
            // Its autofix rewrites `toHaveBeenCalled()` → `toHaveBeenCalledWith()` (no
            // args), which inverts the assertion. Asserting "was called" is valid.
            "vitest/prefer-called-with": "off",
            "vitest/prefer-describe-function-title": "off",
            "vitest/prefer-expect-assertions": "off",
            "vitest/require-mock-type-parameters": "off",
        },
    },
);
