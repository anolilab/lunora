import { createConfig } from "@anolilab/eslint-config";
import svelteParser from "svelte-eslint-parser";
import sveltePlugin from "eslint-plugin-svelte";
import typescriptParser from "@typescript-eslint/parser";
import vueParser from "vue-eslint-parser";
import vuePlugin from "eslint-plugin-vue";

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
             * Nothing framework-shaped is ignored any more. The SFC dialects get
             * their own parser blocks below; Solid and Angular are plain TS/TSX
             * and were only ever ignored by being lumped in with them.
             */
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
            /*
             * `packages/solid` lints its own `.tsx` with none of these overrides,
             * which can look like they are unnecessary here. The difference is
             * that this package really does depend on React — it ships a React
             * port — so the shared config turns the React rule set on for the
             * whole package, including the Solid files beside it.
             *
             * Solid compiles JSX too, but none of React's hook/component rules
             * describe it.
             */
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
    /*
     * The plain TypeScript that lives beside the SFCs (`use-controller.ts`,
     * `provider.ts`, …) is in `tsconfig.vue.json`'s program, not the main one,
     * so type-aware rules have to be pointed at it or every file reports "not
     * found in any of the provided project(s)".
     */
    {
        files: ["src/vue/**/*.{ts,vue}", "__tests__/vue/**/*.{ts,vue}"],
        languageOptions: { parserOptions: { project: "./tsconfig.vue.json", tsconfigRootDir: import.meta.dirname } },
        // `vue` is a devDependency for the same reason `@angular/core` is: this
        // package is never installed — the port is copied into a Vue project.
        rules: { "import/no-extraneous-dependencies": "off" },
    },
    {
        files: ["src/svelte/**/*.{ts,svelte}", "__tests__/svelte/**/*.{ts,svelte}"],
        languageOptions: { parserOptions: { project: "./tsconfig.svelte.json", tsconfigRootDir: import.meta.dirname } },
        // Same as Vue: `svelte` is the consumer's dependency, not ours.
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
     * Vue SFCs. `vue-eslint-parser` owns the file and delegates `<script>` to the
     * TypeScript parser; the base config's rules would otherwise see a template
     * they cannot parse.
     *
     * Type-aware rules are deliberately not enabled here: they need the SFC in a
     * TypeScript program, which only `vue-tsc` provides — and `vue-tsc` already
     * runs in `lint:types`. This block is for the correctness rules a type-aware
     * pass would not catch anyway (unused refs, template mistakes, a11y).
     */
    // The plugin's own flat configs, which carry the `.vue` processor as well as
    // the parser — without the processor `vue/comment-directive` has nothing to
    // pair template comments with and reports every one of them.
    ...vuePlugin.configs["flat/essential"].map((entry) => ({ ...entry, files: ["src/vue/**/*.vue", "__tests__/vue/**/*.vue"] })),
    {
        files: ["src/vue/**/*.vue", "__tests__/vue/**/*.vue"],
        languageOptions: {
            parser: vueParser,
            parserOptions: { ecmaVersion: "latest", parser: typescriptParser, project: null, sourceType: "module" },
        },
        rules: {
            // The ports are one component per file named for the component, so the
            // multi-word rule only ever fires on the filename convention itself.
            "vue/multi-word-component-names": "off",
        },
    },
    /*
     * Svelte components. Same reasoning as Vue: the parser makes the file
     * readable, `svelte-check` keeps owning the types.
     */
    /*
     * `flat/recommended` for Svelte but `flat/essential` for Vue, because the
     * tiers do not mean the same thing. Vue's `recommended` layers 33 formatting
     * rules (`html-indent`, `html-quotes`, `max-attributes-per-line`, …) on top
     * of its correctness set; Svelte's `recommended` is 39 rules that are almost
     * all correctness, with its formatting rules turned off separately by
     * `flat/prettier` below.
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
            /*
             * This rule encodes React's `fireEvent`, which is synchronous. Vue's
             * and Svelte's return a promise that flushes the framework's update
             * queue — awaiting them is required, not redundant, and dropping the
             * `await` would assert against the pre-update DOM.
             */
            "testing-library/no-await-sync-events": "off",
            // A cross-suite teardown hook at the top level is deliberate; the
            // core tests already carry a per-file disable for it.
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
