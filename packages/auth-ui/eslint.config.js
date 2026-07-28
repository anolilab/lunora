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
            /*
             * Vue and Svelte only. Their SFCs need `vue-eslint-parser` /
             * `svelte-eslint-parser`, which this repo does not ship — so they
             * are formatted by Prettier and type-checked by `vue-tsc` /
             * `svelte-check`, but genuinely unlinted.
             *
             * Solid and Angular are *not* here: they are plain TS/TSX and were
             * only ever ignored by being lumped in with the SFC dialects. They
             * are linted below, each against the program that actually contains
             * them, with the rules that fight their idioms scoped off.
             */
            "src/vue/**",
            "src/svelte/**",
            "__tests__/vue/**",
            "__tests__/svelte/**",
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
    /*
     * Solid lives in its own TypeScript program (`tsconfig.solid.json`) because
     * a program holds one `jsx`/`jsxImportSource` pair and React's is in the
     * main one. Type-aware rules need to be pointed at it explicitly or every
     * file reports "not found by the project service".
     */
    {
        files: ["src/solid/**/*.{ts,tsx}", "__tests__/solid/**/*.{ts,tsx}"],
        languageOptions: { parserOptions: { project: "./tsconfig.solid.json", tsconfigRootDir: import.meta.dirname } },
        rules: {
            // Solid compiles JSX too, but none of React's hook/component rules apply.
            "react-hooks/exhaustive-deps": "off",
            "react-hooks/rules-of-hooks": "off",
            "react/no-unknown-property": "off",
            "react-perf/jsx-no-new-function-as-prop": "off",
            "react-perf/jsx-no-new-object-as-prop": "off",
            /*
             * This one is not merely inapplicable, it is backwards: destructuring
             * a Solid component's props reads them once and severs reactivity.
             * The port deliberately never does it.
             */
            "react/destructuring-assignment": "off",
            // Solid spells it `for`, not `htmlFor`, so the a11y rule can't see the association.
            "jsx-a11y/label-has-associated-control": "off",
            // `solid-js` is a devDependency for the same reason `@angular/core` is.
            "import/no-extraneous-dependencies": "off",
            // Solid's context API is its own; these rules describe React 19's.
            "react-x/no-context-provider": "off",
            "react-x/no-use-context": "off",
            "react/jsx-no-constructed-context-values": "off",
            // Solid has no Fast Refresh component/constant split.
            "react-refresh/only-export-components": "off",
        },
    },
    /*
     * Angular's class-based components conflict with rules written for plain
     * modules — not with the intent behind them. Each is off for a reason, and
     * everything else (unused vars, floating promises, unsafe `any`, import
     * hygiene) still applies, which is the point of linting these at all.
     */
    {
        files: ["src/angular/**/*.ts", "__tests__/angular/**/*.ts"],
        rules: {
            // The ports group related standalone components per file, mirroring
            // the React file they are a port of. Splitting them to satisfy this
            // would make the five ports diverge in shape for no benefit.
            "max-classes-per-file": "off",
            // `@angular/core` is a devDependency on purpose: this package is
            // never installed: the port is copied into a project that has Angular.
            "import/no-extraneous-dependencies": "off",
            // Angular's own convention is `protected` template members and
            // decorator-adjacent ordering; this rule predates both.
            "@typescript-eslint/explicit-member-accessibility": "off",
            "@typescript-eslint/member-ordering": "off",
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
            // Solid's testing-library has no `getByRole` for a detached render,
            // so container queries are the supported way to assert on markup.
            "testing-library/no-container": "off",
            "testing-library/no-node-access": "off",
        },
    },
);
