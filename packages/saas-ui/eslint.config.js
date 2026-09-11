import { createConfig } from "@anolilab/eslint-config";
import typescriptParser from "@typescript-eslint/parser";
import sveltePlugin from "eslint-plugin-svelte";
import svelteParser from "svelte-eslint-parser";

// Self-contained flat config for @lunora/saas-ui — the source-of-truth for the
// copy-in SaaS kit screens. Built on @anolilab/eslint-config; a trimmed sibling
// of packages/auth-ui's, carrying only the two ports this package has. A block
// appears here when its port does; the day the Vue port lands, its block comes
// with it rather than sitting here unused.
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
            // `_id` and `_creationTime` are injected on every row by Lunora —
            // the core reads them, it does not get to rename them.
            "no-underscore-dangle": ["error", { allow: ["_creationTime", "_id"] }],
            // `void expr;` is the intended "explicitly ignore this promise" marker.
            "no-void": ["error", { allowAsStatement: true }],
            "sonarjs/void-use": "off",
        },
    },
    {
        files: ["src/svelte/**/*.{ts,svelte}", "__tests__/svelte/**/*.{ts,svelte}"],
        languageOptions: { parserOptions: { project: "./tsconfig.svelte.json", tsconfigRootDir: import.meta.dirname } },
        // `svelte` is the consumer's dependency, not ours — the port is copied
        // into a Svelte project, never installed from here.
        rules: { "import/no-extraneous-dependencies": "off" },
    },
    {
        // `.svelte` only: the plain `.ts` beside them is in the same program and
        // has neither problem, so widening these would drop real coverage.
        files: ["src/svelte/**/*.svelte"],
        rules: {
            // The svelte parser has no DOM lib, so DOM-only types read as undefined globals.
            "no-undef": "off",
        },
    },
    /*
     * Svelte components. The parser makes the file readable; `svelte-check`
     * keeps owning the types. `flat/recommended` is 39 rules that are almost all
     * correctness — its formatting rules are turned off by the block below.
     */
    ...sveltePlugin.configs["flat/recommended"].map((entry) => ({ ...entry, files: ["src/svelte/**/*.svelte", "__tests__/svelte/**/*.svelte"] })),
    {
        files: ["src/svelte/**/*.svelte", "__tests__/svelte/**/*.svelte"],
        languageOptions: {
            parser: svelteParser,
            parserOptions: { ecmaVersion: "latest", parser: typescriptParser, project: null, sourceType: "module" },
        },
        rules: {
            // Prettier (with prettier-plugin-svelte) owns formatting.
            "svelte/html-quotes": "off",
            "svelte/indent": "off",
            "svelte/max-attributes-per-line": "off",
            "svelte/mustache-spacing": "off",
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
            "react-perf/jsx-no-new-object-as-prop": "off",
            // Its autofix rewrites `toHaveBeenCalled()` → `toHaveBeenCalledWith()` (no
            // args), which inverts the assertion. Asserting "was called" is valid.
            "vitest/prefer-called-with": "off",
            "vitest/prefer-describe-function-title": "off",
            "vitest/prefer-expect-assertions": "off",
            "vitest/require-mock-type-parameters": "off",
            "testing-library/no-container": "off",
            "testing-library/no-node-access": "off",
            /*
             * This rule encodes React's `fireEvent`, which is synchronous.
             * Svelte's returns a promise that flushes the update queue —
             * awaiting it is required, not redundant, and dropping the `await`
             * would assert against the pre-update DOM.
             */
            "testing-library/no-await-sync-events": "off",
            "vitest/require-top-level-describe": "off",
            // Namespace imports are how a test spies on a module's exports.
            "import/no-namespace": "off",
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
